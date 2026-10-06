import { profileId } from './profile-context'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { cfg } from './config'
import { getDb, kvGet, kvSet, listRuns } from './db'
import { recordRsiMetric } from './rsi-metrics'
import { expandHome } from './paths'
import { UsageError } from './errors'

interface ContextRecord {
  id: string
  type: string | null
  aliases: string[]
  status: string | null
  updated: string | null
  created: string | null
  expires: string | null
  sources: string[]
  path: string
  root: string
  links: string[]
  body: string
}

/** Navigation files, not records: never search hits or backlinks. */
const NAV = ['index.md', 'SCHEMA.md']
/** One-pagers already injected at session start; pointing at them again would only cost tokens. */
const SNAPSHOTS = ['PROFILE.md', 'NOW.md', 'TASKS.md']
/**
 * Body limits that keep each record about one subject. Retrieval only saves tokens when a hit is small and specific:
 * a broad record costs as much to open as loading memory upfront. Timeline digests summarise many subjects, so they get more room.
 */
export const RECORD_LIMITS: Record<string, number> = { recap: 4000, conversation: 3000 }
export const DEFAULT_RECORD_LIMIT = 1500
export const recordLimit = (type: string | null) => (type && RECORD_LIMITS[type]) || DEFAULT_RECORD_LIMIT
const LINK = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g

function configuredRoots(): string[] {
  const configured = cfg().memory.contextRoots
  return (configured.length ? configured : [join(expandHome(cfg().memory.memoriesDir), 'Context')]).map(expandHome)
}
export function roots(): string[] {
  return configuredRoots().filter((r) => existsSync(r))
}

function walk(dir: string, out: string[], depth = 0): void {
  if (depth > 8) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out, depth + 1)
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p)
  }
}

function stamp(path: string): string {
  try { const s = statSync(path); return `${s.mtimeMs}:${s.ctimeMs}:${s.size}` } catch { return 'missing' }
}
interface ContextCache {
  roots: string; records: ContextRecord[]; files: Map<string, { stamp: string; record: ContextRecord }>; at: number
  db?: ReturnType<typeof getDb>
}
const caches = new Map<string, ContextCache>()
const LIST_TTL = 10_000

function parse(path: string, root: string): ContextRecord {
  const text = readFileSync(path, 'utf8')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  let fm: Record<string, unknown> = {}
  if (m) {
    try {
      fm = (parseYaml(m[1]) as Record<string, unknown>) ?? {}
    } catch {
      fm = {}
    }
  }
  const body = m ? text.slice(m[0].length) : text
  const aliases = Array.isArray(fm.aliases) ? fm.aliases.map(String) : typeof fm.aliases === 'string' ? fm.aliases.split(',').map((s) => s.trim()) : []
  return {
    id: String(fm.id ?? basename(path, '.md')),
    type: fm.type ? String(fm.type) : null,
    aliases,
    status: fm.status ? String(fm.status) : null,
    updated: fm.updated ? String(fm.updated) : null,
    created: fm.created ? String(fm.created) : null,
    expires: fm.expires ? String(fm.expires) : null,
    sources: Array.isArray(fm.sources) ? fm.sources.map(String) : [],
    path,
    root,
    links: [...new Set([...body.matchAll(LINK)].map((x) => x[1].trim()))],
    body
  }
}

