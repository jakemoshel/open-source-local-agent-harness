import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { loadModule } from './load-module.mjs'

async function ledger() {
  const db = new DatabaseSync(':memory:')
  // The table definition comes from db.ts so the test cannot drift from the real schema.
  db.exec(/CREATE TABLE IF NOT EXISTS faults \([\s\S]*?\);/.exec(readFileSync('src/main/db.ts', 'utf8'))[0])
  const bus = new EventEmitter(), recorded = []
  bus.on('fault:recorded', (f) => recorded.push(f))
  const faults = await loadModule('src/main/faults.ts', {
    './db': { getDb: () => db },
    './bus': { bus },
    './profile-context': { OWNER_ID: 'owner', withProfile: (_id, fn) => fn() }
  })
  return { faults, recorded }
}

const bug = (id) => Object.assign(new TypeError(`Cannot read properties of undefined (reading 'id') for run ${id}`), {
  stack: `TypeError: Cannot read properties of undefined (reading 'id')\n    at deliverReply (/Applications/Mac Mini Jarvis.app/out/main/index.js:${id}:12)\n    at async handle (/x/out/main/index.js:9:1)\n    at node:internal/process/task_queues:95:5`
})

test('occurrences of one bug share a fingerprint despite ids, numbers and line positions', async () => {
  const { faults, recorded } = await ledger()
  const a = faults.recordFault({ source: 'op:gateways_send', error: bug(101) }, 1_000)
  const b = faults.recordFault({ source: 'op:gateways_send', error: bug(202) }, 2_000)
  assert.equal(a.fingerprint, b.fingerprint)
  assert.equal(b.count, 2)
  assert.equal(b.windowCount, 2)
  assert.equal(b.cls, 'code')
  assert.equal(recorded.length, 2)
  assert.notEqual(faults.recordFault({ source: 'op:skills_patch', error: bug(1) }, 3_000).fingerprint, a.fingerprint)
})

test('classification separates code bugs from environment trouble', async () => {
  const { faults } = await ledger()
  assert.equal(faults.classifyFault('run', 'TypeError', 'x is not a function'), 'code')
  assert.equal(faults.classifyFault('run', 'Error', 'no such column: foo'), 'code')
  assert.equal(faults.classifyFault('run', 'Error', 'ENOSPC: no space left on device'), 'env')
  assert.equal(faults.classifyFault('run', 'TypeError', 'fetch failed'), 'env')
  assert.equal(faults.classifyFault('run', 'Error', 'You have hit your usage limit'), 'env')
  assert.equal(faults.classifyFault('op:runs_get', 'Error', 'Run not found'), 'unknown')
  assert.equal(faults.classifyFault('reflection', 'Defect', 'skills_patch drops the frontmatter'), 'code')
})

test('a fault is due on first crash, or after repeating within a day; never for env or settled faults', async () => {
  const { faults } = await ledger()
  const day = faults.FAULT_WINDOW_MS
  const once = faults.recordFault({ source: 'op:gateways_send', error: bug(1) }, 0)
  assert.equal(faults.faultDue(once, 0), true)
  assert.equal(faults.faultDue(faults.recordFault({ source: 'op:gateways_send', error: bug(2) }, 1_000), 1_000), true)
  // A repeat after the window starts a new count.
  const late = faults.recordFault({ source: 'op:gateways_send', error: bug(3) }, day + 5_000)
  assert.equal(late.windowCount, 1)
  assert.equal(faults.faultDue(late, day + 5_000), true)

  assert.equal(faults.faultDue(faults.recordFault({ source: 'crash', error: bug(4) }, 0), 0), true)
  for (const source of ['startup', 'startup:learning', 'rejection', 'reflection'])
    assert.equal(faults.faultDue(faults.recordFault({ source, error: bug(6) }, 0), 0), true, source)
  assert.equal(faults.faultDue(faults.recordFault({ source: 'reflection-ish', error: bug(7) }, 0), 0), true)
  assert.equal(faults.faultDue(faults.recordFault({ source: 'crash', error: new Error('ENOSPC: disk full') }, 0), 0), false)

  const crash = faults.recordFault({ source: 'crash', error: bug(5) }, 0)
  assert.equal(faults.faultDue(faults.updateFault(crash.fingerprint, { status: 'ignored' }), 0), false)
  assert.equal(faults.faultDue(faults.updateFault(crash.fingerprint, { status: 'open', nextAttemptAt: 10_000 }), 0), false)
})

