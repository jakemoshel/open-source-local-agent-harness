import test from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './load-module.mjs'

const family = await loadModule('src/shared/model-family.ts')

test('families and versions come from the ids themselves, so new releases and new lines need no code', () => {
  assert.equal(family.modelFamily('claude-opus-5-5'), 'opus')
  assert.equal(family.modelFamily('claude-haiku-4-5-20251001'), 'haiku')
  assert.equal(family.modelFamily('gpt-6.1-sol'), 'sol')
  assert.equal(family.modelFamily('gpt-6-astra'), 'astra')
  assert.equal(family.modelFamily('gpt-7-nova-mini'), 'nova-mini')
  assert.equal(family.modelFamily('opus[1m]'), 'opus[1m]')
  assert.deepEqual(family.modelVersion('gpt-6.1-sol'), [6, 1])
  const newest = (ids) => [...ids].sort((a, b) => family.compareVersions(family.modelVersion(b), family.modelVersion(a)))[0]
  assert.equal(newest(['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.2-sol']), 'gpt-6.2-sol')
  assert.equal(newest(['claude-sonnet-4-5-20250929', 'claude-sonnet-5-5', 'claude-sonnet-6']), 'claude-sonnet-6')
  assert.equal(family.familyRef('claude-sonnet-5-5'), 'sonnet')
  assert.equal(family.familyRef('gpt-6.1-sol'), 'sol')
  assert.equal(family.familyRef('opus'), 'opus')
  assert.equal(family.followsLatest('sol'), true); assert.equal(family.followsLatest('gpt-6.1-sol'), false)
})

async function models(kv = new Map(), lists = {}) {
  let codexList = lists.codex ?? []
  const calls = { codex: 0 }
  const m = await loadModule('src/main/models.ts', {
    '@anthropic-ai/claude-agent-sdk': { query: () => ({ supportedModels: async () => lists.claude ?? [] }) },
    './providers/codex-rpc': { CodexRpc: class {
      async request(method) { if (method === 'model/list') { calls.codex++; return { data: codexList, nextCursor: null } } return {} }
      notify() {} close() {}
    } },
    './auth': { claudeBinary: () => '/bin/claude', codexBinary: () => '/bin/codex' },
    './env': { agentEnv: () => ({}) },
    './profile-context': { profileId: () => 'owner' },
    './db': { kvGet: (k) => kv.get(k), kvSet: (k, v) => kv.set(k, v) }
  })
  return { m, calls, setCodex: (list) => { codexList = list } }
}
const codex = (id, label) => ({ model: id, displayName: label, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] })

test('a model line resolves to its newest release, and moves when a new one ships', async () => {
  const { m, setCodex } = await models(new Map(), { codex: [codex('gpt-6-sol', 'GPT-6 Sol'), codex('gpt-6.1-sol', 'GPT-6.1 Sol'), codex('gpt-6-astra', 'GPT-6 Astra')] })
  const { models: list } = await m.listModels('codex')
  assert.deepEqual(list.slice(0, 2).map((o) => [o.id, o.latest, o.tracksLatest]), [['sol', 'gpt-6.1-sol', true], ['astra', 'gpt-6-astra', true]])
  assert.equal(await m.resolveModel('codex', 'sol'), 'gpt-6.1-sol')
  assert.equal(await m.resolveModel('codex', 'gpt-6-sol'), 'gpt-6-sol', 'an exact id stays pinned')
  assert.equal(await m.resolveModel('codex', undefined), undefined)
  setCodex([codex('gpt-6.1-sol', 'GPT-6.1 Sol'), codex('gpt-6.2-sol', 'GPT-6.2 Sol')])
  await m.listModels('codex', true)
  assert.equal(await m.resolveModel('codex', 'sol'), 'gpt-6.2-sol', 'release day: the same ref now runs the new model')
})

test('Claude aliases already follow releases and pass straight through', async () => {
  const { m } = await models(new Map(), { claude: [{ value: 'opus', displayName: 'Opus', supportedEffortLevels: ['high'] }, { value: 'claude-fable-5-1', displayName: 'Fable 5.1' }] })
  const { models: list } = await m.listModels('claude')
  assert.deepEqual(list.map((o) => [o.id, !!o.tracksLatest]), [['opus', true], ['fable', true], ['claude-fable-5-1', false]])
  assert.equal(await m.resolveModel('claude', 'opus'), 'opus')
  assert.equal(await m.resolveModel('claude', 'fable'), 'claude-fable-5-1')
})

