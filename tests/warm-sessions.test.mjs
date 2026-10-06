import test from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './load-module.mjs'

/** A stand-in Claude Code process in streaming-input mode: answers each pushed message until its input ends or it is killed. */
class FakeProcess {
  constructor(prompt, options, id) {
    Object.assign(this, { options, sessionId: options.resume ?? `S${id}`, prompts: [], out: [], waiters: [], done: false, closed: false })
    void this.pump(prompt)
  }
  emit(value) { const w = this.waiters.shift(); if (w) w({ value, done: false }); else this.out.push(value) }
  kill() { this.done = true; for (const w of this.waiters.splice(0)) w({ value: undefined, done: true }) }
  next() {
    if (this.out.length) return Promise.resolve({ value: this.out.shift(), done: false })
    if (this.done) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => this.waiters.push(resolve))
  }
  [Symbol.asyncIterator]() { return this }
  close() { this.closed = true; this.kill() }
  async pump(prompt) {
    let first = true
    for await (const m of prompt) {
      if (this.done) return
      const text = m.message.content
      this.prompts.push(text)
      if (first) this.emit({ type: 'system', subtype: 'init', apiKeySource: 'oauth', session_id: this.sessionId, model: 'm', tools: [], mcp_servers: [], cwd: '/', claude_code_version: 'test' })
      first = false
      this.emit({ type: 'assistant', session_id: this.sessionId, message: { content: [{ type: 'text', text: `echo ${text}` }] } })
      this.emit({ type: 'result', subtype: 'success', is_error: false, result: `echo ${text}`, ...(this.options.outputFormat ? { structured_output: { size: 'small', reason: 'Local fault' } } : {}), usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 1, user_message_uuids: [m.uuid], session_id: this.sessionId })
    }
    this.kill()
  }
}

async function provider(config = {}) {
  const procs = []
  const harnessCalls = []
  const mod = await loadModule('src/main/providers/claude.ts', {
    '@anthropic-ai/claude-agent-sdk': {
      query: ({ prompt, options }) => { const p = new FakeProcess(prompt, options, procs.length + 1); procs.push(p); return p },
      createSdkMcpServer: (s) => s, tool: (name, description, schema, handler) => ({ name, handler })
    },
    '../auth': { claudeBinary: () => '/unused' },
    '../config': { cfg: () => ({ providers: { claude: {} }, timezone: 'UTC', ...config }), files: { safeguards: { value: { approvalTimeoutSec: 1 } } } },
    '../harness-tools': { HARNESS_TOOL_DEFS: [{ name: 'ops' }, { name: 'call' }], runHarnessTool: async (...args) => { harnessCalls.push(args); return 'ok' } }
  })
  const steering = () => ({ register() {}, async close() {} })
  const run = (o) => Array.fromAsync(mod.claudeProvider.run({
    runId: 'r', cwd: process.cwd(), context: 'ctx', env: {}, mcpServers: {}, gate: async () => ({ allow: true }),
    signal: new AbortController().signal, steering: steering(), ...o
  }))
  return { ...mod, procs, run, harnessCalls }
}

const sessionOf = (events) => events.find((e) => e.type === 'session').sessionId

test('resumed jobs start a fresh process and bind tools and hooks to their own run', async () => {
  const p = await provider()
  const first = await p.run({ prompt: 'one', runId: 'old' })
  const second = await p.run({ prompt: 'two', runId: 'new', resume: sessionOf(first), gate: async () => ({ allow: false, message: 'new gate' }) })
  assert.equal(p.procs.length, 2)
  assert.equal(p.procs.every(proc => proc.closed), true)
  assert.equal(p.procs[1].options.resume, sessionOf(first))
  assert.equal(second.at(-1).text, 'echo two')
  assert.deepEqual(p.procs[1].prompts, ['two'])
  const options = p.procs[1].options
  await options.mcpServers.harness.tools[1].handler({ op: 'test' })
  assert.equal(p.harnessCalls[0][2], 'new')
  const decision = await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'test' }, '', { signal: new AbortController().signal })
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(decision.hookSpecificOutput.permissionDecisionReason, 'new gate')
})

test('consecutive jobs never reuse a resident process', async () => {
  const p = await provider()
  await p.run({ prompt: 'one' })
  await p.run({ prompt: 'two' })
  assert.equal(p.procs.length, 2)
  assert.equal(p.procs.every(proc => proc.closed), true)
})

test('cancelling a job closes its process', async () => {
  const p = await provider()
  const abort = new AbortController()
  abort.abort()
  await p.run({ prompt: 'cancelled', signal: abort.signal }).catch(() => undefined)
  assert.equal(p.procs.every(proc => proc.closed), true)
})

test('the system prompt holds no date; the send time rides on the message', async () => {
  const { systemPrompt, timeNote } = await loadModule('src/main/providers/types.ts')
  assert.doesNotMatch(systemPrompt('ctx', '/w', 'America/New_York'), /\d{4}-\d{2}-\d{2}/)
  assert.equal(timeNote('America/New_York', new Date('2026-10-02T23:30:00Z')), '\n\n(Sent Fri 2026-10-02 19:30 GMT-4)')
})

test('memory maintenance exposes only harness tools and closes its process', async () => {
  const p = await provider()
  const first = await p.run({ prompt: 'normal task' })
  await p.run({ prompt: 'reconcile memory', resume: sessionOf(first), harnessOnly: true })
  assert.equal(p.procs.length, 2)
  assert.deepEqual(p.procs[1].options.tools, [])
  assert.ok(p.procs[1].options.mcpServers.harness)
  assert.equal(p.procs[1].closed, true)
})


test('Claude transports the review schema and returns structured output instead of prose', async () => {
  const p = await provider()
  const schema = { type: 'object', properties: { size: { type: 'string' } }, required: ['size'] }
  const events = await p.run({ prompt: 'Classify task', outputSchema: schema })
  assert.deepEqual(p.procs[0].options.outputFormat, { type: 'json_schema', schema })
  assert.deepEqual(JSON.parse(events.at(-1).text), { size: 'small', reason: 'Local fault' })
  assert.equal(p.procs[0].closed, true)
})