export function records(): ContextRecord[] {
  const live = roots()
  const rootKey = JSON.stringify(live)
  const previous = caches.get(profileId())
  const cache = previous?.roots === rootKey ? previous : undefined
  if (cache && Date.now() - cache.at < LIST_TTL) return cache.records
  const files = new Map<string, { stamp: string; record: ContextRecord }>()
  for (const root of live) {
    const paths: string[] = []; walk(root, paths)
    for (const path of paths) {
      const version = stamp(path), old = cache?.files.get(path)
      try { files.set(path, old?.stamp === version ? old : { stamp: version, record: parse(path, root) }) } catch { /* removed during scan */ }
    }
  }
  const next: ContextCache = { roots: rootKey, at: Date.now(), files, records: [...files.values()].map(f => f.record) }
  // Persist the search index, changing only rows whose source changed. Markdown remains the source of truth.
  try {
    const db = getDb()
    if (cache?.db === db && files.size === cache.files.size && [...files].every(([path, f]) => cache.files.get(path) === f)) {
      next.db = db; caches.set(profileId(), next); return next.records
    }
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(path UNINDEXED, id, aliases, body, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS context_stamps(path TEXT PRIMARY KEY, stamp TEXT NOT NULL)`)
    const indexed = new Map((db.prepare('SELECT path, stamp FROM context_stamps').all() as { path: string; stamp: string }[]).map(f => [f.path, f.stamp]))
    db.exec('BEGIN')
    try {
      const remove = db.prepare('DELETE FROM context_fts WHERE path = ?')
      const forget = db.prepare('DELETE FROM context_stamps WHERE path = ?')
      const insert = db.prepare('INSERT INTO context_fts(path, id, aliases, body) VALUES (?, ?, ?, ?)')
      const remember = db.prepare('INSERT OR REPLACE INTO context_stamps(path, stamp) VALUES (?, ?)')
      for (const [path, version] of indexed) if (!files.has(path) || files.get(path)!.stamp !== version) { remove.run(path); forget.run(path) }
      for (const [path, file] of files) if (indexed.get(path) !== file.stamp) {
        const r = file.record
        insert.run(path, `${r.id} ${basename(path, '.md')}`, r.aliases.join(' '), r.status === 'forgotten' ? '' : r.body)
        remember.run(path, file.stamp)
      }
      db.exec('COMMIT'); next.db = db
    } catch (err) { db.exec('ROLLBACK'); throw err }
  } catch { /* memory still works when the database is unavailable */ }
  caches.set(profileId(), next)
  return next.records
}

export function invalidateContext(): void {
  const cache = caches.get(profileId())
  if (cache) cache.at = 0
}
export function effectiveStatus(r: ContextRecord): string {
  return r.expires && Date.parse(r.expires) <= Date.now() && r.status !== 'forgotten' ? 'historical' : r.status || 'current'
}
/** One page of the tree, filtered, so maintenance never has to pull every record into context. */
export function contextList(opts: { type?: string; folder?: string; oversized?: boolean; offset?: number; limit?: number } = {}) {
  const { offset = 0, limit = 50 } = opts
  const folder = opts.folder?.replace(/^\/+|\/+$/g, '')
  const matches = records().filter(r => r.status !== 'forgotten' && !NAV.includes(basename(r.path))
    && (!opts.type || r.type === opts.type)
    && (!folder || relative(r.root, r.path).startsWith(`${folder}/`))
    && (!opts.oversized || r.body.trim().length > recordLimit(r.type)))
    .sort((a, b) => a.path.localeCompare(b.path))
  return {
    roots: roots(), total: matches.length,
    records: matches.slice(offset, offset + limit).map(r => ({ id: r.id, type: r.type, aliases: r.aliases, status: effectiveStatus(r), updated: r.updated, path: relative(r.root, r.path), chars: r.body.trim().length, limit: recordLimit(r.type) })),
    nextOffset: offset + limit < matches.length ? offset + limit : null
  }
}

export function contextSearch(query: string, limit = 12, includeHistorical = false) {
  const q = query.toLowerCase().trim()
  const typed = [...new Set(q.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1))]
  if (!typed.length) return []
  const started = performance.now()
  const all = records()
  // A misspelt name ("Samm", "Jonh") still finds its record: unknown words also try the nearest id/alias words.
  const terms = [...typed, ...typed.flatMap(t => nearNames(t, all))]
  let candidates = all
  const cache = caches.get(profileId())
  if (cache?.db) {
    try {
      const hits = cache.db.prepare('SELECT path FROM context_fts WHERE context_fts MATCH ?').all(terms.map(t => `"${t}"*`).join(' OR ')) as { path: string }[]
      candidates = hits.flatMap(h => cache.files.get(h.path)?.record ?? [])
    } catch { /* index unavailable: score every record */ }
  }
  const scored = candidates.filter(r => !NAV.includes(basename(r.path)) && r.status !== 'forgotten' && (includeHistorical || effectiveStatus(r) !== 'historical')).map((r) => {
    const id = r.id.toLowerCase()
    const file = basename(r.path, '.md').toLowerCase()
    const aliases = r.aliases.map((a) => a.toLowerCase())
    const body = r.body.toLowerCase()
    let score = 0, named = false
    if (id === q || file === q) score += 100
    if (aliases.includes(q)) score += 80
    for (const t of terms) {
      if (id.includes(t) || file.includes(t)) { score += 25; named = true }
      if (aliases.some((a) => a.includes(t))) { score += 20; named = true }
      let hits = 0, from = 0
      while (hits < 10) { const at = body.indexOf(t, from); if (at < 0) break; hits++; from = at + t.length }
      score += hits * 2
    }
    if (effectiveStatus(r) === 'historical') score *= 0.7
    // Centre the excerpt on the first query term the body actually contains, not just the first term typed. Positions come
    // from the original text: lower-casing can change string length (e.g. "İ"), which would shift a lower-cased offset.
    const i = terms.reduce((best, t) => { const at = r.body.search(new RegExp(escapeRegExp(t), 'iu')); return at >= 0 && (best < 0 || at < best) ? at : best }, -1)
    const snippet = i >= 0 ? r.body.slice(Math.max(0, i - 120), i + 220).replace(/\s+/g, ' ').trim() : r.body.slice(0, 200).replace(/\s+/g, ' ').trim()
    return { id: r.id, type: r.type, path: r.path, aliases: r.aliases, status: effectiveStatus(r), updated: r.updated, sources: r.sources, score, named: named || score >= 80, snippet }
  })
  recordRsiMetric('retrieval', { durationMs: performance.now() - started, candidates: candidates.length, records: all.length, succeeded: true })
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The words of every id, filename and alias, built once per tree version. */
const nameWords = new WeakMap<ContextRecord[], Set<string>>()
function namesOf(all: ContextRecord[]): Set<string> {
  let names = nameWords.get(all)
  if (!names) {
    names = new Set(all.flatMap(r => [r.id, basename(r.path, '.md'), ...r.aliases].flatMap(k => k.toLowerCase().split(/[^\p{L}\p{N}]+/u))).filter(w => w.length > 2))
    nameWords.set(all, names)
  }
  return names
}
/** Id/alias words one edit away (two for long words) from a word that names nothing itself. */
function nearNames(term: string, all: ContextRecord[]): string[] {
  if (term.length < 4) return []
  const names = namesOf(all)
  if (names.has(term) || [...names].some(n => n.startsWith(term))) return []
  const max = term.length >= 8 ? 2 : 1
  return [...names].filter(n => Math.abs(n.length - term.length) <= max && editDistance(term, n, max) <= max).slice(0, 3)
}
/** Levenshtein distance, giving up (returning max + 1) as soon as it must exceed max. */
function editDistance(a: string, b: string, max: number): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      best = Math.min(best, row[j])
    }
    if (best > max) return max + 1
    prev = row
  }
  return prev[b.length]
}

/** Lower-case word sequence, with the same plural folding as tool retrieval, padded for whole-phrase matching. */
const phrase = (text: string) => ` ${text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(w => w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w).join(' ')} `
const hintKeys = new WeakMap<ContextRecord, string[]>()
const HINT_TYPES = new Set(['person', 'organization', 'preference', 'decision', 'fact', 'workstream', 'topic'])
/**
 * Records a message names by id or alias ("Sam", "my gf", "takeout"), for a one-line pointer on that message. The agent then
 * knows a relevant record exists without anything being loaded: implicit personalization at a few tokens per message.
 */
export function memoryHints(text: string, limit = 3): { id: string; type: string | null }[] {
  const said = phrase(text)
  if (said.trim().length < 2) return []
  return records().filter(r => r.status !== 'forgotten' && HINT_TYPES.has(r.type ?? '') && effectiveStatus(r) === 'current' && ![...NAV, ...SNAPSHOTS].includes(basename(r.path)))
    .flatMap(r => {
      let keys = hintKeys.get(r)
      if (!keys) { keys = [...new Set([r.id.replace(/[-_]+/g, ' '), ...r.aliases].map(phrase).filter(k => k.trim().length > 2))]; hintKeys.set(r, keys) }
      const matched = keys.filter(k => said.includes(k)).length
      return matched ? [{ r, matched }] : []
    })
    .sort((a, b) => b.matched - a.matched || (b.r.updated ?? '').localeCompare(a.r.updated ?? '') || a.r.id.localeCompare(b.r.id))
    .slice(0, limit).map(({ r }) => ({ id: r.id, type: r.type }))
}

const MAP_ORDER: [string, string][] = [['person', 'people'], ['organization', 'orgs'], ['workstream', 'workstreams'], ['topic', 'topics'], ['preference', 'preferences'], ['decision', 'decisions'], ['fact', 'facts']]
/**
 * An index of what memory holds: current record ids by kind, most recently updated first. Ids only, so the agent knows what it
 * can look up (and that it should) without loading any of it.
 */
export function memoryMap(maxChars: number): string {
  if (maxChars <= 0) return ''
  const live = records().filter(r => r.status !== 'forgotten' && effectiveStatus(r) === 'current' && ![...NAV, ...SNAPSHOTS].includes(basename(r.path)))
  const groups = MAP_ORDER.map(([type, label]) => ({ label, ids: live.filter(r => r.type === type).sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '') || a.id.localeCompare(b.id)).map(r => r.id) })).filter(g => g.ids.length)
  if (!groups.length) return ''
  // Every kind gets an equal share, so a long list of facts cannot crowd out the people.
  const share = Math.max(40, Math.floor(maxChars / groups.length))
  const lines = groups.map(({ label, ids }) => {
    let line = `${label} (${ids.length}):`
    let shown = 0
    for (const id of ids) {
      if (line.length + id.length + 2 > share - 6) break
      line += `${shown ? ',' : ''} ${id}`; shown++
    }
    return shown < ids.length ? `${line}${shown ? ',' : ''} …` : line
  })
  return lines.join('\n').slice(0, maxChars)
}

export function resolveRecord(ref: string, all = records()): ContextRecord | null {
  const q = ref.toLowerCase()
  return (
    all.find((r) => r.id.toLowerCase() === q) ??
    all.find((r) => r.path === ref || r.path.endsWith(`/${ref}`) || r.path.endsWith(`/${ref}.md`)) ??
    all.find((r) => basename(r.path, '.md').toLowerCase() === q) ??
    all.find((r) => r.aliases.some((a) => a.toLowerCase() === q)) ??
    null
  )
}

const MAX_BACKLINKS = 25
/**
 * One record plus its neighbourhood. content is the body only: id, type, status, dates and sources come back as fields,
 * so the frontmatter is never paid for twice. Each neighbour carries its type, so the agent can choose the next hop without opening it.
 */
export function contextRead(ref: string, offset = 0, maxChars = 4000) {
  const all = records()
  const r = resolveRecord(ref, all)
  if (!r) throw new UsageError(`No context record matches "${ref}". Try context_search.`)
  if (r.status === 'forgotten') throw new UsageError('This record was forgotten and is unavailable for retrieval')
  const content = r.body.trim()
  const live = all.filter(x => x.status !== 'forgotten')
  // [[links]] resolve by id, filename or alias, so a backlink may use any of them.
  const keys = new Set([r.id, basename(r.path, '.md'), ...r.aliases].map(k => k.toLowerCase()))
  // index.md links every record; listing it as a backlink everywhere is pure noise.
  const backlinks = live.filter((x) => x !== r && !NAV.includes(basename(x.path)) && x.links.some((l) => keys.has(l.toLowerCase())))
  return {
    id: r.id, type: r.type, path: r.path,
    status: effectiveStatus(r), updated: r.updated, sources: r.sources,
    content: content.slice(offset, offset + maxChars), totalChars: content.length,
    nextOffset: offset + maxChars < content.length ? offset + maxChars : null,
    links: r.links.map((l) => { const x = resolveRecord(l, live); return { id: l, type: x?.type ?? null, path: x?.path ?? null } }),
    backlinks: backlinks.slice(0, MAX_BACKLINKS).map((x) => ({ id: x.id, type: x.type, path: x.path })),
    ...(backlinks.length > MAX_BACKLINKS ? { moreBacklinks: backlinks.length - MAX_BACKLINKS } : {})
  }
}

function fileAge(path: string): string {
  const days = Math.floor((Date.now() - statSync(path).mtimeMs) / 86_400_000)
  return days <= 0 ? 'updated today' : `updated ${days} day${days === 1 ? '' : 's'} ago`
}

export function injectedSnapshot(): { file: string; path: string; chars: number; text: string }[] {
  // The one-pagers live in the first configured root (the one the reconciler writes). When it is missing, a later
  // read-only root must not stand in for it.
  const root = configuredRoots()[0]
  if (!root || !existsSync(root)) return []
  const out: { file: string; path: string; chars: number; text: string }[] = []
  let remaining = cfg().memory.durableMaxChars ?? 3600
  for (const { file, maxChars } of cfg().memory.inject) {
    if (maxChars === 0 || remaining <= 0) continue
    const path = join(root, file)
    if (!existsSync(path)) continue
    let text = parse(path, root).body.trim()
    const budget = Math.min(maxChars, remaining)
    if (text.length > budget) text = `${text.slice(0, Math.max(0, budget - 90))}\n… [excerpt; use context_read for ${file}]`.slice(0, budget)
    remaining -= text.length
    out.push({ file, path, chars: text.length, text: `### ${file} (${fileAge(path)})\n${text}` })
  }
  return out
}

export interface TranscriptCursor { eventId: number; offset: number; throughEventId: number; since: number }
/** Stable event-id window; includes follow-ups on runs that began before the window. */
export function transcriptPage(hours = 26, maxChars = 5000, cursor?: TranscriptCursor, afterEventId?: number) {
  const db = getDb()
  const throughEventId = cursor?.throughEventId ?? (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get() as { id: number }).id
  const since = cursor?.since ?? (afterEventId !== undefined ? 0 : Date.now() - hours * 3_600_000)
  const start = cursor?.eventId ?? ((afterEventId || 0) + 1)
  const rows = db.prepare(`SELECT e.id, e.ts, e.type, e.data, r.id AS run_id, r.conversation_key, r.trigger
    FROM events e JOIN runs r ON r.id = e.run_id
    WHERE e.id >= ? AND e.id <= ? AND e.ts >= ? AND e.type IN ('user','text')
      AND r.trigger IN ('ui','slack','imessage')
    ORDER BY e.id LIMIT 100`).all(start, throughEventId, since) as { id: number; ts: number; type: string; data: string; run_id: string; conversation_key: string | null; trigger: string }[]
  let content = ''
  const sources: string[] = []
  let nextCursor: TranscriptCursor | null = null
  for (const row of rows) {
    // One malformed event row must not make the whole transcript window unreadable for the reconciler.
    let text = ''
    try { text = String(JSON.parse(row.data)?.text ?? '') } catch { text = '[unreadable event]' }
    const offset = row.id === cursor?.eventId ? cursor.offset : 0
    const header = `\n[event:${row.id} | run:${row.run_id} | ${row.trigger} | ${row.conversation_key || row.run_id} | ${new Date(row.ts).toISOString()} | ${row.type === 'user' ? 'User' : 'Assistant'}${offset ? ` | continued at ${offset}` : ''}]\n`
    // Keep complete events together when possible. Split only an event too
    // large for an empty page, so checkpoints have safe whole-message boundaries.
    if (content && content.length + header.length + text.length - offset > maxChars) { nextCursor = { eventId: row.id, offset, throughEventId, since }; break }
    const count = Math.max(1, maxChars - content.length - header.length)
    const excerpt = text.slice(offset, offset + count)
    content += header + excerpt; sources.push(`event:${row.id}`)
    if (offset + excerpt.length < text.length) { nextCursor = { eventId: row.id, offset: offset + excerpt.length, throughEventId, since }; break }
  }
  if (!nextCursor && rows.length === 100) nextCursor = { eventId: rows.at(-1)!.id + 1, offset: 0, throughEventId, since }
  return { content, sources, nextCursor, throughEventId, since, note: 'User statements are evidence. Assistant text is not a user fact. Continue nextCursor until null before checkpointing.' }
}

/**
 * The last turns of the previous session. scale > 1 widens it, for a session rotated mid-task when the old session could not
 * write its own handover. With `handover` (written by that session at compaction: anchors, open loops, exact identifiers,
 * completed work), the summary leads and the raw turns follow.
 */
export function compactionRecap(conversationKey: string | null | undefined, excludeRunId?: string, scale = 1, handover?: string | null): string {
  if (!conversationKey) return ''
  if (kvGet<boolean>(`norecap:${conversationKey}`)) {
    // A one-shot flag left by builds before resetAt; turn it into a boundary so it can't suppress recaps forever.
    kvSet(`norecap:${conversationKey}`, false)
    kvSet(`resetAt:${conversationKey}`, Date.now())
    return ''
  }
  const resetAt = kvGet<number>(`resetAt:${conversationKey}`) ?? 0
  const base = cfg().memory.recap
  const r = { ...base, maxTurns: base.maxTurns * scale, maxChars: base.maxChars * scale }
  if (!r.enabled || r.maxTurns === 0 || r.maxChars === 0) return ''
  // Headroom for the current run and any queued follow-ups, which are filtered out below and must not cost real turns.
  const runs = listRuns({ conversationKey, limit: r.maxTurns + 4 })
    .filter((x) => x.id !== excludeRunId && x.status !== 'queued' && x.createdAt >= resetAt)
    .slice(0, r.maxTurns).reverse()
  if (!runs.length) return ''
  const lines: string[] = []
  for (const run of runs) {
    lines.push(`User: ${run.prompt.replace(/\s+/g, ' ').slice(0, 600 * scale)}`)
    if (run.result) lines.push(`You: ${run.result.replace(/\s+/g, ' ').slice(0, 900 * scale)}`)
  }
  let text = lines.join('\n')
  if (text.length > r.maxChars) text = `…${text.slice(text.length - r.maxChars)}`
  const last = runs[runs.length - 1]
  const mins = Math.round((Date.now() - (last.finishedAt ?? last.createdAt)) / 60_000)
  const more = ' Earlier detail: session_search or runs_list with this conversation.'
  const ago = mins < 90 ? `${mins} minutes` : `${Math.round(mins / 60)} hours`
  if (handover?.trim()) return `## Compaction recap\nThe previous session of this conversation was compacted ${ago} ago. Its own handover, for continuity (not verified facts):${more}\n${handover.trim()}\n\nIts last turns:\n${text}`
  return `## Compaction recap\nThe previous session of this conversation ended ${ago} ago. Its last turns, for continuity (not verified facts):${more}\n${text}`
}

export function markExplicitReset(conversationKey: string): void {
  kvSet(`resetAt:${conversationKey}`, Date.now())
  kvSet(`norecap:${conversationKey}`, false)
}
