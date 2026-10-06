import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { granolaConnection } from './config'
import { kvGet, kvSet } from './db'
import { isOwner, profileId } from './profile-context'
import { archiveMeeting, listMeetings, readMeetingNotes, type MeetingInput } from './meetings'
import { openGranola, type GranolaClient } from './granola-mcp'

type Meeting = Pick<MeetingInput, 'id' | 'title' | 'date' | 'attendees'>
type Obj = Record<string, unknown>
const object = (v: unknown): Obj | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const syncing = new Set<string>()

function granolaPayload(reply: unknown): { text: string; data: unknown } {
  const r = object(reply)
  if (!r) throw new Error('Invalid Granola MCP response')
  const text = Array.isArray(r.content) ? r.content.map(b => object(b)?.type === 'text' ? String(object(b)?.text ?? '') : '').filter(Boolean).join('\n') : ''
  if (r.isError) throw new Error(`Granola: ${text.slice(0, 500) || 'tool failed'}`)
  if (object(r._meta)?.truncated === true || /\[.{0,40}truncated.{0,40}\]|output (?:was |has been )?truncated|exceeds maximum.{0,30}tokens/i.test(text)) throw new Error('Granola source response was truncated; existing archive was preserved')
  if (text.length > 3_000_000) throw new Error('Granola response exceeds the import limit')
  let data = r.structuredContent
  if (!data && text) { try { data = JSON.parse(text) } catch { /* Granola also returns XML-like text. */ } }
  return { text, data }
}

