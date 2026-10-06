import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { cfg } from './config'
import { memoriesDir, writeAtomic } from './memory'

export interface MeetingInput {
  id: string
  title: string
  date: string
  attendees?: string[]
  summary: string
  transcript?: string | null
}

interface MeetingRecord {
  id: string
  title: string
  date: string
  day: string
  attendees: string[]
  source: 'granola'
  archivedAt: string
  transcriptStatus: 'available' | 'unavailable'
  path: string
}

const meetingsRoot = () => join(memoriesDir(), 'meetings', 'granola')
export const allMeetingsRoot = () => join(memoriesDir(), 'meetings')

function dayFor(date: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Invalid meeting date')
    return date
  }
  const parsed = new Date(date)
  if (!Number.isFinite(parsed.getTime())) throw new Error('Meeting date must be an ISO date or timestamp')
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: cfg().timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(parsed)
  const part = (name: string) => parts.find((p) => p.type === name)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function folder(id: string, day: string): string {
  return join(meetingsRoot(), day, createHash('sha256').update(id).digest('hex').slice(0, 20))
}

/** Unique temp name + fsync: a Slack archive and a Granola sync writing the same meeting must not share `x.tmp`. */
const writePrivate = writeAtomic

/** `day` limits the walk to one dated folder (the daily digest), instead of the whole archive. */
function files(day?: string): string[] {
  const out: string[] = []
  const root = meetingsRoot()
  if (existsSync(root)) {
    for (const dated of day ? [day] : readdirSync(root, { withFileTypes: true }).flatMap(d => d.isDirectory() ? [d.name] : [])) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dated)) continue
      let entries
      try { entries = readdirSync(join(root, dated), { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (entry.isDirectory() && /^[a-f0-9]{20}$/.test(entry.name)) out.push(join(root, dated, entry.name))
      }
    }
  }
  return out
}

/**
 * Every lookup, search and digest walks the whole archive, so parsed metadata is cached per folder. Archive writes
 * replace files by rename, which gives a new inode, so any rewrite is seen even where timestamps are coarse.
 */
const parsed = new Map<string, { stamp: string; value: MeetingRecord | null }>()

function record(path: string): MeetingRecord | null {
  let stamp: string | null = null
  try {
    const st = statSync(join(path, 'metadata.md'))
    stamp = `${st.ino}:${st.mtimeMs}:${st.size}`
  } catch {
    // No Markdown metadata yet (legacy JSON is migrated below): parse without caching.
  }
  const hit = stamp ? parsed.get(path) : undefined
  if (hit && hit.stamp === stamp) return hit.value && { ...hit.value }
  const value = readRecord(path)
  if (stamp) {
    if (parsed.size > 20_000) parsed.clear()
    parsed.set(path, { stamp, value })
  }
  return value && { ...value }
}

function readRecord(path: string): MeetingRecord | null {
  try {
    const markdownPath = join(path, 'metadata.md')
    let meta: Omit<MeetingRecord, 'path'>
    try {
      const markdown = readFileSync(markdownPath, 'utf8')
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
      if (!frontmatter) return null
      meta = parseYaml(frontmatter[1]) as Omit<MeetingRecord, 'path'>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
      const legacyPath = join(path, 'metadata.json')
      meta = JSON.parse(readFileSync(legacyPath, 'utf8')) as Omit<MeetingRecord, 'path'>
      if (meta?.source !== 'granola' || typeof meta.id !== 'string') return null
      writeMetadata(markdownPath, meta)
      unlinkSync(legacyPath)
    }
    return meta?.source === 'granola' && typeof meta.id === 'string' && Array.isArray(meta.attendees) && typeof meta.date === 'string' ? { ...meta, path } : null
  } catch {
    return null
  }
}

function writeMetadata(path: string, metadata: Omit<MeetingRecord, 'path'>): void {
  writePrivate(path, `---\n${stringifyYaml(metadata)}---\n\n# ${metadata.title}\n`)
}

export function listMeetings(limit = 100): MeetingRecord[] {
  return files().flatMap((p) => record(p) ?? []).sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit)
}

/** `known` is a record the caller already listed; it skips rescanning the whole archive. */
export function readMeetingNotes(id: string, known?: MeetingRecord): MeetingRecord & { summary: string } {
  const m = known?.id === id ? known : files().map(record).find((x) => x?.id === id)
  if (!m) throw new Error(`No archived meeting with ID ${id}`)
  return { ...m, summary: readFileSync(join(m.path, 'summary.md'), 'utf8') }
}

export function readMeeting(id: string): MeetingRecord & { summary: string; transcript: string } {
  const m = readMeetingNotes(id)
  return { ...m, transcript: readFileSync(join(m.path, 'transcript.md'), 'utf8') }
}

function findMeeting(id: string): MeetingRecord {
  const m = files().map(record).find((x) => x?.id === id)
  if (!m) throw new Error(`No archived meeting with ID ${id}`)
  return m
}