test('resolving uses the last known list without waiting on the CLI, then refreshes it in the background', async () => {
  const kv = new Map([['models:last:codex', { at: 0, models: [{ id: 'sol', latest: 'gpt-6.1-sol', tracksLatest: true, label: '', description: '', efforts: [], defaultEffort: null, recommended: false }] }]])
  const { m, calls } = await models(kv, { codex: [codex('gpt-6.2-sol', 'GPT-6.2 Sol')] })
  assert.equal(await m.resolveModel('codex', 'sol'), 'gpt-6.1-sol', 'answered from the saved list')
  await new Promise((r) => setImmediate(r))
  assert.equal(calls.codex, 1, 'a stale list triggers one background refresh')
  assert.equal(await m.resolveModel('codex', 'sol'), 'gpt-6.2-sol')
  assert.equal(kv.get('models:last:codex').models[0].latest, 'gpt-6.2-sol', 'and is saved for the next start')
})

async function commands(kv = new Map()) {
  const list = { claude: [{ id: 'opus', label: 'Opus', efforts: ['low', 'high', 'max'], tracksLatest: true }, { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'], tracksLatest: true }], codex: [{ id: 'sol', label: 'Sol · latest', latest: 'gpt-6.1-sol', efforts: ['low', 'high'], tracksLatest: true }, { id: 'astra', label: 'Astra · latest', latest: 'gpt-6-astra', efforts: ['low'], tracksLatest: true }, { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: ['low', 'high'] }] }
  return loadModule('src/main/model-commands.ts', {
    './config': { cfg: () => ({ defaultProvider: 'claude', providers: { claude: { model: 'sonnet' }, codex: {} } }) },
    './db': { kvGet: (k) => kv.get(k), kvSet: (k, v) => kv.set(k, v) },
    './models': { listModels: async (p) => ({ models: list[p], live: true }), pickModel: (ref, models) => models.find((m) => m.id === ref)?.latest ?? ref }
  })
}

test('chat model commands parse only in capitals or slash form, with an optional effort', async () => {
  const c = await commands()
  assert.deepEqual(c.parseModelCommand('CLAUDE'), { kind: 'set', provider: 'claude' })
  assert.deepEqual(c.parseModelCommand('CLAUDE OPUS'), { kind: 'set', provider: 'claude', model: 'opus' })
  assert.deepEqual(c.parseModelCommand('CODEX SOL HIGH'), { kind: 'set', provider: 'codex', model: 'sol', effort: 'high' })
  assert.deepEqual(c.parseModelCommand('CODEX HIGH'), { kind: 'set', provider: 'codex', effort: 'high' })
  assert.deepEqual(c.parseModelCommand('/model codex gpt-6.1-sol low'), { kind: 'set', provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' })
  assert.deepEqual(c.parseModelCommand('/claude sonnet'), { kind: 'set', provider: 'claude', model: 'sonnet' })
  for (const [text, kind] of [['MODEL', 'show'], ['/model', 'show'], ['MODELS', 'list'], ['DEFAULT', 'default'], ['/model default', 'default']]) assert.equal(c.parseModelCommand(text)?.kind, kind, text)
  for (const text of ['claude opus', 'Claude is great', 'CLAUDE what do you think', 'CODEX SOL FAST', 'model', 'default']) assert.equal(c.parseModelCommand(text), null, text)
})

test('a switch is saved per chat, follows the line, and validates the model and effort', async () => {
  const kv = new Map()
  const c = await commands(kv)
  const reply = await c.runModelCommand('chat', { kind: 'set', provider: 'codex', model: 'sol', effort: 'high' })
  assert.match(reply, /Codex, Sol, always the newest \(now gpt-6\.1-sol\), high effort/)
  assert.deepEqual(c.chatModel('chat'), { provider: 'codex', model: 'sol', effort: 'high' })
  assert.equal(c.chatModel('other'), null, 'other chats are unaffected')
  assert.match(await c.runModelCommand('chat', { kind: 'set', provider: 'codex', model: 'nova' }), /no "NOVA" models.*SOL, ASTRA/)
  assert.match(await c.runModelCommand('chat', { kind: 'set', provider: 'codex', model: 'astra', effort: 'high' }), /does not support high/)
  assert.deepEqual(c.chatModel('chat'), { provider: 'codex', model: 'sol', effort: 'high' }, 'a refused switch changes nothing')
  assert.match(await c.runModelCommand('chat', { kind: 'set', provider: 'codex', model: 'gpt-6.1-sol' }), /gpt-6\.1-sol \(pinned\)/)
  assert.match(await c.runModelCommand('chat', { kind: 'list' }), /Claude: OPUS, SONNET\nCodex: SOL, ASTRA/)
  assert.match(await c.runModelCommand('chat', { kind: 'default' }), /back to the default \(Claude/)
  assert.equal(c.chatModel('chat'), null)
})

test('a chat switch is applied to that chat\'s next message, and the command itself never reaches a model', async () => {
  const sent = [], replies = []
  let pref = null
  const m = await loadModule('src/main/gateways/commands.ts', {
    '../updater': { applyUpdate() {} },
    '../config': { cfg: () => ({ gateways: { idleResetMinutes: 0 } }) },
    '../db': { listRuns: () => [], getConversation() {}, deleteConversation() {}, kvGet: () => null, kvSet() {} },
    '../context': { markExplicitReset() {} },
    './approvals': { rememberChat() {}, answerApproval() {} },
    '../provider-login': { waitingForClaudeCode: () => false, normalizeLoginCode() {}, cancelLogin() {}, loginInstructions() {}, loginListening() {}, loginResultText() {}, startLogin() {}, submitLoginCode() {} },
    '../model-commands': {
      parseModelCommand: (t) => t === 'CODEX SOL' ? { kind: 'set', provider: 'codex', model: 'sol' } : null,
      runModelCommand: async () => { pref = { provider: 'codex', model: 'sol' }; return 'Switched.' },
      splitModelPrefix: async (t) => t.startsWith('CLAUDE OPUS ') ? { command: { kind: 'set', provider: 'claude', model: 'opus' }, prompt: t.slice(12) } : null,
      applyModelCommand: async () => { pref = { provider: 'claude', model: 'opus' }; return { text: 'Switched to Opus. It applies from your next message.', switched: true } },
      chatModel: () => pref,
      copyChatModel() {}
    },
    '../runs': { cancelRun() {}, sendMessage: async (input) => { sent.push(input); return { run: { id: 'r' }, steered: false } }, waitForRun: async () => ({ status: 'succeeded', result: 'done' }) }
  })
  const inbound = (text) => ({ key: 'imessage:chat', text, trigger: 'imessage', triggerRef: 'g', provider: 'claude', reply: async (t) => replies.push(t) })
  await m.handleInbound(inbound('CODEX SOL'))
  assert.deepEqual(replies, ['Switched.']); assert.equal(sent.length, 0)
  await m.handleInbound(inbound('plan my week'))
  assert.equal(sent[0].provider, 'codex', 'the switch outranks the gateway default'); assert.equal(sent[0].model, 'sol')
  await m.handleInbound(inbound('CLAUDE OPUS do a bug bash'))
  assert.equal(replies.at(-2), 'Switched to Opus. It applies from this message.')
  assert.deepEqual([sent[1].prompt, sent[1].provider, sent[1].model], ['do a bug bash', 'claude', 'opus'], 'a switch in front of a request runs it on the new model')
})

test('a switch can lead a message; only real model lines and efforts are taken from it', async () => {
  const c = await commands()
  assert.deepEqual(await c.splitModelPrefix('CLAUDE OPUS please do a bug bash'), { command: { kind: 'set', provider: 'claude', model: 'opus' }, prompt: 'please do a bug bash' })
  assert.deepEqual(await c.splitModelPrefix('CODEX\n\nplease make me a doc\nwith two lines'), { command: { kind: 'set', provider: 'codex' }, prompt: 'please make me a doc\nwith two lines' })
  assert.deepEqual(await c.splitModelPrefix('CODEX SOL HIGH: fix it'), { command: { kind: 'set', provider: 'codex', model: 'sol', effort: 'high' }, prompt: 'fix it' })
  assert.deepEqual(await c.splitModelPrefix('CLAUDE OK why?'), { command: { kind: 'set', provider: 'claude' }, prompt: 'OK why?' }, 'an unknown capitalized word stays in the message')
  for (const text of ['CLAUDE', 'CLAUDE OPUS', 'Claude is great', 'CLAUDE\'s take?', 'CLAUDECODE rocks']) assert.equal(await c.splitModelPrefix(text), null, text)
})