export function granolaList(reply: unknown): { meetings: Meeting[]; cursor?: string } {
  const { text, data } = granolaPayload(reply)
  const obj = object(data)
  const items = Array.isArray(data) ? data : obj?.meetings
  let meetings: Meeting[]
  if (Array.isArray(items)) {
    meetings = items.map(item => {
      const m = object(item)
      if (!m || typeof m.id !== 'string' || typeof m.title !== 'string' || typeof m.date !== 'string') throw new Error('Invalid Granola meeting metadata')
      return { id: m.id, title: m.title, date: m.date, attendees: attendees(m.attendees ?? m.participants) }
    })
  } else {
    meetings = Array.from(text.matchAll(/<meeting\b([^>]*)>([\s\S]*?)<\/meeting>/g), ([, attrs, body]) => {
      const fields = Object.fromEntries(Array.from(attrs.matchAll(/([\w-]+)="([^"]*)"/g), ([, key, value]) => [key, decode(value)]))
      if (!fields.id || !fields.title || !fields.date) throw new Error('Invalid Granola meeting attributes')
      return { id: fields.id, title: fields.title, date: fields.date, attendees: Array.from(body.matchAll(/^\s*([^<>\n]+?)\s*<[^>]+>\s*$/gm), ([, name]) => decode(name.replace(/\(note creator\)/, '').trim())) }
    })
    if (!meetings.length && !/<meetings\b[^>]*>\s*<\/meetings>|no meetings (?:found|available)|0 meetings/i.test(text)) throw new Error('Unrecognized Granola meeting list; archive was not changed')
  }
  const cursor = obj?.next_cursor ?? obj?.nextCursor
  if (obj?.has_more === true && typeof cursor !== 'string') throw new Error('Granola returned more meetings without a pagination cursor')
  return { meetings, ...(typeof cursor === 'string' && cursor ? { cursor } : {}) }
}

function attendees(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap(v => typeof v === 'string' ? [v] : typeof object(v)?.name === 'string' ? [object(v)!.name as string] : []) : []
}

export function granolaNotes(reply: unknown, meeting: Meeting): string {
  const { text, data } = granolaPayload(reply)
  const obj = object(data)
  const items = Array.isArray(data) ? data : Array.isArray(obj?.meetings) ? obj.meetings : obj ? [obj] : []
  if (items.length) {
    const m = items.map(object).find(m => m?.id === meeting.id || m?.meeting_id === meeting.id)
    if (!m) throw new Error('Granola returned notes for a different meeting')
    for (const key of ['enhanced_notes', 'summarized_notes', 'summary', 'notes']) if (typeof m[key] === 'string' && m[key].trim()) return m[key] as string
    throw new Error('Granola returned no summary text for this meeting')
  }
  // Preserve the source response, including private/summarized notes and headings.
  // XML wrappers are source metadata, not generated prose.
  const matches = Array.from(text.matchAll(/<meeting\b([^>]*)>([\s\S]*?)<\/meeting>/g))
  const match = matches.find(m => new RegExp(`\\bid="${meeting.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(m[1]))
  if (!match || !match[2].trim()) throw new Error('Unrecognized Granola notes response; existing notes were preserved')
  return match[0]
}

function transcript(reply: unknown, id: string): string {
  const { text, data } = granolaPayload(reply)
  const obj = object(data)
  if (obj && (obj.id ?? obj.meeting_id) && (obj.id ?? obj.meeting_id) !== id) throw new Error('Granola returned a different meeting transcript')
  if (typeof obj?.transcript === 'string' && obj.transcript.trim()) return obj.transcript
  // An empty structured transcript must not archive its own JSON wrapper as the transcript.
  if ((obj && 'transcript' in obj) || !text.trim() || /^(?:no transcript|transcript (?:is )?(?:unavailable|not available)|upgrade to)/i.test(text.trim())) throw new Error('Transcript unavailable')
  return text
}

/** Sequential imports retain only one meeting's notes/transcript, never a chat history. */
export async function importGranola(client: GranolaClient, signal: AbortSignal, now = Date.now()) {
  const key = 'granola:sync:last-success'
  const last = kvGet<number>(key)
  const start = last ? Math.min(last, now) - 3 * 86400_000 : Date.UTC(2000, 0, 1)
  const range = { time_range: 'custom', custom_start: new Date(start).toISOString().slice(0, 10), custom_end: new Date(now + 86400_000).toISOString().slice(0, 10) }
  const existing = new Map(listMeetings(100_000).filter(m => m.source === 'granola').map(m => [m.id, m]))
  const seen = new Set<string>(), cursors = new Set<string>()
  let cursor: string | undefined
  let imported = 0, unchanged = 0, withTranscript = 0, unavailableTranscripts = 0
  let transcriptAvailable: boolean | undefined
  const call = async (tool: string, args: Obj) => {
    signal.throwIfAborted()
    const result = await client.call(tool, args)
    await delay(650, undefined, { signal }) // Below Granola's documented ~100 requests/minute.
    return result
  }
  do {
    const page = granolaList(await call('list_meetings', { ...range, ...(cursor ? { cursor } : {}) }))
    if (transcriptAvailable === undefined && page.meetings.length) transcriptAvailable = await client.hasTool('get_meeting_transcript')
    for (const meeting of page.meetings) {
      if (seen.has(meeting.id)) continue
      if (seen.size >= 2000) throw new Error('Granola import exceeded its 2000-meeting safety limit; the sync watermark was preserved')
      seen.add(meeting.id)
      const summary = granolaNotes(await call('get_meetings', { meeting_ids: [meeting.id] }), meeting)
      const known = existing.get(meeting.id)
      const old = known ? readMeetingNotes(meeting.id, known) : null
      let raw: string | undefined
      if (transcriptAvailable && old?.transcriptStatus !== 'available') {
        try { raw = transcript(await call('get_meeting_transcript', { meeting_id: meeting.id }), meeting.id) }
        catch (error) {
          if (!/paid plan|upgrade|transcripts? (?:is |are )?(?:unavailable|not available|not found)|no transcript|tool.*not supported/i.test(String(error))) throw error
          unavailableTranscripts++
        }
      }
      if (raw || old?.transcriptStatus === 'available') withTranscript++
      // The archive stores trimmed titles; compare the same way or every sync rewrites the meeting.
      const same = old && old.summary === summary && old.title === meeting.title.trim() && old.date === meeting.date && JSON.stringify(old.attendees) === JSON.stringify(meeting.attendees ?? []) && !raw
      signal.throwIfAborted()
      if (same) unchanged++
      else { archiveMeeting({ ...meeting, summary, transcript: raw }, known ?? null); imported++ }
    }
    cursor = page.cursor
    if (cursor) { if (cursors.has(cursor)) throw new Error('Granola repeated a pagination cursor'); cursors.add(cursor) }
  } while (cursor)
  kvSet(key, now) // A failed/partial import never advances the watermark.
  return { imported, unchanged, withTranscript, unavailableTranscripts, modelTokens: 0 }
}

export async function syncGranola(signal: AbortSignal) {
  if (!isOwner()) throw new Error('Granola connections are only available to the owner')
  const profile = profileId()
  if (syncing.has(profile)) throw new Error('A Granola sync is already in progress')
  syncing.add(profile)
  try {
    const connected = granolaConnection(true)
    if (!connected) throw new Error('Direct Granola sync needs a Granola MCP connection enabled for Claude Code')
    const [name, entry] = connected
    // Avoid carrying a watermark between differently configured servers. Never store credentials.
    const connection = createHash('sha256').update(JSON.stringify({ name, url: entry.url, command: entry.command, args: entry.args })).digest('hex')
    if (kvGet<string>('granola:sync:connection') !== connection) { kvSet('granola:sync:last-success', null); kvSet('granola:sync:connection', connection) }
    const client = await openGranola(name, entry, signal)
    try { return await importGranola(client, signal) } finally { client.close() }
  } finally { syncing.delete(profile) }
}
