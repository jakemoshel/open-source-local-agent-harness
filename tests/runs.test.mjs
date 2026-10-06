import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { loadModule, deferred, tick } from './load-module.mjs'

process.env.JARVIS_TRANSIENT_RETRY_MS = '10'
process.env.JARVIS_HUNG_GRACE_MS = '50'

async function harness(overrides = {}) {
  const runs = new Map(), approvals = new Map(), events = [], conversations = new Map(), audits = [], allowRules = []
  const bus = new EventEmitter()
  const config = { defaultProvider: 'claude', providers: { claude: {}, codex: {} }, maxConcurrentRuns: 1, maxRunMinutes: 5, failover: true, ...overrides.config }
  const provider = { async *run(opts) { opts.steering.register(async () => {}); yield { type: 'result', text: 'done', isError: false } } }
  const db = {
    getRun: (id) => runs.get(id) ?? null,
    insertRun: (r) => runs.set(r.id, { ...r }),
    updateRun: (id, patch) => { const r = { ...runs.get(id), ...patch }; runs.set(id, r); return r },
    appendEvent: (id, type, data) => events.push({ id, type, data }), forgetSeq() {},
    getConversation: (key) => conversations.get(key),
    listRuns: ({ conversationKey, limit = 100 }) => [...runs.values()].filter((r) => !conversationKey || r.conversationKey === conversationKey).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit),
    upsertConversation: (key, provider, sessionId, cwd, context) => conversations.set(key, { provider, sessionId, cwd, context }),
    insertApproval: (a) => approvals.set(a.id, a),
    setApprovalStatus: (id, status) => { const a = { ...approvals.get(id), status }; approvals.set(id, a); return a },
    getApproval: (id) => approvals.get(id) ?? null,
    audit: (...args) => audits.push(args)
  }
  const mocks = {
    './auth': { assertSubscription: async () => {}, BillingGuardError: class extends Error {} },
    './bus': { bus }, './db': db,
    './config': { cfg: () => config, defaultCwd: () => process.cwd(), DIRECT_OPS: new Set(['memory_backup']), files: { mcp: { value: { mcpServers: {} } }, safeguards: { value: { approvalTimeoutSec: 2 } } } },
    './env': { agentEnv: () => ({}) }, './memory': { buildContext: () => '' }, './context': { memoryHints: () => [] }, './models': { resolveModel: async (_provider, ref) => ref ?? undefined }, './faults': { recordFault: () => null },
    './skills': { skillHints: () => ({ text: '', names: [] }) },
    './skill-usage': { recordSkill() {} },
    './paths': { expandHome: (x) => x, paths: { socket: '/unused' } },
    './providers/claude': { claudeProvider: overrides.claude ?? overrides.provider ?? provider },
    './providers/codex': { codexProvider: overrides.codex ?? overrides.provider ?? provider },
    './ops': { invoke: async () => 'backup complete' }, ...overrides.mocks,
    './safeguards': {
      evaluate: () => ({ action: 'allow', rule: null }),
      allowAlwaysRule: (tool, input) => ({ rule: { tool, match: `re:^${input.command}$`, action: 'allow', whole: true }, label: 'this exact command' }),
      addAllowRule: (rule, before, note) => { allowRules.push({ rule, before, note }); return { id: 'always-1', ...rule, note } },
      ...overrides.mocks?.['./safeguards']
    }
  }
  // Every new turn ends with its send time; tests compare the prompt the user wrote.
  for (const k of ['./providers/claude', './providers/codex']) {
    const [name, real] = Object.entries(mocks[k])[0]
    mocks[k] = { [name]: { ...real, run: (o) => real.run.call(real, Object.assign(o, { sent: /\n\n\(Sent [^)]*\)$/.exec(o.prompt)?.[0], prompt: o.prompt.replace(/\n\n\(Sent [^)]*\)$/, '') })) } }
  }
  const api = await loadModule('src/main/runs.ts', mocks)
  return { ...api, runs, approvals, events, bus, conversations, audits, allowRules }
}
const input = { prompt: 'do work', trigger: 'ui', conversationKey: 'chat' }

