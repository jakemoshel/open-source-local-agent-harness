import assert from 'node:assert/strict'
import test from 'node:test'
import { loadModule } from './load-module.mjs'

const response = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })
async function fixture() {
  const saved = new Map(), state = new Map(), calls = [], hints = []
  const mod = await loadModule('src/main/granola-sync.ts', {
    './config': { granolaConnection: () => undefined }, './profile-context': { isOwner: () => true, profileId: () => 'owner' },
    './granola-mcp': { openGranola() {} },
    './db': { kvGet: key => state.get(key) ?? null, kvSet: (key, value) => state.set(key, value) },
    './meetings': {
      listMeetings: () => [...saved.values()], readMeetingNotes: (id, known) => { if (known) hints.push(id); return saved.get(id) },
      archiveMeeting: m => { saved.set(m.id, { ...m, title: m.title.trim(), source: 'granola', transcriptStatus: m.transcript ? 'available' : 'unavailable' }); calls.push(m) }
    },
    'node:timers/promises': { setTimeout: async (_ms, _value, { signal }) => signal.throwIfAborted() }
  })
  return { mod, saved, state, calls, hints }
}

test('Granola imports XML metadata and preserves provided note text', async () => {
  const { mod } = await fixture()
  const list = mod.granolaList(response('<meetings><meeting date="2026-10-02" title="A &amp; B" id="m1">\nOwner <owner@example.com>\n</meeting></meetings>'))
  assert.deepEqual(list.meetings, [{ id: 'm1', title: 'A & B', date: '2026-10-02', attendees: ['Owner'] }])
  const raw = '<meeting id="m1" title="A &amp; B"><summary>## Decisions\nKeep **this** wording.</summary></meeting>'
  assert.equal(mod.granolaNotes(response(raw), list.meetings[0]), raw)
  assert.equal(mod.granolaNotes(response({ meetings: [{ id: 'm1', summary: 'Exact\nnotes\n' }] }), list.meetings[0]), 'Exact\nnotes\n')
  assert.throws(() => mod.granolaList(response('Login required')), /Unrecognized/)
  assert.throws(() => mod.granolaList({ isError: true, content: [{ type: 'text', text: 'unauthorized' }] }), /unauthorized/)
  assert.throws(() => mod.granolaNotes(response({ meetings: [{ id: 'wrong', summary: 'Bad' }] }), list.meetings[0]), /different meeting/)
  assert.deepEqual(mod.granolaList(response('<meetings></meetings>')).meetings, [])
})

test('direct sync refreshes recent edits, paginates, and avoids repeat writes/transcript downloads', async () => {
  const { mod, saved, calls, state } = await fixture()
  const invoked = []
  const meeting = { id: 'm1', title: 'Decision', date: '2026-10-02', attendees: ['Owner'] }
  const client = {
    hasTool: async () => true,
    call: async (tool, args) => {
      invoked.push({ tool, args })
      if (tool === 'list_meetings') return response(args.cursor ? { meetings: [] } : { meetings: [meeting], next_cursor: 'page2' })
      if (tool === 'get_meetings') return response({ meetings: [{ ...meeting, summary: 'Do the thing.\n' }] })
      return response({ meeting_id: meeting.id, transcript: 'Owner: do the thing.\n' })
    }
  }
  const now = Date.parse('2026-10-02T20:00:00Z')
  assert.equal((await mod.importGranola(client, new AbortController().signal, now)).imported, 1)
  assert.equal(saved.get('m1').summary, 'Do the thing.\n')
  assert.equal(calls.length, 1)
  assert.equal(invoked[0].args.custom_start, '2000-01-01')
  invoked.length = 0
  const next = await mod.importGranola(client, new AbortController().signal, now + 86400_000)
  assert.equal(next.modelTokens, 0)
  assert.equal(next.unchanged, 1)
  assert.equal(calls.length, 1)
  assert.equal(invoked[0].args.custom_start, '2026-09-29')
  assert.equal(invoked.filter(c => c.tool === 'get_meeting_transcript').length, 0)
  assert.equal(state.get('granola:sync:last-success'), now + 86400_000)
})

