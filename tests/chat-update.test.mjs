import test from 'node:test'
import assert from 'node:assert/strict'
import { loadModule, deferred } from './load-module.mjs'

async function harness({ owner = true, update = async () => ({ state: 'idle' }) } = {}) {
  const calls = [], replies = [], prompts = []
  const { handleInbound } = await loadModule('src/main/gateways/commands.ts', {
    '../config': { cfg: () => ({ gateways: { idleResetMinutes: 0 } }) },
    '../db': { deleteConversation() { throw new Error('must preserve conversation') }, getConversation() {}, listRuns: () => [], kvGet: () => null, kvSet() {} },
    '../runs': { cancelRun() { throw new Error('must not cancel tasks') }, sendMessage: async (a) => { prompts.push(a.prompt); return { run: { id: 'r' } } }, waitForRun: async () => ({ status: 'succeeded', result: 'answer' }) },
    '../context': { markExplicitReset() { throw new Error('must not reset context') } },
    '../profile-context': { isOwner: () => owner },
    '../updater': { applyUpdate: async (opts) => { calls.push(opts); assert.ok(replies.length, 'acknowledge before update can restart the process'); return update() } },
    './approvals': { rememberChat() {}, answerApproval() {} },
    '../provider-login': { waitingForClaudeCode: () => false, normalizeLoginCode() {}, cancelLogin() {}, loginInstructions() {}, loginListening() {}, loginResultText() {}, startLogin() {}, submitLoginCode() {} }
  })
  return { calls, replies, prompts, send: (text, trigger = 'imessage') => handleInbound({ key: `${trigger}:chat`, text, trigger, triggerRef: 'ref', reply: async (text) => { replies.push(text) } }) }
}

test('UPDATE aliases bypass the model and request a non-forced user update in either chat gateway', async () => {
  const h = await harness()
  for (const trigger of ['imessage', 'slack']) for (const command of ['UPDATE', ' UPDATE ', '/update', '!UpDaTe']) await h.send(command, trigger)
  assert.equal(h.calls.length, 8)
  for (const opts of h.calls) { assert.equal(opts.actor, 'user'); assert.ok(['slack', 'imessage'].includes(opts.reply.gateway)); assert.equal(opts.reply.target, 'chat') }
  assert.deepEqual(h.prompts, [])
  assert.equal(h.replies.at(-1), 'Jarvis is already up to date.')
})

test('members cannot update the shared app', async () => {
  const h = await harness({ owner: false })
  await h.send('UPDATE')
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.prompts, [])
  assert.deepEqual(h.replies, ['Only the owner can update the app.'])
})

test('ordinary messages containing update still reach the agent', async () => {
  const h = await harness()
  await h.send('update the shopping list')
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.prompts, ['update the shopping list'])
})

test('bare commands act in capitals (NEW/STOP also autocapitalized); lowercase words go to the agent', async () => {
  const h = await harness()
  for (const text of ['update', 'Update', 'stop', 'new']) await h.send(text)
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.prompts, ['update', 'Update', 'stop', 'new'])
  await h.send('STOP')
  assert.deepEqual(h.replies.at(-1), 'Nothing is running.')
  assert.equal(h.prompts.length, 4)
})

test('update acknowledgement precedes building; installing sends no late reply', async () => {
  const pending = deferred()
  const h = await harness({ update: () => pending.promise })
  const done = h.send('UPDATE')
  await new Promise(setImmediate)
  assert.equal(h.replies.length, 1)
  assert.match(h.replies[0], /separate worker/)
  pending.resolve({ state: 'installing' })
  await done
  assert.equal(h.replies.length, 1)
})

test('waiting status and updater failures are reported directly', async () => {
  for (const state of ['available', 'error']) {
    const h = await harness({ update: async () => ({ state, message: state === 'available' ? 'Waiting for 1 active run(s) to finish' : 'Build failed' }) })
    await h.send('UPDATE')
    assert.match(h.replies.at(-1), state === 'available' ? /Waiting for 1/ : /Update failed: Build failed/)
  }
  const h = await harness({ update: async () => { throw new Error('Installed app required') } })
  await h.send('UPDATE')
  assert.match(h.replies.at(-1), /Update failed: Installed app required/)
})