test('default meeting digest omits startup memory and connectors; custom digest keeps normal context', async () => {
  const seen = []
  let schedule = { id: 'granola-digest', source: 'default', prompt: 'Call meetings_digest_context for today' }
  const h = await harness({
    provider: { async *run(o) { seen.push(o); yield { type: 'result', text: 'NO_DIGEST', isError: false } } },
    mocks: {
      './memory': { buildContext: () => 'Personal startup memory' },
      './config': { cfg: () => ({ defaultProvider: 'claude', providers: { claude: {}, codex: {} }, maxConcurrentRuns: 1, maxRunMinutes: 5 }), defaultCwd: () => process.cwd(), DIRECT_OPS: new Set(),
        files: { mcp: { value: { mcpServers: { granola: { url: 'https://mcp.granola.ai/mcp' } } } }, safeguards: { value: { approvalTimeoutSec: 2 } }, schedules: { get value() { return { schedules: [schedule] } } } } }
    }
  })
  const first = h.startRun({ prompt: schedule.prompt, trigger: 'schedule', triggerRef: schedule.id })
  await h.waitForRun(first.id)
  assert.match(seen[0].context, /meeting digest/)
  assert.doesNotMatch(seen[0].context, /Personal startup/)
  assert.deepEqual(seen[0].mcpServers, {})
  schedule = { ...schedule, source: 'custom', prompt: 'Use my custom source' }
  const second = h.startRun({ prompt: schedule.prompt, trigger: 'schedule', triggerRef: schedule.id })
  await h.waitForRun(second.id)
  assert.equal(seen[1].context, 'Personal startup memory')
  assert.ok(seen[1].mcpServers.granola)
})

test('direct maintenance can be cancelled without launching a provider', async () => {
  const started = deferred()
  let modelCalls = 0
  const h = await harness({
    provider: { async *run() { modelCalls++; yield { type: 'result', text: 'unexpected', isError: false } } },
    mocks: { './ops': { invoke: async (_op, _args, ctx) => {
      started.resolve()
      await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    } } }
  })
  const run = h.startRun({ prompt: 'backup', trigger: 'schedule', direct: { op: 'memory_backup', args: {} } })
  await tick()
  assert.equal(h.runs.get(run.id).status, 'running', h.runs.get(run.id).error)
  await started.promise
  assert.equal(h.cancelRun(run.id), true)
  assert.equal((await h.waitForRun(run.id)).status, 'cancelled')
  assert.equal(modelCalls, 0)
})

test('unreadable memory degrades to a minimal context instead of failing the run', async () => {
  const contexts = []
  const h = await harness({
    provider: { async *run(o) { contexts.push(o.context); yield { type: 'result', text: 'answered', isError: false } } },
    mocks: { './memory': { buildContext() { throw new Error('unreadable memory') } } }
  })
  const first = h.startRun(input)
  const second = h.startRun(input)
  assert.equal((await h.waitForRun(first.id)).status, 'succeeded')
  assert.equal((await h.waitForRun(second.id)).status, 'succeeded')
  assert.match(contexts[0], /could not load memory/)
  assert.ok(h.events.some((e) => e.type === 'system' && /unreadable memory/.test(e.data.warning ?? '')))
  assert.deepEqual(h.activeRunIds(), [])
})

test('STOP during auth prevents provider launch; queued tasks are also cancelled', async () => {
  const auth = deferred(); let called = false
  const h = await harness({ provider: { async *run() { called = true } }, mocks: { './auth': { assertSubscription: () => auth.promise, BillingGuardError: class extends Error {} } } })
  const a = h.startRun(input), b = h.startRun(input)
  await tick()
  assert.equal(h.activeRunIds().length, 2)
  h.cancelAll(); auth.resolve()
  assert.equal((await h.waitForRun(a.id)).status, 'cancelled')
  assert.equal((await h.waitForRun(b.id)).status, 'cancelled')
  assert.equal(called, false)
})

test('approved approvals are not overwritten by a later abort', async () => {
  const entered = deferred(), done = deferred()
  const h = await harness({
    provider: { async *run(o) { entered.resolve(o); await o.gate('Bash', {}, o.signal); await done.promise; yield { type: 'result', text: '', isError: false } } },
    mocks: { './safeguards': { evaluate: () => ({ action: 'ask', rule: null }) } }
  })
  const r = h.startRun(input); await entered.promise; await tick()
  const a = [...h.approvals.values()][0]
  h.resolveApproval(a.id, true); h.cancelRun(r.id); done.resolve()
  await h.waitForRun(r.id)
  assert.equal(h.approvals.get(a.id).status, 'approved')
})

test('provider ending without a result is a failure', async () => {
  const h = await harness({ provider: { async *run() {} } })
  const r = h.startRun(input)
  assert.match((await h.waitForRun(r.id)).error, /without a result/)
  await assert.rejects(h.waitForRun('missing'), /not found/)
})

test('follow-up during startup steers same run and is recorded once', async () => {
  const ready = deferred(), complete = deferred(), messages = []
  const h = await harness({ provider: { async *run(o) { await ready.promise; o.steering.register(async (text) => { messages.push(text) }); await complete.promise; yield { type: 'result', text: 'steered', isError: false } } } })
  const r = h.startRun(input)
  const follow = h.sendMessage({ ...input, prompt: 'use the new scope' })
  ready.resolve()
  assert.equal((await follow).run.id, r.id)
  assert.equal(h.runs.size, 1)
  assert.equal(messages.length, 1)
  assert.match(messages[0], /^use the new scope\n\n\(Sent .+\)$/)
  assert.equal(h.events.filter((e) => e.type === 'user' && e.data.steering).length, 1)
  complete.resolve(); await h.waitForRun(r.id)
  await assert.rejects(h.steerRun(r.id, 'late'), /not accepting/)
})