/** One bounded page of a summary or transcript; reads only that file. */
export function meetingText(id: string, section: 'summary' | 'transcript', offset = 0, maxChars = 8000, known?: MeetingRecord) {
  const m = known ?? findMeeting(id)
  const text = readFileSync(join(m.path, `${section}.md`), 'utf8')
  const end = offset + maxChars
  return { text: text.slice(offset, end), nextOffset: end < text.length ? end : null, totalChars: text.length }
}

/** Agent view: metadata plus the first summary page. Transcripts (up to 2 MB) are paged through meetings_text, never inlined. */
export function readMeetingBounded(id: string, maxChars = 8000) {
  const m = findMeeting(id)
  const summary = meetingText(id, 'summary', 0, maxChars, m)
  let transcriptChars = 0
  try { transcriptChars = statSync(join(m.path, 'transcript.md')).size } catch { /* none archived */ }
  const { path: _path, ...meta } = m
  return {
    ...meta, summary: summary.text, summaryChars: summary.totalChars, summaryNextOffset: summary.nextOffset,
    transcriptBytes: m.transcriptStatus === 'available' ? transcriptChars : 0,
    note: m.transcriptStatus === 'available' ? 'Page the transcript with meetings_text {section:"transcript"} only if the summary does not answer the question.' : 'No transcript was archived for this meeting.'
  }
}

/** Digest never reads transcript files or more than its total note budget. */
export function meetingDigestContext(now = Date.now(), maxChars = 18000) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: cfg().timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const part = (name: string) => parts.find(p => p.type === name)?.value ?? ''
  const day = `${part('year')}-${part('month')}-${part('day')}`
  let remaining = maxChars, noteChars = 0
  const today = files(day).flatMap((p) => record(p) ?? []).filter(m => m.day === day).sort((a, b) => b.date.localeCompare(a.date))
  const meetings = []
  for (const m of today) {
    const meta = { id: m.id, title: m.title, date: m.date, attendees: m.attendees, source: m.source }
    // Leave room for JSON escaping (notably newlines) and metadata, so the
    // harness result wrapper never cuts this response into invalid JSON.
    remaining -= JSON.stringify(meta).length + 80
    if (remaining < 0) break
    const text = readFileSync(join(m.path, 'summary.md'), 'utf8')
    let summary = text.slice(0, Math.max(0, Math.floor(remaining / 2)))
    while (summary && JSON.stringify(summary).length > remaining) summary = summary.slice(0, Math.floor(summary.length / 2))
    remaining -= JSON.stringify(summary).length
    noteChars += summary.length
    meetings.push({ ...meta, summary, truncated: summary.length < text.length })
  }
  return { day, meetings, noteChars, omittedMeetings: today.length - meetings.length }
}

export function searchMeetings(query: string, limit = 30): MeetingRecord[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  return files().flatMap((p) => record(p) ?? []).filter((m) => {
    // Transcripts are large: read one only when metadata and summary leave terms unmatched.
    let missing = terms
    for (const read of [() => [m.title, m.date, ...m.attendees].join('\n'), () => readFileSync(join(m.path, 'summary.md'), 'utf8'), () => readFileSync(join(m.path, 'transcript.md'), 'utf8')]) {
      const text = read().toLowerCase()
      missing = missing.filter((term) => !text.includes(term))
      if (!missing.length) return true
    }
    return false
  }).sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit)
}

/** `previous` (a record, or null for none) is what the caller already knows exists under this ID; it skips rescanning the archive. */
export function archiveMeeting(input: MeetingInput, previous?: MeetingRecord | null): MeetingRecord {
  const id = input.id.trim()
  const title = input.title.trim()
  if (!id || !title || !input.summary.trim()) throw new Error('Meeting ID, title and Granola summary are required')
  if (id.length > 300 || title.length > 500 || input.summary.length > 500_000 || (input.transcript?.length ?? 0) > 2_000_000) throw new Error('Meeting content exceeds archive limits')
  const day = dayFor(input.date)
  const path = folder(id, day)
  let existing = existsSync(path) ? record(path) : null
  if (existing && existing.id !== id) throw new Error('Meeting archive ID collision')
  if (!existing) {
    const moved = previous === undefined ? files().map(record).find((m) => m?.source === 'granola' && m.id === id && m.path !== path) : previous?.source === 'granola' && previous.path !== path ? previous : null
    if (moved && !existsSync(path)) {
      mkdirSync(join(meetingsRoot(), day), { recursive: true, mode: 0o700 })
      renameSync(moved.path, path)
      existing = { ...moved, path }
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const transcript = input.transcript?.trim() ? input.transcript : null
  const hasTranscript = !!transcript || existing?.transcriptStatus === 'available'
  const metadata: Omit<MeetingRecord, 'path'> = {
    id, title, date: input.date, day, attendees: input.attendees ?? [], source: 'granola',
    archivedAt: new Date().toISOString(), transcriptStatus: hasTranscript ? 'available' : 'unavailable'
  }
  writePrivate(join(path, 'summary.md'), input.summary)
  if (transcript) writePrivate(join(path, 'transcript.md'), transcript)
  else if (!hasTranscript) writePrivate(join(path, 'transcript.md'), 'Transcript unavailable through the connected Granola account.\n')
  writeMetadata(join(path, 'metadata.md'), metadata)
  return { ...metadata, path }
}