test('recording never throws, even when the database is unavailable or the error is not an Error', async () => {
  const faults = await loadModule('src/main/faults.ts', {
    './db': { getDb: () => { throw new Error('Database is not open') } },
    './bus': { bus: new EventEmitter() },
    './profile-context': { OWNER_ID: 'owner', withProfile: (_id, fn) => fn() }
  })
  assert.equal(faults.recordFault({ source: 'crash', error: 'boom' }), null)
  const { faults: live } = await ledger()
  assert.equal(live.recordFault({ source: 'rejection', error: undefined }).message, 'undefined')
  assert.equal(live.recordFault({ source: 'rejection', error: { message: 'plain object' } }).message, 'plain object')
})

test('updates and listing filter by status and class', async () => {
  const { faults } = await ledger()
  const a = faults.recordFault({ source: 'crash', error: bug(1) }, 0)
  faults.recordFault({ source: 'crash', error: new Error('ETIMEDOUT') }, 1)
  assert.equal(faults.listFaults({ cls: 'code' }).length, 1)
  assert.equal(faults.listFaults({ cls: 'env' }).length, 1)
  faults.updateFault(a.fingerprint, { status: 'ignored', note: 'accepted', commit: undefined })
  assert.equal(faults.listFaults({ status: 'ignored' })[0].note, 'accepted')
  assert.equal(faults.listFaults({ status: 'open' }).length, 1)
  assert.equal(faults.updateFault('missing', { status: 'open' }), null)
})

test('reflection may report defects and read the ledger, nothing else new', async () => {
  const policy = await loadModule('src/main/learning-policy.ts')
  assert.equal(policy.reviewToolAllowed('mcp__harness__harness_call', { op: 'harness_report_defect' }), true)
  assert.equal(policy.reviewToolAllowed('mcp__harness__harness_call', { op: 'faults_list' }), true)
  assert.equal(policy.reviewToolAllowed('mcp__harness__harness_call', { op: 'faults_set_status' }), false)
})

test('unknown errors become repair candidates only after three occurrences in the window', async () => {
  const { faults } = await ledger()
  const input = { source: 'op:example', error: new Error('Unexpected result') }
  assert.equal(faults.faultDue(faults.recordFault(input, 100), 100), false)
  assert.equal(faults.faultDue(faults.recordFault(input, 200), 200), false)
  assert.equal(faults.faultDue(faults.recordFault(input, 300), 300), true)
  const late = 300 + faults.FAULT_WINDOW_MS
  assert.equal(faults.faultDue(faults.recordFault(input, late), late), false)
})

test('queue selection finds old due work beyond 200 recent faults and prioritizes impact', async () => {
  const { faults } = await ledger()
  const scope = { size: 'small', reason: 'Local fault', files: [], components: [], estimatedMinutes: 10, validation: 'regression', priority: 50 }
  const old = faults.recordFault({ source: 'old-code', error: bug(1), assessment: scope }, 0)
  for (let i = 0; i < 220; i++) faults.recordFault({ source: `outside-${i}`, error: new Error('ENOSPC: disk full') }, 1000 + i)
  assert.equal(faults.listFaults({ limit: 200 }).some(f => f.fingerprint === old.fingerprint), false)
  assert.equal(faults.nextDueFault(0, 2000).fingerprint, old.fingerprint)
  const urgent = faults.recordFault({ source: 'urgent-code', error: bug(2), assessment: { ...scope, priority: 100 } }, 2001)
  assert.equal(faults.nextDueFault(0, 2002).fingerprint, urgent.fingerprint)
  faults.updateFault(urgent.fingerprint, { status: 'repairing' }); faults.updateFault(old.fingerprint, { status: 'repairing' })
  faults.reopenInterruptedFaults()
  assert.equal(faults.getFault(old.fingerprint).status, 'open')
  faults.updateFault(urgent.fingerprint, { attempts: 100 })
  assert.equal(faults.nextDueFault(0, 2002).fingerprint, urgent.fingerprint, 'unlimited attempts remain eligible')
  assert.equal(faults.nextDueFault(3, 2002).fingerprint, old.fingerprint)
})