test('direct maintenance runs count as active and emit completion', async () => {
  const work = deferred(), finished = []
  const h = await harness({ mocks: { './ops': { invoke: () => work.promise } } })
  h.bus.on('run:finished', (r) => finished.push(r.id))
  const r = h.startRun({ ...input, conversationKey: undefined, direct: { op: 'memory_backup', args: {} } })
  assert.deepEqual(h.activeRunIds(), [r.id])
  work.resolve('ok'); await h.waitForRun(r.id); await tick()
  assert.deepEqual(finished, [r.id])
})

const ok = (text = 'done') => ({ type: 'result', text, isError: false })

test('a stale resumed session is retried once on a fresh session', async () => {
  const seen = []
  const h = await harness({ provider: { async *run(o) {
    seen.push(o.resume)
    if (o.resume) throw new Error('No conversation found with session ID: old')
    yield { type: 'session', sessionId: 'new' }; yield ok('fresh answer')
  } } })
  h.conversations.set('chat', { provider: 'claude', sessionId: 'old', cwd: process.cwd(), context: 'ctx' })
  const r = await h.waitForRun(h.startRun(input).id)
  assert.equal(r.status, 'succeeded')
  assert.equal(r.result, 'fresh answer')
  assert.deepEqual(seen, ['old', null])
  assert.equal(h.conversations.get('chat').sessionId, 'new')
})

test('usage limit fails over to the other subscription and later runs skip the limited one', async () => {
  const calls = []
  const future = Math.floor(Date.now() / 1000) + 3600
  const h = await harness({
    claude: { async *run() { calls.push('claude'); yield { type: 'result', text: '', isError: true, error: `Claude AI usage limit reached|${future}` } } },
    codex: { async *run(o) { calls.push('codex'); assert.equal(o.resume, null); yield ok('codex answer') } }
  })
  const first = await h.waitForRun(h.startRun(input).id)
  assert.equal(first.status, 'succeeded')
  assert.equal(first.provider, 'codex')
  assert.equal(first.result, 'codex answer')
  const second = await h.waitForRun(h.startRun({ ...input, provider: 'claude' }).id)
  assert.equal(second.provider, 'codex')
  assert.deepEqual(calls, ['claude', 'codex', 'codex'])
  assert.ok(h.events.some((e) => e.type === 'system' && e.data.failover))
})

test('logged-out subscription fails over; no failover once tools have run', async () => {
  class BillingGuardError extends Error {}
  const calls = []
  const h = await harness({
    mocks: { './auth': { BillingGuardError, assertSubscription: async (p) => { if (p === 'claude') throw new BillingGuardError('Not logged in') } } },
    codex: { async *run() { calls.push('codex'); yield ok('via codex') } }
  })
  assert.equal((await h.waitForRun(h.startRun(input).id)).result, 'via codex')

  const h2 = await harness({
    claude: { async *run() { yield { type: 'tool_call', id: 't1', name: 'Bash', input: {} }; yield { type: 'result', text: '', isError: true, error: 'usage limit reached' } } },
    codex: { async *run() { calls.push('codex-after-tools'); yield ok() } }
  })
  const r = await h2.waitForRun(h2.startRun(input).id)
  assert.equal(r.status, 'failed')
  assert.ok(!calls.includes('codex-after-tools'))
})

test('failover can be turned off', async () => {
  const calls = []
  const h = await harness({
    config: { failover: false },
    claude: { async *run() { calls.push('claude'); yield { type: 'result', text: '', isError: true, error: 'usage limit reached' } } },
    codex: { async *run() { calls.push('codex'); yield ok() } }
  })
  assert.equal((await h.waitForRun(h.startRun(input).id)).status, 'failed')
  assert.deepEqual(calls, ['claude'])
})

test('a transient error before any tool call is retried once', async () => {
  let n = 0
  const h = await harness({ provider: { async *run() { if (++n === 1) throw new Error('socket hang up'); yield ok('second try') } } })
  const r = await h.waitForRun(h.startRun(input).id)
  assert.equal(r.status, 'succeeded')
  assert.equal(n, 2)

  let m = 0
  const h2 = await harness({ config: { failover: false }, provider: { async *run() { m++; throw new Error('socket hang up') } } })
  assert.equal((await h2.waitForRun(h2.startRun(input).id)).status, 'failed')
  assert.equal(m, 2)
})