test('failed or cancelled sync preserves its watermark; paid-only transcript absence still archives notes', async () => {
  const { mod, state, calls } = await fixture()
  state.set('granola:sync:last-success', 1000)
  const client = { hasTool: async () => true, call: async tool => {
    if (tool === 'list_meetings') return response({ meetings: [{ id: 'm1', title: 'A', date: '2026-10-02' }] })
    if (tool === 'get_meetings') throw new Error('network disconnected')
  } }
  await assert.rejects(mod.importGranola(client, new AbortController().signal), /network disconnected/)
  assert.equal(state.get('granola:sync:last-success'), 1000)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(mod.importGranola(client, abort.signal), /abort/i)
  assert.equal(calls.length, 0)
  client.call = async tool => {
    if (tool === 'list_meetings') return response({ meetings: [{ id: 'm1', title: 'A', date: '2026-10-02' }] })
    if (tool === 'get_meetings') return response({ meetings: [{ id: 'm1', summary: 'Original notes' }] })
    throw new Error('Upgrade to a paid plan')
  }
  const result = await mod.importGranola(client, new AbortController().signal)
  assert.equal(result.imported, 1)
  assert.equal(result.unavailableTranscripts, 1)
  assert.equal(calls[0].transcript, undefined)
})

test('empty transcripts count as unavailable, and padded titles do not rewrite the archive every sync', async () => {
  const { mod, calls, hints } = await fixture()
  const meetings = [{ id: 'm1', title: '  Standup  ', date: '2026-10-02' }, { id: 'm2', title: 'Retro', date: '2026-10-02' }]
  const client = { hasTool: async () => true, call: async (tool, args) => {
    if (tool === 'list_meetings') return response({ meetings })
    if (tool === 'get_meetings') return response({ meetings: [{ id: args.meeting_ids[0], summary: 'Notes' }] })
    return args.meeting_id === 'm1' ? response('') : response({ meeting_id: 'm2', transcript: '' })
  } }
  const first = await mod.importGranola(client, new AbortController().signal)
  assert.equal(first.imported, 2)
  assert.equal(first.unavailableTranscripts, 2)
  assert.deepEqual(calls.map(c => c.transcript), [undefined, undefined])
  const second = await mod.importGranola(client, new AbortController().signal)
  assert.equal(second.unchanged, 2)
  assert.equal(calls.length, 2)
  assert.deepEqual(hints, ['m1', 'm2'])
})

test('MCP adapter never enqueues a model prompt and always closes its CLI', async () => {
  let options, queued = 0, closed = 0
  const requests = []
  const q = {
    initializationResult: async () => ({}),
    request: async r => { requests.push(r); return { response: response({ meetings: [] }) } },
    mcpServerStatus: async () => [{ name: 'my.granola', status: 'connected', tools: [{ name: 'get_meeting_transcript' }] }],
    close: () => { closed++ }
  }
  class Queue { push() { queued++ } end() {} }
  const mod = await loadModule('src/main/granola-mcp.ts', {
    '@anthropic-ai/claude-agent-sdk': { query: args => { options = args.options; return q } },
    './providers/steering': { AsyncQueue: Queue }, './auth': { claudeBinary: () => '/fake/claude' }, './env': { agentEnv: () => ({}) }
  })
  const client = await mod.openGranola('my.granola', { url: 'https://mcp.granola.ai/mcp' }, new AbortController().signal)
  await client.call('list_meetings', { time_range: 'last_30_days' })
  assert.equal(queued, 0)
  assert.equal(options.persistSession, false)
  assert.deepEqual(Object.keys(options.mcpServers), ['my.granola'])
  assert.equal(options.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false')
  assert.equal(requests[0].tool, 'mcp__my_granola__list_meetings')
  assert.equal(await client.hasTool('get_meeting_transcript'), true)
  await assert.rejects(client.call('delete_meeting', {}), /Unsupported/)
  client.close()
  assert.equal(closed, 1)
})
