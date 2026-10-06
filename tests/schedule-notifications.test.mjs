import test from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './load-module.mjs'
async function fixture({ fail, profile = 'owner' } = {}) {
  const db = new Map(), sent = [], desktop = [], logs = []
  let id = profile, failures = fail
  const mocks = {
    electron: { Notification: class { constructor(value) { desktop.push(value) } on() {} show() {} } },
    './config': { cfg: () => ({ notifications: { scheduleCompletions: true } }), files: { schedules: { value: { schedules: [] } } } },
    './db': { kvGet: key => db.get(id + key) ?? null, kvSet: (key, value) => db.set(id + key, structuredClone(value)), audit: (...args) => logs.push(args), listRuns: () => [] },
    './gateways': { deliver: async (...args) => { sent.push(args); if (failures) throw failures } },
    './profiles': { getProfile: value => ({ name: (value || id) === 'owner' ? 'Owner' : 'Alice', handles: ['owner@example.test', '+15555550100'] }), allProfiles: () => [], normalizeContact: x => x.trim().toLowerCase() },
    './profile-context': { OWNER_ID: 'owner', profileId: () => id, withProfile: (next, fn) => { const old = id; id = next; try { return fn() } finally { id = old } } }
  }
  return { module: await loadModule('src/main/schedule-notifications.ts', mocks), mocks, db, sent, desktop, logs, recover: () => { failures = null } }
}
const run = (patch = {}) => ({ id: 'run-1', status: 'succeeded', result: 'Result', finishedAt: Date.now(), ...patch })
test('every completion notifies the Mac and owner iMessage, even when there is no digest or configured destination', async () => {
  const f = await fixture()
  await f.module.notifyScheduledRun({ name: 'Daily digest' }, run({ result: 'NO_DIGEST' }))
  assert.equal(f.desktop.length, 1); assert.equal(f.sent.length, 1)
  assert.deepEqual(f.sent[0].slice(0, 2), ['imessage', 'owner@example.test'])
  assert.match(f.sent[0][2], /completed.*No new items/s); assert.ok(!f.sent[0][2].includes('NO_DIGEST'))
  await f.module.notifyScheduledRun({ name: 'Daily digest' }, run())
  const restarted = await loadModule('src/main/schedule-notifications.ts', f.mocks)
  await restarted.notifyScheduledRun({ name: 'Daily digest' }, run())
  assert.equal(f.sent.length, 1); assert.equal(f.desktop.length, 1)
})
test('configured delivery is preserved and owner is not messaged twice at another known handle', async () => {
  const f = await fixture()
  await f.module.notifyScheduledRun({ name: 'Task', deliver: { gateway: 'imessage', target: '+15555550100' } }, run())
  assert.equal(f.sent.length, 1); assert.match(f.sent[0][2], /Result/)
  await f.module.notifyScheduledRun({ name: 'Other', deliver: { gateway: 'slack', target: 'C123' } }, run({ id: 'run-2' }))
  assert.equal(f.sent.length, 3)
})
test('failed and cancelled schedules generate completion notices; other profiles do not leak output to owner', async () => {
  const f = await fixture({ profile: 'alice' })
  await f.module.notifyScheduledRun({ name: 'Review' }, run({ status: 'failed', error: 'private member content' }))
  assert.match(f.sent[0][2], /Alice: Review failed/); assert.ok(!f.sent[0][2].includes('private'))
  await f.module.notifyScheduledRun({ name: 'Review' }, run({ id: 'run-2', status: 'cancelled' }))
  assert.match(f.sent[1][2], /cancelled/)
})
test('definite delivery failures retry, ambiguous sends are not duplicated', async t => {
  t.mock.timers.enable({ apis: ['Date'] })
  const f = await fixture({ fail: new Error('offline') })
  await f.module.notifyScheduledRun({ name: 'Task' }, run())
  f.recover(); t.mock.timers.tick(60000)
  await f.module.notifyScheduledRun({ name: 'Task' }, run())
  assert.equal(f.sent.length, 2); assert.equal(f.desktop.length, 1)
  const uncertain = await fixture({ fail: { noRetry: true } })
  await uncertain.module.notifyScheduledRun({ name: 'Task' }, run())
  uncertain.recover(); t.mock.timers.tick(60000)
  await uncertain.module.notifyScheduledRun({ name: 'Task' }, run())
  assert.equal(uncertain.sent.length, 1)
})
