import type { RsiAssessment } from '@shared/rsi'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { bus } from './bus'
import { getDb } from './db'
import { OWNER_ID, withProfile } from './profile-context'
import { classifyFailure } from './providers/failures'

/**
 * The fault ledger: every harness failure, deduplicated by fingerprint, so repeated breakage is visible and a
 * code bug can be repaired (see self-repair). Recording never throws: it runs inside crash and error handlers.
 */

export type FaultClass = 'code' | 'env' | 'unknown'
export type FaultStatus = 'open' | 'repairing' | 'shipped' | 'failed' | 'ignored'

export interface Fault {
  fingerprint: string
  source: string
  cls: FaultClass
  name: string
  message: string
  sample: string
  count: number
  windowCount: number
  windowStart: number
  firstSeen: number
  lastSeen: number
  status: FaultStatus
  attempts: number
  nextAttemptAt: number
  repairRunId: string | null
  commit: string | null
  note: string | null
  assessment: RsiAssessment | null
}

export const FAULT_WINDOW_MS = 24 * 3_600_000

const ENV = /ENOSPC|EACCES|EPERM|EBUSY|EMFILE|ENFILE|ENOENT|SQLITE_(BUSY|FULL|IOERR|CANTOPEN|READONLY)|database is locked|disk (i\/o|is full)|timed? ?out|AbortError|aborted|cancell?ed/i
const CODE_NAMES = new Set(['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'AssertionError', 'SqliteError'])
const CODE = /is not a function|cannot (read|set) propert|is not defined|is not iterable|is not a constructor|maximum call stack|unexpected token|no such (table|column)|SQLITE_(CONSTRAINT|ERROR|MISMATCH|RANGE)|invalid array length|undefined is not/i

export function classifyFault(source: string, name: string, message: string): FaultClass {
  if (source === 'reflection') return 'code'
  if (classifyFailure(message) || ENV.test(message)) return 'env'
  if (CODE_NAMES.has(name) || CODE.test(message)) return 'code'
  return 'unknown'
}

/** Strips what varies between occurrences of one bug: ids, numbers, quoted values, home paths, line numbers. */
function normalizeMessage(message: string): string {
  return message
    .replaceAll(homedir(), '~')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/(["'`])(?:(?!\1).){0,200}\1/g, '<str>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

/** Function names of the first frames, without file positions (they change on every build). */
function stackFrames(stack: string): string[] {
  return stack.split('\n')
    .map((l) => /^\s*at (?:async )?([^\s(]+)/.exec(l)?.[1])
    .filter((f): f is string => !!f && !f.startsWith('node:') && !f.includes('node_modules'))
    .slice(0, 3)
}

function faultFingerprint(source: string, name: string, message: string, stack = ''): string {
  return createHash('sha1').update([source, name, normalizeMessage(message), ...stackFrames(stack)].join('\n')).digest('hex').slice(0, 12)
}

function errorParts(error: unknown): { name: string; message: string; stack: string } {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack ?? '' }
  if (error && typeof error === 'object' && 'message' in error) {
    const e = error as { name?: unknown; message?: unknown; stack?: unknown }
    return { name: String(e.name ?? 'Error'), message: String(e.message), stack: String(e.stack ?? '') }
  }
  return { name: 'Error', message: String(error), stack: '' }
}

type FaultRow = {
  fingerprint: string; source: string; cls: FaultClass; name: string; message: string; sample: string
  count: number; window_count: number; window_start: number; first_seen: number; last_seen: number
  status: FaultStatus; attempts: number; next_attempt_at: number; repair_run_id: string | null; commit_sha: string | null; note: string | null; assessment: string | null
}

const toFault = (r: FaultRow): Fault => ({
  fingerprint: r.fingerprint, source: r.source, cls: r.cls, name: r.name, message: r.message, sample: r.sample,
  count: r.count, windowCount: r.window_count, windowStart: r.window_start, firstSeen: r.first_seen, lastSeen: r.last_seen,
  status: r.status, attempts: r.attempts, nextAttemptAt: r.next_attempt_at, repairRunId: r.repair_run_id, commit: r.commit_sha, note: r.note, assessment: r.assessment ? JSON.parse(r.assessment) : null
})

interface FaultInput {
  source: string
  error: unknown
  /** Extra evidence for a repair: the run, op arguments, what the agent was doing. */
  context?: string
  assessment?: RsiAssessment
}

/** Records one occurrence in the owner's database (the harness code is shared by every profile). */
export function recordFault(input: FaultInput, now = Date.now()): Fault | null {
  try {
    const { name, message, stack } = errorParts(input.error)
    const fingerprint = faultFingerprint(input.source, name, message, stack)
    const sample = [stack || `${name}: ${message}`, input.context ? `Context: ${input.context}` : ''].filter(Boolean).join('\n').slice(0, 6000)
    const fault = withProfile(OWNER_ID, () => {
      const row = getDb().prepare(`
        INSERT INTO faults (fingerprint, source, cls, name, message, sample, count, window_count, window_start, first_seen, last_seen, status, attempts, next_attempt_at, assessment)
        VALUES (@fingerprint, @source, @cls, @name, @message, @sample, 1, 1, @now, @now, @now, 'open', 0, 0, @assessment)
        ON CONFLICT(fingerprint) DO UPDATE SET
          count = count + 1,
          window_count = CASE WHEN @now - window_start > @window THEN 1 ELSE window_count + 1 END,
          window_start = CASE WHEN @now - window_start > @window THEN @now ELSE window_start END,
          last_seen = @now, message = @message, sample = @sample, assessment = COALESCE(@assessment, assessment)
        RETURNING *`).get({ fingerprint, source: input.source, cls: classifyFault(input.source, name, message), name, message: message.slice(0, 2000), sample, now, window: FAULT_WINDOW_MS, assessment: input.assessment ? JSON.stringify(input.assessment) : null }) as FaultRow
      return toFault(row)
    })
    bus.emit('fault:recorded', fault)
    return fault
  } catch {
    return null
  }
}

/** Whether a fault has happened often enough to be worth a repair. */
export function faultDue(f: Fault, now = Date.now()): boolean {
  if (f.cls === 'env' || f.status !== 'open' || f.nextAttemptAt > now) return false
  if (f.cls === 'unknown') return f.windowCount >= 3 && now - f.windowStart <= FAULT_WINDOW_MS
  return true
}

export function getFault(fingerprint: string): Fault | null {
  const row = withProfile(OWNER_ID, () => getDb().prepare('SELECT * FROM faults WHERE fingerprint = ?').get(fingerprint)) as FaultRow | undefined
  return row ? toFault(row) : null
}

export function listFaults(opts: { status?: FaultStatus; cls?: FaultClass; limit?: number } = {}): Fault[] {
  const rows = withProfile(OWNER_ID, () => getDb().prepare(`
    SELECT * FROM faults WHERE (@status IS NULL OR status = @status) AND (@cls IS NULL OR cls = @cls)
    ORDER BY last_seen DESC LIMIT @limit`).all({ status: opts.status ?? null, cls: opts.cls ?? null, limit: Math.min(200, opts.limit ?? 50) })) as FaultRow[]
  return rows.map(toFault)
}

export function updateFault(fingerprint: string, patch: Partial<Pick<Fault, 'status' | 'attempts' | 'nextAttemptAt' | 'repairRunId' | 'commit' | 'note' | 'assessment'>>): Fault | null {
  const cols: Record<string, string> = { status: 'status', attempts: 'attempts', nextAttemptAt: 'next_attempt_at', repairRunId: 'repair_run_id', commit: 'commit_sha', note: 'note', assessment: 'assessment' }
  const keys = Object.keys(patch).filter((k) => k in cols && patch[k as keyof typeof patch] !== undefined)
  if (!keys.length) return getFault(fingerprint)
  const row = withProfile(OWNER_ID, () => getDb().prepare(`UPDATE faults SET ${keys.map((k) => `${cols[k]} = @${k}`).join(', ')} WHERE fingerprint = @fingerprint RETURNING *`)
    .get({ ...Object.fromEntries(keys.map((k) => [k, k === 'assessment' && patch.assessment ? JSON.stringify(patch.assessment) : patch[k as keyof typeof patch]])), fingerprint })) as FaultRow | undefined
  if (!row) return null
  const fault = toFault(row)
  bus.emit('fault:updated', fault)
  return fault
}


/** Filter eligibility before ordering/limiting so old due work cannot disappear behind recent noise. */
export function nextDueFault(maxAttempts = 0, now = Date.now()): Fault | null {
  const row = withProfile(OWNER_ID, () => getDb().prepare(`SELECT * FROM faults
    WHERE status = 'open' AND cls != 'env' AND next_attempt_at <= @now
      AND (@attempts = 0 OR attempts < @attempts)
      AND (cls = 'code' OR (window_count >= 3 AND @now - window_start <= @window))
    ORDER BY COALESCE(json_extract(assessment, '$.priority'), 50) + MIN(count, 20) + MIN((@now-first_seen)/3600000, 30) DESC, first_seen ASC
    LIMIT 1`).get({ now, attempts: maxAttempts, window: FAULT_WINDOW_MS })) as FaultRow | undefined
  return row ? toFault(row) : null
}

/** Reset every interrupted job, including those beyond a UI page. */
export function reopenInterruptedFaults(): void {
  withProfile(OWNER_ID, () => getDb().prepare("UPDATE faults SET status = 'open' WHERE status = 'repairing'").run())
}
