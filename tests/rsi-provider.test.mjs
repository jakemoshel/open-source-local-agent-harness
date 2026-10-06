import test from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './load-module.mjs'

test('Codex transports the review schema, reports capacity, and closes after a structured result', async () => {
  const requests = [], processes = []
  class Rpc {
    constructor() { processes.push(this); this.closed = false }
    async request(method, args) {
      requests.push({ method, args })
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'account/rateLimits/read') return { rateLimits: { primary: { usedPercent: 20, resetsAt: 2000000000 } } }
      if (method === 'thread/start') return { thread: { id: 'thread' } }
      if (method === 'turn/start') return { turn: { id: 'turn' } }
      return {}
    }
    notify() {}
    close() { this.closed = true }
    get events() { return (async function* () {
      yield { method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 100, resetsAt: 2000000001 } } } }
      yield { method: 'item/completed', params: { threadId: 'child-thread', item: { type: 'agentMessage', text: 'Ignore child output' } } }
      yield { method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { type: 'agentMessage', text: '{"size":"large","reason":"Cross-component work"}' } } }
      yield { method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } }
    })() }
  }
  const { codexProvider } = await loadModule('src/main/providers/codex.ts', {
    './codex-rpc': { CodexRpc: Rpc }, '../auth': { codexBinary: () => 'codex' }, '../profile-context': { isOwner: () => true },
    '../config': { cfg: () => ({ providers: { codex: {} }, timezone: 'UTC' }), files: { safeguards: { value: { codex: { sandboxMode: 'danger-full-access', networkAccess: true } } } } }
  })
  const outputSchema = { type: 'object', properties: { size: { type: 'string' } }, required: ['size'] }
  const events = await Array.fromAsync(codexProvider.run({ runId: 'r', prompt: 'Review scope', cwd: '/tmp', context: '', env: {}, mcpServers: {}, model: 'gpt-6.1-sol', effort: 'high', outputSchema, signal: new AbortController().signal, steering: { register() {}, async close() {} } }))
  assert.deepEqual(requests.find(r => r.method === 'turn/start').args.outputSchema, outputSchema)
  assert.equal(events.filter(e => e.type === 'system' && e.data.rateLimits).length, 2)
  assert.equal(JSON.parse(events.at(-1).text).size, 'large')
  assert.equal(processes[0].closed, true)
})

function codexHarness(requests, notifications = []) {
  const answers = [], starts = [], diagnostics = []
  class Rpc {
    async request(method, args) {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') { starts.push(args); return { thread: { id: 'thread' } } }
      if (method === 'turn/start') return { turn: { id: 'turn' } }
      return null
    }
    notify() {}
    close() {}
    get events() {
      if (this.stream) return this.stream
      const self = this
      const stream = (async function* () {
        for (const notification of notifications) self.onNotification?.(notification)
        // The real client reports a notification as it is read, before answering any request that follows it.
        self.onNotification?.({ method: 'item/started', params: { threadId: 'child', item: { type: 'fileChange', id: 'edit-1', changes: [{ path: '/repo/a.ts' }, { path: '/repo/secret.env' }] } } })
        self.onNotification?.({ method: 'item/started', params: { threadId: 'thread', item: { type: 'fileChange', id: 'edit-2', changes: [{ path: '/repo/b.ts' }] } } })
        self.onNotification?.({ method: 'item/started', params: { threadId: 'thread', item: { type: 'fileChange', id: 'edit-3', changes: [{ path: 'notes.md', kind: { type: 'update', move_path: '/home/.ssh/authorized_keys' } }] } } })
        for (const [method, params] of requests) answers.push(await self.onRequest(method, params))
        for (const event of diagnostics) yield event
        yield { method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } }
      })()
      stream.push = event => diagnostics.push(event)
      this.stream = stream
      return stream
    }
  }
  return { Rpc, answers, starts }
}

