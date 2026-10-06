import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import test from 'node:test'
import { loadModule } from './load-module.mjs'

const loggedOut = JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' })

async function setup(claudeResponse) {
  const calls = []
  const execFile = () => { throw new Error('Use the promisified execFile') }
  execFile[promisify.custom] = async (_bin, args) => {
    calls.push(args)
    if (args[0] === 'login') return { stdout: '', stderr: 'Logged in using ChatGPT' }
    if (claudeResponse instanceof Error) throw claudeResponse
    return { stdout: claudeResponse, stderr: '' }
  }
  const m = await loadModule('src/main/auth.ts', {
    'node:child_process': { execFile },
    './config': { cfg: () => ({ providers: { claude: { executable: '/bin/echo' }, codex: { executable: '/bin/echo' } } }) },
    './env': { agentEnv: () => ({ CODEX_HOME: '/nonexistent/jarvis-auth-test' }) },
    './paths': { expandHome: (p) => p, which: () => null },
    './profile-context': { profileId: () => 'owner' }
  })
  return { m, calls }
}

const failure = (stdout, extra = {}) => Object.assign(new Error('Command failed: claude auth status'), { code: 1, stdout, stderr: '', ...extra })

test('Claude exit 1 with loggedIn:false is a definite logout, not an unknown check', async () => {
  const { m } = await setup(failure(loggedOut))
  const status = (await m.authStatus()).claude
  assert.equal(status.ok, false)
  assert.equal(status.installed, true)
  assert.notEqual(status.unknown, true)
  assert.match(status.detail, /Not logged in/)
  await assert.rejects(m.assertSubscription('claude'), m.BillingGuardError)
})

test('successful status must explicitly say loggedIn:true before subscription is accepted', async () => {
  for (const stdout of ['{}', 'null', '[]', '{"loggedIn":"false"}', '{"loggedIn":true}', 'not json']) {
    const { m } = await setup(stdout)
    const status = (await m.authStatus()).claude
    assert.equal(status.ok, false, stdout)
    assert.equal(status.unknown, true, stdout)
    await m.assertSubscription('claude')
  }
})

test('valid subscription and API-key status preserve billing enforcement', async () => {
  const { m } = await setup(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro', email: 'owner@example.test' }))
  assert.equal((await m.authStatus()).claude.ok, true)
  await m.assertSubscription('claude')
  for (const authMethod of ['api_key', 'console']) {
    const { m } = await setup(JSON.stringify({ loggedIn: true, authMethod }))
    assert.equal((await m.authStatus()).claude.unknown, undefined)
    await assert.rejects(m.assertSubscription('claude'), m.BillingGuardError)
  }
})

test('successful logged-out response is definite too', async () => {
  const { m } = await setup(loggedOut)
  assert.notEqual((await m.authStatus()).claude.unknown, true)
  await assert.rejects(m.assertSubscription('claude'), m.BillingGuardError)
})

test('timeouts, spawn errors and contradictory nonzero responses stay unknown', async () => {
  for (const err of [failure(loggedOut, { killed: true }), failure(loggedOut, { code: 'ENOENT' }), failure(loggedOut, { signal: 'SIGTERM' }), failure('{}'), failure('{"loggedIn":true,"authMethod":"claude.ai"}'), failure('not json')]) {
    const { m } = await setup(err)
    assert.equal((await m.authStatus()).claude.unknown, true, JSON.stringify(err))
    await m.assertSubscription('claude')
  }
})

test('incomplete native Claude install is still identified', async () => {
  const { m } = await setup(failure('', { stderr: 'native binary not installed' }))
  const status = (await m.authStatus()).claude
  assert.equal(status.installed, false)
  assert.notEqual(status.unknown, true)
})
