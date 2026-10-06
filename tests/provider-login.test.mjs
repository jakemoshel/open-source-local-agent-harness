import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadModule } from './load-module.mjs'

const GOOD = 'goodcode12345#state1234567'
const CLAUDE_URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=state1234567'

// Mirrors what the real CLIs print in a PTY (captured from claude 2.1 and codex 0.157).
function fakeClis(dir) {
  const claude = join(dir, 'claude'), codex = join(dir, 'codex')
  writeFileSync(claude, `#!/usr/bin/env node
process.stdout.write('Opening browser to sign in…\\nIf the browser didn\\'t open, visit: \\x1b]8;;${CLAUDE_URL}\\x07\\x1b[94m${CLAUDE_URL}\\x1b[39m\\x1b]8;;\\x07\\nPaste code here if prompted > ')
process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  if (!buf.includes('\\r') && !buf.includes('\\n')) return
  const code = buf.trim()
  if (code === '${GOOD}') { require('fs').writeFileSync(process.env.FAKE_AUTH_DIR + '/auth-claude', process.env.JARVIS_TEST_PROFILE || ''); console.log('Login successful.'); process.exit(0) }
  console.log('Login failed: Request failed with status code 400'); process.exit(1)
})
`)
  writeFileSync(codex, `#!/usr/bin/env node
process.stdout.write('\\nWelcome to Codex\\n\\nFollow these steps to sign in with ChatGPT using device code authorization:\\n\\n1. Open this link in your browser and sign in to your account\\n   \\x1b[94mhttps://auth.openai.com/codex/device\\x1b[0m\\n\\n2. Enter this one-time code \\x1b[90m(expires in 15 minutes)\\x1b[0m\\n   \\x1b[94m5E9W-VNZYK\\x1b[0m\\n\\n')
const fs = require('fs')
const approved = process.env.FAKE_AUTH_DIR + '/approve-codex'
setInterval(() => { if (fs.existsSync(approved)) { fs.writeFileSync(process.env.FAKE_AUTH_DIR + '/auth-codex', ''); console.log('Successfully logged in'); process.exit(0) } }, 50)
`)
  const dying = join(dir, 'claude-dying')
  writeFileSync(dying, `#!/bin/sh\necho 'boom: config unreadable'\nexit 1\n`)
  chmodSync(claude, 0o755); chmodSync(codex, 0o755); chmodSync(dying, 0o755)
  return { claude, codex, dying }
}

async function setup(t, { dying } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-login-'))
  t.after(() => { m?.stopAllLogins(); rmSync(dir, { recursive: true, force: true }) })
  const bins = fakeClis(dir)
  const env = { HOME: dir, PATH: process.env.PATH, FAKE_AUTH_DIR: dir }
  const ctx = await loadModule('src/main/profile-context.ts')
  const status = (p) => existsSync(join(dir, `auth-${p}`))
  var m = await loadModule('src/main/provider-login.ts', {
    './auth': {
      claudeBinary: () => dying ? bins.dying : bins.claude,
      codexBinary: () => bins.codex,
      authStatus: async () => ({
        claude: { ok: status('claude'), detail: status('claude') ? 'Claude max subscription' : 'Not logged in' },
        codex: { ok: status('codex'), detail: status('codex') ? 'ChatGPT subscription' : 'Not logged in' }
      })
    },
    './env': { agentEnv: () => ({ ...env, JARVIS_TEST_PROFILE: ctx.profileId() }) },
    './profile-context': ctx,
    './config': { defaultCwd: () => dir },
    './paths': { expandHome: (p) => p }
  })
  return { m, ctx, dir }
}

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)) }
}

test('login codes are normalized and anything else is rejected', async (t) => {
  const { m } = await setup(t)
  assert.equal(m.normalizeLoginCode(` ${GOOD.slice(0, 6)}\n${GOOD.slice(6)} `), GOOD)
  assert.equal(m.normalizeLoginCode(`here was the code, please finish this\n\n${GOOD}\n`), GOOD)
  assert.equal(m.normalizeLoginCode(`https://example.test/authorize#state1234567\n${GOOD}`), GOOD)
  assert.equal(m.normalizeLoginCode(`${GOOD}\nothercode123#otherstate123`), null)
  for (const bad of ['hello there', 'no-hash-here-at-all', '#onlystate12345', 'a#b', 'code1234#state12 34 and more words']) assert.equal(m.normalizeLoginCode(bad), null, bad)
})