test('Codex without a sandbox asks before commands and edits, answered by the same safeguards gate as Claude Code, failing closed', async () => {
  const gated = []
  const { Rpc, answers, starts } = codexHarness([
    ['item/commandExecution/requestApproval', { command: 'sudo rm -rf /' }],
    ['item/commandExecution/requestApproval', { command: 'ls' }],
    ['item/commandExecution/requestApproval', { command: '' }],
    ['item/commandExecution/requestApproval', { kind: 'writeStdin', command: 'y' }],
    ['item/commandExecution/requestApproval', { command: 'curl x', networkApprovalContext: { host: 'x' } }],
    ['item/fileChange/requestApproval', { itemId: 'edit-1' }],
    ['item/fileChange/requestApproval', { itemId: 'edit-2' }],
    ['item/fileChange/requestApproval', { itemId: 'edit-2', grantRoot: '/' }],
    ['item/fileChange/requestApproval', { itemId: 'unknown' }],
    ['item/fileChange/requestApproval', { itemId: 'edit-3' }],
    ['item/permissions/requestApproval', {}],
    ['item/tool/requestUserInput', {}]
  ])
  const { codexProvider } = await loadModule('src/main/providers/codex.ts', {
    './codex-rpc': { CodexRpc: Rpc }, '../auth': { codexBinary: () => 'codex' }, '../profile-context': { isOwner: () => true },
    '../config': { cfg: () => ({ providers: { codex: {} }, timezone: 'UTC' }), files: { safeguards: { value: { codex: { sandboxMode: 'danger-full-access', networkAccess: true } } } } }
  })
  const gate = async (tool, input) => { gated.push([tool, input.command ?? input.file_path]); return /sudo|secret|\.ssh/.test(input.command ?? input.file_path) ? { allow: false, message: 'no' } : { allow: true } }
  await Array.fromAsync(codexProvider.run({ runId: 'r', prompt: 'x', cwd: '/repo', context: '', env: {}, mcpServers: {}, gate, signal: new AbortController().signal, steering: { register() {}, async close() {} } }))
  assert.equal(starts[0].approvalPolicy, 'untrusted')
  assert.deepEqual(gated, [['Bash', 'sudo rm -rf /'], ['Bash', 'ls'], ['Edit', '/repo/a.ts'], ['Edit', '/repo/secret.env'], ['Edit', '/repo/b.ts'], ['Edit', '/repo/notes.md'], ['Edit', '/home/.ssh/authorized_keys']],
    'child-thread edits are gated too; relative paths are resolved and a move destination is gated')
  assert.deepEqual(answers[10], { permissions: {}, scope: 'turn' })
  assert.deepEqual(answers[11], { answers: {} })
  assert.deepEqual(answers.map(a => a?.decision), ['decline', 'accept', 'decline', 'decline', 'decline', 'decline', 'accept', 'decline', 'decline', 'decline', undefined, undefined],
    'empty commands, terminal input, network escalation, extra write roots, unknown edits and protected move targets are declined')
})

test('in a sandboxed mode Codex never asks, and any approval request is declined so the sandbox stays the boundary', async () => {
  let gateCalls = 0
  const { Rpc, answers, starts } = codexHarness([['item/commandExecution/requestApproval', { command: 'ls' }], ['item/fileChange/requestApproval', { itemId: 'edit-2' }], ['item/permissions/requestApproval', {}]])
  for (const [owner, sandboxMode, harnessOnly] of [[false, 'danger-full-access', false], [true, 'workspace-write', false], [true, 'danger-full-access', true]]) {
    const { codexProvider } = await loadModule('src/main/providers/codex.ts', {
      './codex-rpc': { CodexRpc: Rpc }, '../auth': { codexBinary: () => 'codex' }, '../profile-context': { isOwner: () => owner },
      '../config': { cfg: () => ({ providers: { codex: {} }, timezone: 'UTC' }), files: { safeguards: { value: { codex: { sandboxMode, networkAccess: true } } } } }
    })
    await Array.fromAsync(codexProvider.run({ runId: 'r', prompt: 'x', cwd: '/tmp', context: '', env: {}, mcpServers: {}, harnessOnly, gate: async () => { gateCalls++; return { allow: true } }, signal: new AbortController().signal, steering: { register() {}, async close() {} } }))
  }
  assert.deepEqual(starts.map(s => [s.approvalPolicy, s.sandbox]), [['never', 'workspace-write'], ['never', 'workspace-write'], ['never', 'read-only']])
  assert.equal(gateCalls, 0, 'a safeguard allow rule can never lift the sandbox')
  assert.ok(answers.filter((_, i) => i % 3 === 2).every(a => a.scope === 'turn' && Object.keys(a.permissions).length === 0))
  assert.deepEqual(answers.slice(0, 3).map(a => a?.decision), ['decline', 'decline', undefined], 'command and edit approvals are declined')
})