test('a provider that ignores cancellation is abandoned and frees its slot', async () => {
  const started = deferred()
  const h = await harness({ provider: { async *run(o) { if (o.prompt === 'hang') { started.resolve(); await new Promise(() => {}) } yield ok('next') } } })
  const stuck = h.startRun({ ...input, prompt: 'hang', conversationKey: 'a' })
  await started.promise
  const next = h.startRun({ ...input, prompt: 'after', conversationKey: 'b' })
  h.cancelRun(stuck.id)
  assert.equal((await h.waitForRun(stuck.id)).status, 'cancelled')
  assert.equal((await h.waitForRun(next.id)).status, 'succeeded')
})

test('a follow-up racing the end of a run starts a new turn instead of being dropped', async () => {
  const hold = deferred(), closed = deferred()
  const h = await harness({ provider: { async *run(o) {
    if (o.prompt === 'do work') { await o.steering.close(); closed.resolve(); await hold.promise }
    yield ok(o.prompt)
  } } })
  const first = h.startRun(input)
  await closed.promise
  const follow = await h.sendMessage({ ...input, prompt: 'one more thing' })
  assert.equal(follow.steered, false)
  assert.notEqual(follow.run.id, first.id)
  hold.resolve()
  assert.equal((await h.waitForRun(follow.run.id)).result, 'one more thing')
})

test('a sub-run waited on by its parent does not deadlock the only slot', async () => {
  const api = {}
  const h = await harness({ provider: { async *run(o) {
    if (o.prompt === 'parent') {
      const child = api.startRun({ prompt: 'child', trigger: 'agent', parentRunId: o.runId })
      const done = await api.waitForRun(child.id)
      yield ok(`parent saw ${done.result}`)
    } else yield ok('child result')
  } } })
  Object.assign(api, h)
  const r = await h.waitForRun(h.startRun({ ...input, prompt: 'parent' }).id)
  assert.equal(r.result, 'parent saw child result')
})

test('nested delegation completes at every permitted depth with one slot', async () => {
  const api = {}
  const h = await harness({ provider: { async *run(o) {
    const depth = Number(o.prompt)
    if (depth === 2) {
      assert.throws(() => api.startRun({ prompt: '3', trigger: 'agent', parentRunId: o.runId }), /at most 3 deep/)
      yield ok('leaf')
    } else {
      const child = api.startRun({ prompt: String(depth + 1), trigger: 'agent', parentRunId: o.runId })
      const done = await api.waitForRun(child.id)
      yield ok(`${depth}:${done.result}`)
    }
  } } })
  Object.assign(api, h)
  const root = h.startRun({ ...input, prompt: '0' })
  try {
    await tick()
    assert.deepEqual([...h.runs.values()].map((r) => r.status), ['succeeded', 'succeeded', 'succeeded'], 'no descendant should queue behind its waiting ancestor')
    assert.equal((await h.waitForRun(root.id)).result, '0:1:leaf')
    assert.deepEqual(h.activeRunIds(), [])
  } finally {
    h.cancelAll()
    await Promise.all([...h.runs.keys()].map((id) => h.waitForRun(id)))
    await tick()
  }
})

for (const maxConcurrentRuns of [1, 2]) test(`nested swarms enforce ${maxConcurrentRuns} slots per depth and release them`, async () => {
  const api = {}, leaves = deferred(), running = [0, 0, 0], peaks = [0, 0, 0]
  const h = await harness({ config: { maxConcurrentRuns }, provider: { async *run(o) {
    const depth = Number(o.prompt)
    running[depth]++
    peaks[depth] = Math.max(peaks[depth], running[depth])
    try {
      if (depth === 2) await leaves.promise
      else {
        const children = Array.from({ length: maxConcurrentRuns + 1 }, () => api.startRun({ prompt: String(depth + 1), trigger: 'agent', parentRunId: o.runId }))
        const done = await Promise.all(children.map((r) => api.waitForRun(r.id)))
        assert.ok(done.every((r) => r.status === 'succeeded'))
      }
      yield ok()
    } finally { running[depth]-- }
  } } })
  Object.assign(api, h)
  const roots = Array.from({ length: maxConcurrentRuns + 1 }, () => h.startRun({ prompt: '0', trigger: 'ui' }))
  try {
    await tick()
    assert.deepEqual(running, [maxConcurrentRuns, maxConcurrentRuns, maxConcurrentRuns], 'each depth has capacity independent of its waiting ancestors')
    leaves.resolve()
    await Promise.all(roots.map((r) => h.waitForRun(r.id)))
    await tick()
    assert.ok([...h.runs.values()].every((r) => r.status === 'succeeded'))
    assert.deepEqual(peaks, [maxConcurrentRuns, maxConcurrentRuns, maxConcurrentRuns])
    assert.deepEqual(h.activeRunIds(), [])
    // A second swarm proves no depth retains a slot after completion.
    const next = h.startRun({ prompt: '0', trigger: 'ui' })
    await tick()
    assert.equal(h.runs.get(next.id).status, 'succeeded')
  } finally {
    leaves.resolve()
    h.cancelAll()
    await Promise.all([...h.runs.keys()].map((id) => h.waitForRun(id)))
    await tick()
  }
})

