import test from 'node:test'
import assert from 'node:assert/strict'
import { loadModule, deferred, tick } from './load-module.mjs'

async function fixture({ running = true, output = (input) => `${input}\nout:${input}\n% `, startup } = {}) {
  const sent = [], closed = [], audits = []
  let opened = 0
  const api = await loadModule('src/main/chat-terminal.ts', {
    './db': { audit: (...a) => audits.push(a) },
    './terminal': {
      openTerminal: async () => { const id = `t${++opened}`; if (startup) await startup; return { id, cursor: 10, output: 'motd\n% ' } },
      sendToTerminal: async (id, opts) => { sent.push({ id, ...opts }); return { output: opts.input !== undefined ? output(opts.input) : '^C\n% ', cursor: 20, running, matched: false } },
      readTerminal: async (id, opts) => ({ output: `later since ${opts.since}`, cursor: 30, running: true }),
      closeTerminal: (id) => { closed.push(id) }
    }
  })
  const say = (key, text) => { const cmd = api.parseTerminalCommand(key, text); return cmd ? api.runTerminalCommand(key, cmd) : null }
  return { api, sent, closed, audits, say, opened: () => opened }
}

test('only TERMINAL forms match outside terminal mode; ordinary text and shell-ish words reach the agent', async () => {
  const { api } = await fixture()
  for (const text of ['terminal', 'Terminal', 'open the terminal', 'EXIT', 'READ', '^C', 'STOP', '$50 for lunch?', 'ls']) assert.equal(api.parseTerminalCommand('k', text), null, text)
  assert.deepEqual(api.parseTerminalCommand('k', 'TERMINAL'), { kind: 'enter' })
  assert.deepEqual(api.parseTerminalCommand('k', '/Term'), { kind: 'enter' })
  assert.deepEqual(api.parseTerminalCommand('k', 'TERMINAL ls -la'), { kind: 'run', input: 'ls -la' })
  assert.deepEqual(api.parseTerminalCommand('k', '/terminal git status'), { kind: 'run', input: 'git status' })
  assert.deepEqual(api.parseTerminalCommand('k', '$ brew upgrade'), { kind: 'run', input: 'brew upgrade' })
})

test('terminal mode types every message into one persistent shell per chat until EXIT', async () => {
  const f = await fixture()
  assert.match(await f.say('a', 'TERMINAL'), /Terminal mode/)
  assert.ok(f.api.inTerminalMode('a'))
  assert.equal(f.api.inTerminalMode('b'), false, 'other chats are unaffected')
  assert.equal(await f.say('a', 'cd ~/code'), '```\nout:cd ~/code\n%\n```', 'the echoed command is dropped')
  await f.say('a', 'claude update')
  assert.deepEqual(f.sent.map((s) => [s.id, s.input]), [['t1', 'cd ~/code'], ['t1', 'claude update']])
  assert.equal(f.opened(), 1)
  await f.say('a', 'Stop')
  assert.deepEqual(f.sent.at(-1).keys, ['ctrl-c'])
  assert.match(await f.say('a', 'READ'), /later since 20/)
  assert.match(await f.say('a', 'EXIT'), /Terminal closed/)
  assert.deepEqual(f.closed, ['t1'])
  assert.equal(f.api.parseTerminalCommand('a', 'ls'), null, 'messages go to the agent again')
  assert.equal(f.audits.length, 2, 'typed commands are audited')
})

test('a one-shot command opens a shell without entering terminal mode, and a shell that exits ends the mode', async () => {
  const f = await fixture({ running: false })
  await f.say('a', '$ exit')
  assert.equal(f.api.inTerminalMode('a'), false)
  assert.deepEqual(f.closed, ['t1'])
  await f.say('a', 'TERMINAL')
  assert.match(await f.say('a', 'exit'), /shell exited; terminal mode ended/)
  assert.equal(f.api.inTerminalMode('a'), false)
})

test('long output keeps the newest part and empty output says how to check again', async () => {
  const long = await fixture({ output: (i) => `${i}\n${'x'.repeat(5000)}END` })
  const reply = await long.say('a', '$ big')
  assert.ok(reply.length < 3600 && reply.includes('END'))
  const quiet = await fixture({ output: (i) => `${i}\n` })
  assert.match(await quiet.say('a', '$ sleep 60'), /READ checks again/)
})