test('Codex MCP approvals reach safeguards, preserve harness gating, and report unsupported requests', async () => {
  const approval = (serverName, input = {}, extra = {}) => ['mcpServer/elicitation/request', {
    threadId: 'thread', turnId: 'turn', serverName, mode: 'form',
    _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: input, persist: 'always' },
    requestedSchema: { type: 'object', properties: {} }, ...extra
  }]
  const started = (id, server, tool, input = {}) => ({ method: 'item/started', params: {
    threadId: 'thread', turnId: 'turn', item: { id, type: 'mcpToolCall', server, tool, arguments: input }
  } })
  const { Rpc, answers } = codexHarness([
    approval('harness', { op: 'notes_pair' }),
    approval('mail', { to: 'Owner' }),
    approval('mail', { to: 'stranger' }),
    approval('mail', { broken: true }),
    approval('harness', {}, { mode: 'url', url: 'https://example.com' }),
    approval('harness', {}, { requestedSchema: { type: 'object', properties: { password: { type: 'string' } } } }),
    approval('harness', {}, { _meta: null }),
    approval('unknown'),
    approval('ambiguous'),
    ['item/permissions/requestApproval', {}],
    ['item/tool/requestUserInput', {}],
    ['future/approval', {}]
  ], [
    started('h', 'harness', 'harness_call', { op: 'notes_pair' }),
    started('m1', 'mail', 'send', { to: 'Owner' }),
    started('m2', 'mail', 'send', { to: 'stranger' }),
    started('m3', 'mail', 'send', { broken: true }),
    started('a1', 'ambiguous', 'send'), started('a2', 'ambiguous', 'delete')
  ])
  const { codexProvider } = await loadModule('src/main/providers/codex.ts', {
    './codex-rpc': { CodexRpc: Rpc }, '../auth': { codexBinary: () => 'codex' }, '../profile-context': { isOwner: () => true },
    '../config': { cfg: () => ({ providers: { codex: {} }, timezone: 'UTC' }), files: { safeguards: { value: { codex: { sandboxMode: 'danger-full-access', networkAccess: true } } } } }
  })
  const gated = []
  const events = await Array.fromAsync(codexProvider.run({ runId: 'r', prompt: 'x', cwd: '/repo', context: '', env: {},
    mcpServers: { harness: { command: 'node' } },
    gate: async (tool, input) => {
      gated.push([tool, input])
      if (input.broken) throw new Error('gate unavailable')
      return input.to === 'Owner' ? { allow: true } : { allow: false, message: 'denied' }
    }, signal: new AbortController().signal, steering: { register() {}, async close() {} }
  }))
  assert.deepEqual(gated, [['mcp__mail__send', { to: 'Owner' }], ['mcp__mail__send', { to: 'stranger' }], ['mcp__mail__send', { broken: true }]])
  assert.deepEqual(answers.slice(0, 9).map(a => a.action), ['accept', 'accept', 'decline', 'decline', 'decline', 'decline', 'decline', 'decline', 'decline'])
  assert.ok(answers.slice(0, 9).every(a => a.content === null && a._meta === null), 'approvals never persist')
  assert.deepEqual(answers[9], { permissions: {}, scope: 'turn' })
  assert.deepEqual(answers[10], { answers: {} })
  assert.equal(answers[11], undefined)
  assert.ok(events.some(e => e.type === 'system' && e.data.codexServerRequest === 'future/approval'))
})


test('Codex MCP approvals reject completed or foreign calls and cancel without gating after abort', async () => {
  for (const variant of ['completed', 'foreign', 'aborted', 'sandboxed']) {
    const abort = new AbortController()
    const item = { id: 'h', type: 'mcpToolCall', server: 'harness', tool: 'harness_call', arguments: { op: 'notes_pair' } }
    const notifications = [{ method: 'item/started', params: { threadId: variant === 'foreign' ? 'child' : 'thread', turnId: 'turn', item } }]
    if (variant === 'completed') notifications.push({ method: 'item/completed', params: { item } })
    const { Rpc, answers } = codexHarness([['mcpServer/elicitation/request', {
      threadId: 'thread', turnId: 'turn', serverName: 'harness', mode: 'form',
      _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: item.arguments }, requestedSchema: { type: 'object', properties: {} }
    }]], notifications)
    class TestRpc extends Rpc {
      async request(method, args) {
        const result = await super.request(method, args)
        if (method === 'turn/start' && variant === 'aborted') abort.abort()
        return result
      }
    }
    const { codexProvider } = await loadModule('src/main/providers/codex.ts', {
      './codex-rpc': { CodexRpc: TestRpc }, '../auth': { codexBinary: () => 'codex' }, '../profile-context': { isOwner: () => true },
      '../config': { cfg: () => ({ providers: { codex: {} }, timezone: 'UTC' }), files: { safeguards: { value: { codex: { sandboxMode: 'read-only', networkAccess: false } } } } }
    })
    let gateCalls = 0
    await Array.fromAsync(codexProvider.run({ runId: 'r', prompt: 'x', cwd: '/repo', context: '', env: {}, mcpServers: { harness: { command: 'node' } },
      gate: async () => { gateCalls++; return { allow: true } }, signal: abort.signal, steering: { register() {}, async close() {} }
    }))
    assert.equal(gateCalls, 0)
    assert.equal(answers[0].action, variant === 'aborted' ? 'cancel' : variant === 'sandboxed' ? 'accept' : 'decline', variant)
  }
})