test('a descendant keeps its admission depth after its root finishes', async () => {
  const api = {}, continueChild = deferred()
  let child
  const h = await harness({ provider: { async *run(o) {
    if (o.prompt === 'root') {
      child = api.startRun({ prompt: 'child', trigger: 'agent', parentRunId: o.runId })
    } else if (o.prompt === 'child') {
      await continueChild.promise
      const leaf = api.startRun({ prompt: 'leaf', trigger: 'agent', parentRunId: o.runId })
      yield ok((await api.waitForRun(leaf.id)).result)
      return
    } else {
      assert.throws(() => api.startRun({ prompt: 'too deep', trigger: 'agent', parentRunId: o.runId }), /at most 3 deep/)
    }
    yield ok(o.prompt)
  } } })
  Object.assign(api, h)
  const root = h.startRun({ prompt: 'root', trigger: 'ui' })
  try {
    assert.equal((await h.waitForRun(root.id)).status, 'succeeded')
    continueChild.resolve()
    await tick()
    assert.equal(h.runs.get(child.id).status, 'succeeded', 'a finished ancestor must not collapse the child and leaf into one pool')
    assert.equal(h.runs.get(child.id).result, 'leaf')
  } finally {
    continueChild.resolve()
    h.cancelAll()
    await Promise.all([...h.runs.keys()].map((id) => h.waitForRun(id)))
    await tick()
  }
})

test('cancelled depth waiters finish promptly without freeing occupied slots', async () => {
  const hold = deferred(), calls = [], finished = []
  const h = await harness({ provider: { async *run(o) { calls.push(o.prompt); await hold.promise; yield ok() } } })
  h.bus.on('run:finished', (r) => finished.push(r.id))
  const root = h.startRun({ prompt: 'root', trigger: 'ui' })
  const child = h.startRun({ prompt: 'child', trigger: 'agent', parentRunId: root.id })
  const leaf = h.startRun({ prompt: 'leaf', trigger: 'agent', parentRunId: child.id })
  const queuedChild = h.startRun({ prompt: 'cancel child', trigger: 'agent', parentRunId: root.id })
  const queuedLeaf = h.startRun({ prompt: 'cancel leaf', trigger: 'agent', parentRunId: child.id })
  try {
    await tick()
    assert.equal(h.cancelRun(queuedChild.id), true)
    assert.equal(h.cancelRun(queuedLeaf.id), true)
    await tick()
    assert.ok(finished.includes(queuedChild.id) && finished.includes(queuedLeaf.id), 'cancelled waiters must exit even while their pool remains occupied')
    const nextChild = h.startRun({ prompt: 'next child', trigger: 'agent', parentRunId: root.id })
    const nextLeaf = h.startRun({ prompt: 'next leaf', trigger: 'agent', parentRunId: child.id })
    await tick()
    assert.equal(h.runs.get(nextChild.id).status, 'queued')
    assert.equal(h.runs.get(nextLeaf.id).status, 'queued')
    hold.resolve()
    await Promise.all([...h.runs.keys()].map((id) => h.waitForRun(id)))
    await tick()
    assert.deepEqual(calls, ['root', 'child', 'leaf', 'next child', 'next leaf'])
    assert.deepEqual(h.activeRunIds(), [])
  } finally {
    hold.resolve()
    h.cancelAll()
    await Promise.all([...h.runs.keys()].map((id) => h.waitForRun(id)))
    await tick()
  }
})

test('released slots are reserved for queued runs before completion listeners start new work', async () => {
  const hold = deferred(), order = []
  const h = await harness({ provider: { async *run(o) { order.push(o.prompt); if (o.prompt === 'first') await hold.promise; yield ok() } } })
  const first = h.startRun({ prompt: 'first', trigger: 'ui' })
  const queued = h.startRun({ prompt: 'queued', trigger: 'ui' })
  let newcomer
  h.bus.on('run:finished', (r) => {
    if (r.id === first.id) newcomer = h.startRun({ prompt: 'new', trigger: 'ui' })
  })
  hold.resolve()
  await h.waitForRun(queued.id)
  await h.waitForRun(newcomer.id)
  assert.deepEqual(order, ['first', 'queued', 'new'])
})