test('Claude: remote link, pasted code connects, the listener hears once, repeat requests reuse the link', async (t) => {
  const { m } = await setup(t)
  const heard = []
  const info = await m.startLogin('claude', { key: 'chat', fn: (i) => heard.push(i.state) })
  assert.equal(info.url, CLAUDE_URL)
  assert.equal(info.needsCode, true)
  assert.equal(m.waitingForClaudeCode(), true)
  assert.equal(m.loginsBusyForUpdate(), true)
  assert.equal((await m.startLogin('claude')).url, info.url)
  assert.equal(m.loginListening('claude', 'chat'), true)
  await assert.rejects(m.submitLoginCode('not a code'), /doesn’t look like/)
  assert.equal(m.waitingForClaudeCode(), true, 'a malformed code leaves the sign-in waiting')
  await assert.rejects(m.submitLoginCode('goodcode12345#wrongstate123'), /different sign-in/)
  assert.equal(m.waitingForClaudeCode(), true, 'a stale code must not consume the current sign-in')
  const done = await m.submitLoginCode(GOOD)
  assert.equal(done.state, 'connected')
  assert.match(done.detail, /max subscription/)
  assert.deepEqual(heard, ['connected'])
  assert.equal(m.waitingForClaudeCode(), false)
  assert.equal(m.loginsBusyForUpdate(), false)
  await assert.rejects(m.submitLoginCode(GOOD), /No Claude sign-in is waiting/)
  assert.match(m.loginResultText(done), /✅ Claude is connected/)
})

test('Claude: a rejected code reports the CLI error and a new sign-in can start', async (t) => {
  const { m } = await setup(t)
  const first = await m.startLogin('claude')
  const done = await m.submitLoginCode('wrongcode1234#state1234567')
  assert.equal(done.state, 'failed')
  assert.match(done.detail, /Login failed/)
  const again = await m.startLogin('claude')
  assert.equal(again.state, 'waiting')
  assert.equal(again.url, first.url)
})

test('Codex: device code is parsed and approval on another device connects', async (t) => {
  const { m, dir } = await setup(t)
  const heard = []
  const info = await m.startLogin('codex', { key: 'n', fn: (i) => heard.push(i.state) })
  assert.equal(info.url, 'https://auth.openai.com/codex/device')
  assert.equal(info.userCode, '5E9W-VNZYK')
  assert.equal(info.needsCode, false)
  assert.equal(m.waitingForClaudeCode(), false)
  assert.equal(m.loginsBusyForUpdate(), true, 'Codex approval is also active work')
  assert.match(m.loginInstructions(info), /Enter this code: 5E9W-VNZYK/)
  assert.match(m.loginInstructions(info, true), /The owner started this sign-in for you/)
  writeFileSync(join(dir, 'approve-codex'), '')
  await until(() => heard.length > 0)
  assert.deepEqual(heard, ['connected'])
  assert.equal(m.loginStatus('codex').state, 'connected')
})

test('sign-ins are per profile, cancel stops the CLI, and a CLI that dies early is reported', async (t) => {
  const { m, ctx } = await setup(t)
  const ethan = await ctx.withProfile('ethan', () => m.startLogin('claude'))
  assert.equal(ethan.profile, 'ethan')
  assert.equal(m.loginStatus('claude'), null, 'Owner does not see Ethan’s sign-in')
  assert.equal(m.waitingForClaudeCode(), false)
  assert.equal(m.loginsBusyForUpdate(), true, 'an update waits for other profiles too')
  assert.equal(ctx.withProfile('ethan', () => m.waitingForClaudeCode()), true)
  const heard = []
  await ctx.withProfile('ethan', () => m.startLogin('claude', { key: 'x', fn: (i) => heard.push(i.state) }))
  m.cancelAllLogins('ethan')
  assert.deepEqual(heard, ['cancelled'])
  assert.equal(m.loginsBusyForUpdate(), false)
  assert.equal(ctx.withProfile('ethan', () => m.loginStatus('claude')).state, 'cancelled')
  await assert.rejects(ctx.withProfile('ethan', () => m.submitLoginCode(GOOD)), /No Claude sign-in/)
})

test('a CLI that exits before showing a link fails the start', async (t) => {
  const { m } = await setup(t, { dying: true })
  await assert.rejects(m.startLogin('claude'), /Could not start Claude sign-in/)
  assert.equal(m.loginStatus('claude').state, 'failed')
})

