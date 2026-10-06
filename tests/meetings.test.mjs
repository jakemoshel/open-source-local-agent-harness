import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadModule } from './load-module.mjs'

test('Granola meetings stay in a dated private archive and preserve supplied text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-meetings-'))
  try {
    const m = await loadModule('src/main/meetings.ts', {
      './config': { cfg: () => ({ timezone: 'America/New_York' }) },
      './memory': { memoriesDir: () => root, writeAtomic: (p, c) => writeFileSync(p, c, { mode: 0o600 }) }
    })
    const input = { id: '../granola-id', title: 'Planning', date: '2026-09-28T01:30:00Z', attendees: ['Ada'], summary: '# Granola notes\nExact wording.\n' }
    const first = m.archiveMeeting(input)
    assert.equal(first.day, '2026-09-27')
    assert.ok(first.path.startsWith(join(root, 'meetings', 'granola', '2026-09-27')))
    assert.equal(first.transcriptStatus, 'unavailable')
    assert.equal(readFileSync(join(first.path, 'summary.md'), 'utf8'), input.summary)
    assert.match(readFileSync(join(first.path, 'metadata.md'), 'utf8'), /source: granola/)
    assert.equal(existsSync(join(first.path, 'metadata.json')), false)
    assert.match(m.readMeeting(input.id).transcript, /unavailable/)
    m.archiveMeeting({ ...input, transcript: 'Speaker A: Exact transcript.\n' })
    m.archiveMeeting(input)
    assert.equal(m.readMeeting(input.id).transcript, 'Speaker A: Exact transcript.\n')
    const moved = m.archiveMeeting({ ...input, date: '2026-09-29' })
    assert.equal(moved.day, '2026-09-29')
    assert.equal(existsSync(first.path), false)
    assert.equal(m.readMeeting(input.id).transcript, 'Speaker A: Exact transcript.\n')
    assert.equal(m.listMeetings().length, 1)
    assert.equal(m.searchMeetings('exact transcript')[0].id, input.id)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy Granola metadata migrates to Markdown when a meeting is read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-meetings-'))
  try {
    const m = await loadModule('src/main/meetings.ts', {
      './config': { cfg: () => ({ timezone: 'America/New_York' }) },
      './memory': { memoriesDir: () => root, writeAtomic: (p, c) => writeFileSync(p, c, { mode: 0o600 }) }
    })
    const archived = m.archiveMeeting({ id: 'legacy-id', title: 'Legacy', date: '2026-09-28', summary: 'Original notes' })
    const metadata = {
      id: archived.id, title: archived.title, date: archived.date, day: archived.day,
      attendees: archived.attendees, source: archived.source, archivedAt: archived.archivedAt,
      transcriptStatus: archived.transcriptStatus
    }
    unlinkSync(join(archived.path, 'metadata.md'))
    writeFileSync(join(archived.path, 'metadata.json'), JSON.stringify(metadata))
    assert.equal(m.readMeeting('legacy-id').summary, 'Original notes')
    assert.equal(existsSync(join(archived.path, 'metadata.json')), false)
    assert.ok(existsSync(join(archived.path, 'metadata.md')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('daily digest respects the local day and its serialized budget without reading transcripts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-meeting-digest-'))
  try {
    const m = await loadModule('src/main/meetings.ts', {
      './config': { cfg: () => ({ timezone: 'America/New_York' }) },
      './memory': { memoriesDir: () => root, writeAtomic: (p, c) => writeFileSync(p, c, { mode: 0o600 }) }
    })
    m.archiveMeeting({ id: 'yesterday', title: 'Yesterday', date: '2026-10-01', summary: 'Exclude me' })
    for (let i = 0; i < 10; i++) {
      const record = m.archiveMeeting({ id: `today-${i}`, title: 'Today', date: '2026-10-02', summary: '\n"lots of notes"\n'.repeat(1000) })
      unlinkSync(join(record.path, 'transcript.md')) // The digest must not open it.
    }
    const result = m.meetingDigestContext(Date.parse('2026-10-03T01:00:00Z'), 10000)
    assert.equal(result.day, '2026-10-02')
    assert.ok(result.meetings.length)
    assert.ok(result.meetings.every(record => record.id.startsWith('today-')))
    assert.ok(result.meetings.some(record => record.truncated))
    assert.ok(JSON.stringify(result).length < 11000)
    assert.ok(m.readMeetingNotes('today-0').summary.length > 10000)
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('meeting tool persistence redacts raw content while preserving live data', async () => {
  const { persistedMeetingEvent } = await loadModule('src/main/meeting-privacy.ts')
  const call = { id: 'tool-1', name: 'mcp__harness__harness_call', input: { op: 'meetings_read', args: { id: 'meeting-1' } } }
  const result = { id: 'tool-1', output: 'PRIVATE RAW TRANSCRIPT', isError: false }
  assert.equal(JSON.stringify(persistedMeetingEvent('tool_result', result, call)).includes('PRIVATE RAW TRANSCRIPT'), false)
  assert.equal(result.output, 'PRIVATE RAW TRANSCRIPT')
  assert.match(persistedMeetingEvent('tool_result', result, call).output, /meeting-1/)
  const archive = { input: { op: 'meetings_archive', args: { id: 'x', transcript: 'SECRET', summary: 'NOTES' } } }
  assert.equal(JSON.stringify(persistedMeetingEvent('tool_call', archive)).includes('SECRET'), false)
  assert.equal(persistedMeetingEvent('tool_result', result), result)
})

test('agent meeting reads stay bounded and page one file at a time', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-meeting-bounded-'))
  try {
    const m = await loadModule('src/main/meetings.ts', {
      './config': { cfg: () => ({ timezone: 'UTC' }) },
      './memory': { memoriesDir: () => root, writeAtomic: (p, c) => writeFileSync(p, c, { mode: 0o600 }) }
    })
    const saved = m.archiveMeeting({ id: 'long', title: 'Long', date: '2026-10-02', summary: 'S'.repeat(9000), transcript: 'T'.repeat(500_000) })
    const view = m.readMeetingBounded('long')
    assert.equal(view.summary.length, 8000); assert.equal(view.summaryNextOffset, 8000); assert.equal(view.summaryChars, 9000)
    assert.equal(view.transcriptBytes, 500_000); assert.equal(view.transcript, undefined); assert.equal(view.path, undefined)
    assert.ok(JSON.stringify(view).length < 9000)
    unlinkSync(join(saved.path, 'transcript.md')) // A summary page must not open the transcript.
    assert.deepEqual(m.meetingText('long', 'summary', 8000, 8000), { text: 'S'.repeat(1000), nextOffset: null, totalChars: 9000 })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