test('a sub-run may not join its parent conversation', async () => {
  const entered = deferred(), release = deferred()
  const h = await harness({ provider: { async *run() { entered.resolve(); await release.promise; yield ok() } } })
  const parent = h.startRun(input)
  await entered.promise
  assert.throws(() => h.startRun({ ...input, parentRunId: parent.id }), /parent's conversation/)
  release.resolve(); await h.waitForRun(parent.id)
})

test('a nested sub-run may not join an outstanding ancestor conversation', async () => {
  const hold = deferred()
  const h = await harness({ provider: { async *run() { await hold.promise; yield ok() } } })
  const root = h.startRun(input)
  const child = h.startRun({ prompt: 'child', trigger: 'agent', parentRunId: root.id })
  try {
    await tick()
    assert.throws(() => h.startRun({ ...input, parentRunId: child.id }), /ancestor.*conversation/)
  } finally {
    hold.resolve()
    h.cancelAll()
    await Promise.all([...h.runs.keys()].map((id) => h.waitForRun(id)))
    await tick()
  }
})

test('background learning runs queue behind user messages', async () => {
  const order = [], gate = deferred()
  const h = await harness({ provider: { async *run(o) { order.push(o.prompt); if (o.prompt === 'first') await gate.promise; yield ok() } } })
  const a = h.startRun({ ...input, prompt: 'first', conversationKey: undefined })
  await tick()
  const bg = h.startRun({ ...input, prompt: 'reflect', conversationKey: undefined, kind: 'reflection' })
  const user = h.startRun({ ...input, prompt: 'user', conversationKey: undefined })
  await tick()
  gate.resolve()
  await Promise.all([a, bg, user].map((r) => h.waitForRun(r.id)))
  assert.deepEqual(order, ['first', 'user', 'reflect'])
})

test('approve and always allow saves a rule above the one that asked; plain approve and deny do not', async () => {
  const calls = []
  const h = await harness({
    provider: { async *run(o) {
      for (const command of ['npm test', 'npm run lint', 'git push']) calls.push(await o.gate('Bash', { command }, o.signal))
      yield { type: 'result', text: '', isError: false }
    } },
    mocks: { './safeguards': { evaluate: () => ({ action: 'ask', rule: { id: 'ask-rule' } }) } }
  })
  const r = h.startRun(input)
  const next = async () => { for (let i = 0; i < 50; i++) { const p = [...h.approvals.values()].find((a) => a.status === 'pending'); if (p) return p; await tick() } throw new Error('no approval') }
  const always = h.resolveApproval((await next()).id, true, true, 'iMessage')
  assert.equal(always.allowedAlways, 'this exact command')
  assert.deepEqual(h.allowRules[0].rule, { tool: 'Bash', match: 're:^npm test$', action: 'allow', whole: true })
  assert.equal(h.allowRules[0].before, 'ask-rule')
  assert.match(h.allowRules[0].note, /iMessage/)
  assert.equal(h.audits.length, 1)
  assert.equal(h.resolveApproval((await next()).id, true).allowedAlways, undefined)
  h.resolveApproval((await next()).id, false, true)
  await h.waitForRun(r.id)
  assert.deepEqual(calls.map((c) => c.allow), [true, true, false])
  assert.equal(h.allowRules.length, 1, 'deny never saves a rule, even with always')
})

test('provider fallback drops the original model and effort and starts a fresh conversation', async () => {
  const h = await harness({
    claude: { async *run(o) { assert.equal(o.effort, 'max'); yield { type: 'result', text: '', isError: true, error: 'error_during_execution: rate_limit' } } },
    codex: { async *run(o) {
      assert.equal(o.model, undefined)
      assert.equal(o.effort, undefined)
      assert.equal(o.resume, null)
      yield ok('recovered')
    } }
  })
  assert.equal((await h.waitForRun(h.startRun({ ...input, model: 'opus', effort: 'max' }).id)).result, 'recovered')
})


test('persistent transient provider failures switch subscriptions after one retry', async () => {
  let calls = 0
  const h = await harness({
    claude: { async *run() { calls++; throw new Error('API Error: 529 overloaded') } },
    codex: { async *run() { yield ok('fallback answer') } }
  })
  const r = await h.waitForRun(h.startRun(input).id)
  assert.equal(r.result, 'fallback answer')
  assert.equal(r.provider, 'codex')
  assert.equal(calls, 2)
})

test('each new turn carries its send time; follow-ups do not', async () => {
  const seen = []
  const h = await harness({ provider: { async *run(o) { seen.push(o.sent); yield { type: 'result', text: 'ok', isError: false } } } })
  await h.waitForRun(h.startRun(input).id)
  assert.match(seen[0], /^\n\n\(Sent \w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} /)
})

test('a bare greeting is answered instantly without starting a provider', async () => {
  let called = false
  const h = await harness({ provider: { async *run() { called = true } } })
  for (const hello of ['hi', 'Hey', 'yo', 'yoooooo', 'hey!', 'yo jarvis']) {
    const { run, steered } = await h.sendMessage({ ...input, prompt: hello })
    assert.equal(steered, false)
    assert.equal(run.status, 'succeeded')
    assert.equal(run.result, h.GREETING_REPLY)
  }
  for (const task of ['hi can you check my email', 'yo what is on my calendar', 'history']) assert.equal(h.isGreeting(task), false)
  assert.equal(called, false)
  assert.deepEqual(h.activeRunIds(), [])
})

test('skill pointers arrive on resumed tasks and steering without changing frozen session context', async () => {
  const prompts = [], contexts = [], suggested = [], followups = [], ready = deferred(), complete = deferred()
  let turn = 0
  const h = await harness({
    provider: { async *run(o) {
      turn++; prompts.push(o.prompt); contexts.push(o.context)
      o.steering.register(async text => followups.push(text))
      if (turn === 2) { ready.resolve(); await complete.promise }
      yield { type: 'session', sessionId: 'session-one' }
      yield { type: 'result', text: 'done', isError: false }
    } },
    mocks: {
      './memory': { buildContext: () => 'frozen context' },
      './skills': { skillHints: query => ({ text: `\nPointer for ${query}`, names: ['deploy'] }) },
      './skill-usage': { recordSkill: (...args) => suggested.push(args) }
    }
  })
  const first = h.startRun({ ...input, prompt: 'first task' }); await h.waitForRun(first.id)
  const next = h.startRun({ ...input, prompt: 'second task' }); await ready.promise
  await h.steerRun(next.id, 'new staging target')
  complete.resolve(); await h.waitForRun(next.id)
  assert.match(prompts[1], /Pointer for second task/)
  assert.deepEqual(contexts, ['frozen context', 'frozen context'])
  assert.match(followups[0], /Pointer for new staging target/)
  assert.ok(suggested.every(s => s[2] === 'suggested'))
})

test('background review uses minimal context, drops connectors and enforces its tool budget', async () => {
  let context, connectors, denied, exhausted
  const h = await harness({
    provider: { async *run(o) {
      context = o.context; connectors = o.mcpServers
      denied = await o.gate('Bash', { command: 'echo no' }, o.signal)
      for (let i = 0; i < 11; i++) assert.equal((await o.gate('mcp__harness__harness_call', { op: 'skills_get' }, o.signal)).allow, true)
      exhausted = await o.gate('mcp__harness__harness_ops', {}, o.signal)
      assert.equal(o.signal.aborted, true)
      yield { type: 'result', text: '', isError: false }
    } },
    mocks: { './memory': { buildContext: () => { throw Error('must not load personal context') } } }
  })
  const r = h.startRun({ prompt: 'review evidence', trigger: 'agent', kind: 'reflection' })
  await h.waitForRun(r.id)
  assert.match(context, /bounded background/)
  assert.deepEqual(connectors, {})
  assert.equal(denied.allow, false)
  assert.equal(exhausted.allow, false)
})

test('memory reconciliation has no native tools or connectors and only admits memory operations', async () => {
  const decisions = []
  const h = await harness({
    provider: { async *run(o) {
      assert.equal(o.harnessOnly, true)
      assert.deepEqual(o.mcpServers, {})
      for (const [tool, args] of [
        ['mcp__harness__harness_call', { op: 'context_upsert' }],
        ['mcp__harness__harness_call', { op: 'context_commit' }],
        ['Bash', { command: 'echo no' }],
        ['mcp__harness__harness_call', { op: 'gateways_send' }],
        ['mcp__harness__harness_call', { op: 'skills_save' }]
      ]) decisions.push((await o.gate(tool, args, o.signal)).allow)
      yield { type: 'result', text: 'reconciled', isError: false }
    } },
    mocks: { './memory': { buildContext: () => { throw Error('must not load foreground context') } } }
  })
  await h.waitForRun(h.startRun({ prompt: 'reconcile', trigger: 'schedule', kind: 'memory' }).id)
  assert.deepEqual(decisions, [true, true, false, false, false])
})

test('repair runs get native tools, research, subagents and configured connectors without maintenance budgets', async () => {
  const h = await harness({
    provider: { async *run(o) {
      assert.equal(o.harnessOnly, false)
      assert.equal(o.keepWarm, undefined)
      assert.match(o.context, /supplied working directory/)
      assert.ok(o.mcpServers.research)
      for (const [tool, args] of [
        ['Edit', { file_path: `${process.cwd()}/src/main/self-repair.ts` }],
        ['Bash', { command: 'npm install example' }],
        ['WebSearch', { query: 'test framework' }],
        ['Agent', { prompt: 'Investigate performance' }],
        ['mcp__harness__harness_call', { op: 'skills_get' }]
      ]) assert.equal((await o.gate(tool, args, o.signal)).allow, true, tool)
      for (let i = 0; i < 30; i++) assert.equal((await o.gate('Read', { file_path: `${process.cwd()}/README.md` }, o.signal)).allow, true)
      assert.equal(o.signal.aborted, false)
      yield { type: 'result', text: 'repaired', isError: false }
    } },
    mocks: {
      './config': { cfg: () => ({ defaultProvider: 'claude', providers: { claude: {}, codex: {} }, maxConcurrentRuns: 1, maxRunMinutes: 5 }), defaultCwd: () => process.cwd(), DIRECT_OPS: new Set(),
        files: { mcp: { value: { mcpServers: { research: { url: 'https://example.com/mcp', share: false } } } }, safeguards: { value: { approvalTimeoutSec: 2 } } } }
    }
  })
  assert.equal((await h.waitForRun(h.startRun({ prompt: 'repair', trigger: 'agent', kind: 'repair' }).id)).status, 'succeeded')
})

test('a conversation whose context outgrew the threshold writes a handover from the old session, then rotates', async () => {
  const seen = []
  const contexts = []
  const h = await harness({
    config: { memory: { rotateContextTokens: 1000 } },
    mocks: { './memory': { buildContext: (o) => { contexts.push({ scale: o.recapScale, handover: o.handover }); return 'fresh ctx' } } },
    provider: { async *run(o) {
      seen.push(o.resume)
      if (/writing its handover/.test(o.prompt)) {
        assert.equal(o.context, 'old ctx', 'the handover turn keeps the old cached prompt')
        assert.equal(o.harnessOnly, true)
        assert.equal((await o.gate('Bash', {}, new AbortController().signal)).allow, false, 'no tools during the handover')
        yield ok('Anchors: launch plan. Open loops: confirm venue.')
        return
      }
      yield { type: 'session', sessionId: o.resume ?? 'rotated' }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0, contextTokens: 400 } }
      yield ok('answer')
    } }
  })
  h.conversations.set('chat', { provider: 'claude', sessionId: 'big', cwd: process.cwd(), context: 'old ctx' })
  h.runs.set('prev', { id: 'prev', conversationKey: 'chat', createdAt: 1, finishedAt: 2, status: 'succeeded', usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, contextTokens: 5000 } })
  const first = await h.waitForRun(h.startRun(input).id)
  assert.equal(first.status, 'succeeded'); assert.equal(first.result, 'answer')
  // The small follow-up session is resumed normally.
  await h.waitForRun(h.startRun(input).id)
  assert.deepEqual(seen, ['big', null, 'rotated'])
  assert.deepEqual(contexts, [{ scale: 1, handover: 'Anchors: launch plan. Open loops: confirm venue.' }])
  assert.equal(h.conversations.get('chat').sessionId, 'rotated')
  assert.ok(h.events.some((e) => e.type === 'system' && /old session's handover/.test(e.data.recovery ?? '')))
})