test('chat gateway: terminal commands skip the model and are owner-only', async () => {
  const load = async (owner) => {
    const prompts = [], replies = [], runs = []
    const { handleInbound } = await loadModule('src/main/gateways/commands.ts', {
      '../config': { cfg: () => ({ gateways: { idleResetMinutes: 0 } }) },
      '../db': { deleteConversation() {}, getConversation() {}, listRuns: () => [], kvGet: () => null, kvSet() {} },
      '../runs': { cancelRun() {}, sendMessage: async (a) => { prompts.push(a.prompt); return { run: { id: 'r' } } }, waitForRun: async () => ({ status: 'succeeded', result: 'answer' }) },
      '../profile-context': { isOwner: () => owner },
      '../updater': { applyUpdate() {} },
      './approvals': { rememberChat() {}, answerApproval() {} },
      '../chat-terminal': { parseTerminalCommand: (_, t) => (t.startsWith('$ ') ? { kind: 'run', input: t.slice(2) } : null), runTerminalCommand: async (_, c) => { runs.push(c.input); return 'ran' } },
      '../provider-login': { waitingForClaudeCode: () => false, normalizeLoginCode() {}, cancelLogin() {}, loginInstructions() {}, loginListening() {}, loginResultText() {}, startLogin() {}, submitLoginCode() {} }
    })
    const send = (text) => handleInbound({ key: 'imessage:chat', text, trigger: 'imessage', triggerRef: 'ref', reply: async (t) => { replies.push(t) } })
    return { prompts, replies, runs, send }
  }
  const owner = await load(true)
  await owner.send('$ uptime')
  await owner.send('how are you')
  assert.deepEqual(owner.runs, ['uptime'])
  assert.deepEqual(owner.prompts, ['how are you'])
  assert.deepEqual(owner.replies, ['ran', 'answer'])
  const member = await load(false)
  await member.send('$ uptime')
  assert.deepEqual(member.runs, [])
  assert.deepEqual(member.replies, ['Only the owner can use the terminal.'])
})

test('overlapping terminal startup shares one shell and preserves mode', async () => {
  const startup = deferred()
  const f = await fixture({ startup: startup.promise })
  const once = f.say('a', '$ pwd')
  const enter = f.say('a', 'TERMINAL')
  await tick()
  assert.equal(f.opened(), 1)
  startup.resolve()
  await Promise.all([once, enter])
  assert.equal(f.api.inTerminalMode('a'), true)
  await f.say('a', 'EXIT')
  assert.deepEqual(f.closed, ['t1'])
})

test('terminal mode outranks UPDATE, while sign-in credentials never enter the shell', async () => {
  const inputs = [], codes = [], updates = []
  const { interpretChat } = await loadModule('src/main/gateways/commands.ts', {
    '../runs': { cancelRun() {}, sendMessage() {}, waitForRun() {} },
    './approvals': { rememberChat() {}, answerApproval() {} },
    '../profile-context': { isOwner: () => true },
    '../updater': { applyUpdate: async () => { updates.push(true); return { state: 'idle' } } },
    '../chat-terminal': { parseTerminalCommand: (_, input) => ({ kind: 'run', input }), runTerminalCommand: async (_, cmd) => { inputs.push(cmd.input); return 'shell reply' } },
    '../provider-login': { normalizeLoginCode: text => text.includes('#') ? text : null, waitingForClaudeCode: () => true, loginListening: () => false, submitLoginCode: async code => { codes.push(code); return {} }, loginResultText: () => 'signed in', cancelLogin() {}, loginInstructions() {}, startLogin() {} }
  })
  const send = text => interpretChat({ key: 'ui:test', text, trigger: 'ui', reply: async () => {} })
  assert.equal((await send('UPDATE')).reply, 'shell reply')
  assert.equal((await send('abcdefgh#12345678')).reply, 'signed in')
  assert.deepEqual(inputs, ['UPDATE'])
  assert.deepEqual(codes, ['abcdefgh#12345678'])
  assert.deepEqual(updates, [])
})
