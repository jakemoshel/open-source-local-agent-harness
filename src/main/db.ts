import Database from 'better-sqlite3'
import type { Approval, AuditEntry, Run, RunEvent, RunEventType, RunStatus, RunUsage } from '@shared/types'
import { bus } from './bus'
import { paths } from './paths'
import { persistedMeetingEvent } from './meeting-privacy'

const databases = new Map<string, Database.Database>()
/** Runs that were active when the previous process died (restart, update, crash, power loss), per database. */
const interrupted = new Map<string, Run[]>()
export const INTERRUPTED_ERROR = 'Harness restarted while run was active'
const statements = new Map<string, Map<string, Database.Statement>>()

/** Prepared statements are compiled once and reused; every hot path (events, run updates) goes through here. */
function stmt(sql: string): Database.Statement {
  const db = getDb()
  let stmts = statements.get(paths.db)
  if (!stmts) { stmts = new Map(); statements.set(paths.db, stmts) }
  let st = stmts.get(sql)
  if (!st) {
    st = db.prepare(sql)
    if (stmts.size > 200) stmts.clear()
    stmts.set(sql, st)
  }
  return st
}

export function openDb(): Database.Database {
  const existing = databases.get(paths.db)
  if (existing) return existing
  const db = new Database(paths.db)
  db.pragma('journal_mode = WAL')
  // WAL + NORMAL survives power loss without corruption (at worst the last commit is lost) and avoids an fsync per event.
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  db.pragma('cache_size = -8000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      status TEXT NOT NULL,
      trigger TEXT NOT NULL,
      trigger_ref TEXT,
      conversation_key TEXT,
      cwd TEXT NOT NULL,
      prompt TEXT NOT NULL,
      session_id TEXT,
      parent_run_id TEXT,
      result TEXT,
      error TEXT,
      usage TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS runs_conv ON runs(conversation_key, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS runs_trigger_ref ON runs(trigger, trigger_ref) WHERE trigger = 'imported';

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);

    CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(run_id UNINDEXED, role UNINDEXED, ts UNINDEXED, text);

    CREATE TABLE IF NOT EXISTS conversations (
      key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      session_id TEXT,
      cwd TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      input TEXT NOT NULL,
      rule_id TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      before TEXT,
      after TEXT
    );

    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS skill_activity (
      name TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      action TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (name, run_id, action)
    );
    CREATE INDEX IF NOT EXISTS skill_activity_run ON skill_activity(run_id);
    CREATE TABLE IF NOT EXISTS skill_pages (key TEXT PRIMARY KEY, hash TEXT NOT NULL, ts INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS skill_pages_ts ON skill_pages(ts);
    CREATE TABLE IF NOT EXISTS faults (
      fingerprint TEXT PRIMARY KEY, source TEXT NOT NULL, cls TEXT NOT NULL, name TEXT NOT NULL, message TEXT NOT NULL, sample TEXT NOT NULL,
      count INTEGER NOT NULL, window_count INTEGER NOT NULL, window_start INTEGER NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL, repair_run_id TEXT, commit_sha TEXT, note TEXT, assessment TEXT
    );
    CREATE TABLE IF NOT EXISTS rsi_metrics (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, commit_sha TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS rsi_metrics_time ON rsi_metrics(ts);
    CREATE INDEX IF NOT EXISTS faults_seen ON faults(last_seen DESC);
    CREATE INDEX IF NOT EXISTS faults_due ON faults(next_attempt_at) WHERE status = 'open' AND cls != 'env';
  `)
  // Page fingerprints used to live in kv with no timestamp, so they could never be pruned.
  db.prepare("DELETE FROM kv WHERE key >= 'skill-page:' AND key < 'skill-page;'").run()
  const faultCols = (db.prepare('PRAGMA table_info(faults)').all() as { name: string }[]).map(c => c.name)
  if (!faultCols.includes('assessment')) db.exec('ALTER TABLE faults ADD COLUMN assessment TEXT')
  const convCols = (db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]).map((c) => c.name)
  if (!convCols.includes('context')) db.exec('ALTER TABLE conversations ADD COLUMN context TEXT')
  const stale = db.prepare(`UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE status IN ('queued','running','awaiting_approval') RETURNING *`).all(INTERRUPTED_ERROR, Date.now()) as RunRow[]
  interrupted.set(paths.db, stale.map(toRun))
  db.prepare(`UPDATE approvals SET status = 'expired', resolved_at = ? WHERE status = 'pending'`).run(Date.now())
  databases.set(paths.db, db)
  return db
}

/** Hands out this profile's interrupted runs once, for recovery after startup. */
export function takeInterruptedRuns(): Run[] {
  const runs = interrupted.get(paths.db) ?? []
  interrupted.delete(paths.db)
  return runs
}

export function getDb(): Database.Database {
  const db = databases.get(paths.db)
  if (!db) throw new Error(`Database is not open for ${paths.home}`)
  return db
}

type RunRow = {
  id: string
  title: string
  provider: Run['provider']
  model: string | null
  status: RunStatus
  trigger: Run['trigger']
  trigger_ref: string | null
  conversation_key: string | null
  cwd: string
  prompt: string
  session_id: string | null
  parent_run_id: string | null
  result: string | null
  error: string | null
  usage: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

function toRun(r: RunRow): Run {
  return {
    id: r.id,
    title: r.title,
    provider: r.provider,
    model: r.model,
    status: r.status,
    trigger: r.trigger,
    triggerRef: r.trigger_ref,
    conversationKey: r.conversation_key,
    cwd: r.cwd,
    prompt: r.prompt,
    sessionId: r.session_id,
    parentRunId: r.parent_run_id,
    result: r.result,
    error: r.error,
    usage: r.usage ? (JSON.parse(r.usage) as RunUsage) : null,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at
  }
}

export function insertRun(run: Run): void {
  stmt(
    `INSERT INTO runs (id,title,provider,model,status,trigger,trigger_ref,conversation_key,cwd,prompt,session_id,parent_run_id,result,error,usage,created_at,started_at,finished_at)
     VALUES (@id,@title,@provider,@model,@status,@trigger,@triggerRef,@conversationKey,@cwd,@prompt,@sessionId,@parentRunId,@result,@error,@usage,@createdAt,@startedAt,@finishedAt)`
  ).run({ ...run, usage: run.usage ? JSON.stringify(run.usage) : null })
  bus.emit('run:update', run)
}

const runColumns: Record<string, string> = {
  title: 'title',
  provider: 'provider',
  model: 'model',
  status: 'status',
  sessionId: 'session_id',
  result: 'result',
  error: 'error',
  usage: 'usage',
  startedAt: 'started_at',
  finishedAt: 'finished_at'
}

export function updateRun(id: string, patch: Partial<Run>): Run {
  const sets: string[] = []
  const values: Record<string, unknown> = { id }
  for (const [k, v] of Object.entries(patch)) {
    const col = runColumns[k]
    if (!col) continue
    sets.push(`${col} = @${k}`)
    values[k] = k === 'usage' && v ? JSON.stringify(v) : v
  }
  if (sets.length) stmt(`UPDATE runs SET ${sets.join(', ')} WHERE id = @id`).run(values)
  const run = getRun(id)!
  bus.emit('run:update', run)
  return run
}

export function getRun(id: string): Run | null {
  const row = stmt('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined
  return row ? toRun(row) : null
}

export function listRuns(opts: { status?: RunStatus; trigger?: string; conversationKey?: string; parentRunId?: string; limit?: number; before?: number; q?: string }): Run[] {
  const where: string[] = []
  const params: Record<string, unknown> = { limit: opts.limit ?? 100 }
  if (opts.status) (where.push('status = @status'), (params.status = opts.status))
  if (opts.trigger) (where.push('trigger = @trigger'), (params.trigger = opts.trigger))
  if (opts.conversationKey) (where.push('conversation_key = @ck'), (params.ck = opts.conversationKey))
  if (opts.parentRunId) (where.push('parent_run_id = @parent'), (params.parent = opts.parentRunId))
  if (opts.before) (where.push('created_at < @before'), (params.before = opts.before))
  if (opts.q) (where.push('(title LIKE @q OR prompt LIKE @q)'), (params.q = `%${opts.q}%`))
  const sql = `SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT @limit`
  return (stmt(sql).all(params) as RunRow[]).map(toRun)
}

export function listConversations(limit = 100, q?: string): import('@shared/types').ConversationSummary[] {
  const rows = stmt(
      `SELECT r.conversation_key key, MIN(r.created_at) startedAt, MAX(r.created_at) updatedAt, COUNT(*) turns,
        (SELECT title FROM runs f WHERE f.conversation_key = r.conversation_key ORDER BY created_at LIMIT 1) title,
        (SELECT provider FROM runs l WHERE l.conversation_key = r.conversation_key ORDER BY created_at DESC LIMIT 1) provider,
        (SELECT status FROM runs l WHERE l.conversation_key = r.conversation_key ORDER BY created_at DESC LIMIT 1) lastStatus,
        (SELECT trigger FROM runs f WHERE f.conversation_key = r.conversation_key ORDER BY created_at LIMIT 1) source
       FROM runs r WHERE r.conversation_key IS NOT NULL ${q ? 'AND (r.title LIKE @q OR r.prompt LIKE @q)' : ''}
       GROUP BY r.conversation_key ORDER BY updatedAt DESC LIMIT @limit`
    )
    .all({ limit, q: q ? `%${q}%` : undefined }) as import('@shared/types').ConversationSummary[]
  return rows
}

export function runStats(sinceMs: number): { total: number; byStatus: Record<string, number>; byDay: { day: string; count: number; tokens: number }[] } {
  const rows = stmt('SELECT status, COUNT(*) c FROM runs WHERE created_at >= ? GROUP BY status').all(sinceMs) as { status: string; c: number }[]
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.c]))
  const days = stmt(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') day, COUNT(*) count,
        COALESCE(SUM(json_extract(usage,'$.inputTokens') + json_extract(usage,'$.outputTokens')),0) tokens
       FROM runs WHERE created_at >= ? AND trigger != 'imported' GROUP BY day ORDER BY day`
    )
    .all(sinceMs) as { day: string; count: number; tokens: number }[]
  return { total: rows.reduce((a, r) => a + r.c, 0), byStatus, byDay: days }
}

const seqs = new Map<string, number>()
const meetingCalls = new Map<string, Map<string, Record<string, unknown>>>()

export function forgetSeq(runId: string): void {
  seqs.delete(runId)
  meetingCalls.delete(runId)
}

export function appendEvent(runId: string, type: RunEventType, data: Record<string, unknown>, ts = Date.now()): RunEvent {
  let seq = seqs.get(runId)
  if (seq === undefined) {
    const row = stmt('SELECT MAX(seq) m FROM events WHERE run_id = ?').get(runId) as { m: number | null }
    seq = row.m ?? 0
  }
  seq += 1
  seqs.set(runId, seq)
  if (type === 'tool_call' && typeof data.id === 'string') {
    const input = data.input as Record<string, unknown> | undefined
    if (typeof input?.op === 'string' && ['meetings_read', 'meetings_text', 'meetings_archive'].includes(input.op)) {
      if (!meetingCalls.has(runId)) meetingCalls.set(runId, new Map())
      meetingCalls.get(runId)!.set(data.id, data)
    }
  }
  const stored = persistedMeetingEvent(type, data, typeof data.id === 'string' ? meetingCalls.get(runId)?.get(data.id) : undefined)
  if (type === 'tool_result' && typeof data.id === 'string') meetingCalls.get(runId)?.delete(data.id)
  const info = stmt('INSERT INTO events (run_id, seq, ts, type, data) VALUES (?,?,?,?,?)').run(runId, seq, ts, type, JSON.stringify(stored))
  const text = type === 'text' || type === 'user' ? String(data.text ?? '') : ''
  if (text) stmt('INSERT INTO transcript_fts (run_id, role, ts, text) VALUES (?,?,?,?)').run(runId, type === 'user' ? 'user' : 'assistant', ts, text)
  const ev: RunEvent = { id: Number(info.lastInsertRowid), runId, seq, ts, type, data }
  bus.emit('run:event', ev)
  return ev
}

export function listEvents(runId: string, afterSeq = 0): RunEvent[] {
  const rows = stmt('SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq').all(runId, afterSeq) as {
    id: number
    run_id: string
    seq: number
    ts: number
    type: RunEventType
    data: string
  }[]
  return rows.map((r) => ({ id: r.id, runId: r.run_id, seq: r.seq, ts: r.ts, type: r.type, data: JSON.parse(r.data) }))
}

type TranscriptHit = { runId: string; title: string; role: string; ts: number; snippet: string; source: Run['trigger']; triggerRef: string | null; conversationKey: string | null }
/** Best-ranked message per run: one long conversation must not fill every result slot with near-duplicate snippets. */
export function searchTranscripts(query: string, limit = 20): TranscriptHit[] {
  const q = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ')
  if (!q) return []
  const rows = stmt(
      `SELECT f.run_id runId, r.title title, r.trigger source, r.trigger_ref triggerRef, r.conversation_key conversationKey, f.role role, f.ts ts, snippet(transcript_fts, 3, '[', ']', ' … ', 24) snippet
       FROM transcript_fts f JOIN runs r ON r.id = f.run_id
       WHERE transcript_fts MATCH ? ORDER BY rank LIMIT ?`
    )
    .all(q, limit * 5) as TranscriptHit[]
  const seen = new Set<string>()
  return rows.filter((row) => !seen.has(row.runId) && !!seen.add(row.runId)).slice(0, limit)
}

export interface Conversation {
  key: string
  provider: string
  sessionId: string | null
  cwd: string | null
  context: string | null
}

export function getConversation(key: string): Conversation | null {
  const row = stmt('SELECT key, provider, session_id sessionId, cwd, context FROM conversations WHERE key = ?').get(key) as Conversation | undefined
  return row ?? null
}

export function upsertConversation(key: string, provider: string, sessionId: string | null, cwd: string | null, context: string | null): void {
  stmt(
    `INSERT INTO conversations (key, provider, session_id, cwd, context, updated_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET provider = excluded.provider, session_id = excluded.session_id, cwd = excluded.cwd, context = excluded.context, updated_at = excluded.updated_at`
  ).run(key, provider, sessionId, cwd, context, Date.now())
}

/** Seen-page fingerprints only matter while a session is live; old sessions just reload the page once. */
const SKILL_PAGE_TTL_MS = 7 * 86_400_000

export function pruneEvents(retentionDays: number): number {
  stmt('DELETE FROM skill_pages WHERE ts < ?').run(Date.now() - SKILL_PAGE_TTL_MS)
  if (!retentionDays) return 0
  const cutoff = Date.now() - retentionDays * 86_400_000
  stmt('DELETE FROM rsi_metrics WHERE ts < ?').run(cutoff)
  const info = stmt(
      `DELETE FROM events WHERE type IN ('tool_call','tool_result','thinking','system','usage')
       AND run_id IN (SELECT id FROM runs WHERE finished_at IS NOT NULL AND finished_at < ? AND trigger != 'imported')`
    )
    .run(cutoff)
  return info.changes
}

export function deleteConversation(key: string): void {
  stmt('DELETE FROM conversations WHERE key = ?').run(key)
}

type ApprovalRow = { id: string; run_id: string; tool: string; input: string; rule_id: string | null; status: Approval['status']; created_at: number; resolved_at: number | null }

const toApproval = (r: ApprovalRow): Approval => ({
  id: r.id,
  runId: r.run_id,
  tool: r.tool,
  input: JSON.parse(r.input),
  ruleId: r.rule_id,
  status: r.status,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at
})

export function insertApproval(a: Approval): void {
  stmt('INSERT INTO approvals (id, run_id, tool, input, rule_id, status, created_at, resolved_at) VALUES (?,?,?,?,?,?,?,?)').run(
    a.id,
    a.runId,
    a.tool,
    JSON.stringify(a.input),
    a.ruleId,
    a.status,
    a.createdAt,
    a.resolvedAt
  )
  bus.emit('approval:update', a)
}

export function getApproval(id: string): Approval | null {
  const row = stmt('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined
  return row ? toApproval(row) : null
}

export function setApprovalStatus(id: string, status: Approval['status']): Approval | null {
  stmt('UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?').run(status, Date.now(), id)
  const a = getApproval(id)
  if (a) bus.emit('approval:update', a)
  return a
}

export function listApprovals(status?: Approval['status'], limit = 100): Approval[] {
  const rows = (
    status
      ? stmt('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
      : stmt('SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?').all(limit)
  ) as ApprovalRow[]
  return rows.map(toApproval)
}

export function audit(actor: AuditEntry['actor'], kind: string, summary: string, before?: unknown, after?: unknown): void {
  const ts = Date.now()
  const info = stmt('INSERT INTO audit (ts, actor, kind, summary, before, after) VALUES (?,?,?,?,?,?)')
    .run(ts, actor, kind, summary, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after))
  bus.emit('audit:new', { id: Number(info.lastInsertRowid), ts, actor, kind, summary, before, after })
}

export function listAudit(kind?: string, limit = 100): AuditEntry[] {
  const rows = (
    kind
      ? stmt('SELECT * FROM audit WHERE kind = ? ORDER BY id DESC LIMIT ?').all(kind, limit)
      : stmt('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit)
  ) as { id: number; ts: number; actor: AuditEntry['actor']; kind: string; summary: string; before: string | null; after: string | null }[]
  return rows.map((r) => ({ ...r, before: r.before ? JSON.parse(r.before) : null, after: r.after ? JSON.parse(r.after) : null }))
}

export function kvGet<T>(key: string): T | null {
  const row = stmt('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
  return row ? (JSON.parse(row.value) as T) : null
}

export function kvSet(key: string, value: unknown): void {
  stmt('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
}