test('when the old session cannot write a handover, rotation falls back to a wider raw recap', async () => {
  const contexts = []
  const h = await harness({
    config: { memory: { rotateContextTokens: 1000 } },
    mocks: { './memory': { buildContext: (o) => { contexts.push({ scale: o.recapScale, handover: o.handover }); return 'fresh ctx' } } },
    provider: { async *run(o) {
      if (/writing its handover/.test(o.prompt)) throw new Error('session expired')
      yield { type: 'session', sessionId: 'rotated' }
      yield ok('answer')
    } }
  })
  h.conversations.set('chat', { provider: 'claude', sessionId: 'big', cwd: process.cwd(), context: 'old ctx' })
  h.runs.set('prev', { id: 'prev', conversationKey: 'chat', createdAt: 1, finishedAt: 2, status: 'succeeded', usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, contextTokens: 5000 } })
  assert.equal((await h.waitForRun(h.startRun(input).id)).status, 'succeeded')
  assert.deepEqual(contexts, [{ scale: 3, handover: null }])
  assert.ok(h.events.some((e) => e.type === 'system' && /fresh session with a recap/.test(e.data.recovery ?? '')))
})

test('a task message carries pointers to the memory records it names, never their content', async () => {
  const prompts = []
  const h = await harness({
    mocks: { './context': { memoryHints: (text) => /Sam/.test(text) ? [{ id: 'sam-lee', type: 'person' }] : [] } },
    provider: { async *run(o) { prompts.push(o.prompt); yield ok('done') } }
  })
  await h.waitForRun(h.startRun({ ...input, prompt: 'book lunch with Sam' }).id)
  await h.waitForRun(h.startRun({ ...input, prompt: 'what time is it' }).id)
  assert.match(prompts[0], /\(Memory records this message names: \[\[sam-lee\]\] person\./)
  assert.doesNotMatch(prompts[1], /Memory records/)
})