test('chat: /connect replies with the link, the pasted code never reaches the agent, other messages still do', async () => {
  const sent = [], replies = [], calls = []
  let waiting = false, listener = null
  const m = await loadModule('src/main/gateways/commands.ts', {
    '../updater': { applyUpdate() {} },
    '../config': { cfg: () => ({ gateways: { idleResetMinutes: 0 } }) },
    '../db': { deleteConversation: () => undefined, getConversation: () => null, listRuns: () => [], kvGet: () => null, kvSet() {} },
    '../runs': { cancelRun: () => undefined, sendMessage: async (a) => { sent.push(a.prompt); return { run: { id: 'r' } } }, waitForRun: async () => ({ status: 'succeeded', result: 'agent reply' }) },
    '../context': { markExplicitReset: () => undefined },
    './approvals': { rememberChat: () => undefined, answerApproval: () => null },
    '../provider-login': {
      startLogin: async (provider, listen) => { calls.push(['start', provider]); listener = listen; waiting = provider === 'claude'; return { provider, url: 'https://x/oauth/authorize?redirect_uri=https', userCode: null, expiresAt: Date.now() + 9e5 } },
      loginInstructions: (i) => `link ${i.url}`,
      loginResultText: (i) => `result ${i.state}`,
      loginListening: (_p, key) => listener?.key === key,
      waitingForClaudeCode: () => waiting,
      normalizeLoginCode: (t) => t.split('\n').map(l => l.trim()).find(l => /^[\w.~-]{8,512}#[\w.~-]{8,512}$/.test(l)) ?? null,
      submitLoginCode: async (code) => { calls.push(['code', code]); waiting = false; const info = { state: 'connected' }; listener?.fn(info); return info },
      cancelLogin: (p) => { calls.push(['cancel', p]); return p === 'claude' && waiting ? { state: 'cancelled' } : null }
    }
  })
  const msg = (text, key = 'imessage:+1555') => ({ key, text, trigger: 'imessage', triggerRef: 'x', reply: async (t) => { replies.push(t) } })
  await m.handleInbound(msg('/connect chatgpt'))
  assert.deepEqual(calls.at(-1), ['start', 'codex'])
  await m.handleInbound(msg('/connect'))
  assert.deepEqual(calls.at(-1), ['start', 'claude'])
  assert.match(replies.at(-1), /^link https/)
  await m.handleInbound(msg('notes for project#alpha tomorrow'))
  assert.deepEqual(sent, ['notes for project#alpha tomorrow'])
  await m.handleInbound(msg(`please finish this\n\n${GOOD}`))
  assert.deepEqual(calls.at(-1), ['code', GOOD])
  assert.equal(sent.length, 1, 'the code was not sent to the agent')
  assert.equal(replies.filter((r) => r === 'result connected').length, 1, 'one result message, from the /connect listener')
  await m.handleInbound(msg(GOOD))
  assert.equal(sent.length, 1, 'stale codes never reach the agent or transcript')
  assert.match(replies.at(-1), /No Claude sign-in.*\/connect claude/)
  await m.handleInbound(msg('/connect cancel'))
  assert.equal(replies.at(-1), 'No sign-in is waiting.')
})

test('approvals asked over chat: 1/2/3 answers settle the oldest request and never reach the agent', async () => {
  const { EventEmitter } = await import('node:events')
  const bus = new EventEmitter()
  let profile = 'owner'
  const resolved = []
  const m = await loadModule('src/main/gateways/approvals.ts', {
    '../bus': { bus },
    '../db': { getRun: (id) => ({ conversationKey: id.startsWith('other') ? 'slack:elsewhere' : 'imessage:+1555' }) },
    '../profile-context': { profileId: () => profile, isOwner: () => profile === 'owner' },
    '../runs': { resolveApproval: (id, approve, always, via) => { resolved.push({ id, approve, always, via }); return { id, allowedAlways: always ? 'this exact command' : undefined } } },
    '../safeguards': { subjectOf: (tool, input) => input.command, allowAlwaysRule: () => ({ label: 'this exact command' }) }
  })
  for (const [text, want] of [['1', 'yes'], [' Yes! ', 'yes'], ['2', 'always'], ['always allow', 'always'], ['3', 'no'], ['nope', 'no'], ['yes, and email Sam', null], ['12', null], ['stop', null]]) {
    assert.equal(m.parseApprovalAnswer(text), want, text)
  }
  m.initApprovalPrompts()
  const sent = []
  m.rememberChat('imessage:+1555', async (t) => { sent.push(t) })
  assert.equal(m.answerApproval('imessage:+1555', '1', 'iMessage'), null, 'nothing asked yet: 1 is an ordinary message')
  bus.emit('approval:update', { id: 'a1', runId: 'r', tool: 'Bash', input: { command: 'npm test' }, status: 'pending' })
  bus.emit('approval:update', { id: 'a2', runId: 'r', tool: 'Bash', input: { command: 'git push' }, status: 'pending' })
  bus.emit('approval:update', { id: 'x', runId: 'other', tool: 'Bash', input: { command: 'ls' }, status: 'pending' })
  assert.equal(sent.length, 2, 'only this chat’s runs are asked here')
  assert.match(sent[0], /Run: npm test/)
  assert.match(sent[0], /1 = Yes · 2 = Yes, and always allow this exact command · 3 = No/)
  assert.equal(m.answerApproval('imessage:+1555', 'what is this?', 'iMessage'), null)
  assert.match(m.answerApproval('imessage:+1555', '2', 'iMessage'), /always allow|allow this exact command from now on/)
  assert.deepEqual(resolved[0], { id: 'a1', approve: true, always: true, via: 'iMessage' })
  bus.emit('approval:update', { id: 'a2', status: 'approved' })
  assert.equal(m.answerApproval('imessage:+1555', '3', 'iMessage'), null, 'settled in the app: nothing left to answer here')
  profile = 'sam'
  const memberSent = []
  m.rememberChat('imessage:+1555', async (t) => { memberSent.push(t) })
  bus.emit('approval:update', { id: 'm1', runId: 'r', tool: 'Bash', input: { command: 'ls' }, status: 'pending' })
  assert.match(memberSent[0], /Reply 1 = Yes · 3 = No$/)
  m.answerApproval('imessage:+1555', 'always', 'iMessage')
  assert.deepEqual(resolved.at(-1), { id: 'm1', approve: true, always: false, via: 'iMessage' }, 'members cannot loosen safeguards')
})
