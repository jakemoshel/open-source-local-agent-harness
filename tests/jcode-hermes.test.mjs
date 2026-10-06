import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadModule } from './load-module.mjs'

globalThis.__BUILD_COMMIT__ = 'test-commit'
globalThis.__SOURCE_DIR__ = '/tmp'

const { concurrencyTracker } = await loadModule('src/main/concurrency-tracker.ts')
const policy = await loadModule('src/main/learning-policy.ts')
const skillUsage = await loadModule('src/main/skill-usage.ts', {
  './db': {
    getDb: () => ({
      prepare: () => ({
        all: () => [
          { name: 'good-skill', suggested: 5, loaded: 10, succeeded: 9, failed: 1, lastLoadedAt: 1000 },
          { name: 'fragile-skill', suggested: 3, loaded: 6, succeeded: 3, failed: 3, lastLoadedAt: 2000 },
          { name: 'failing-skill', suggested: 2, loaded: 5, succeeded: 1, failed: 4, lastLoadedAt: 3000 },
          { name: 'unused-skill', suggested: 1, loaded: 0, succeeded: 0, failed: 0, lastLoadedAt: null }
        ],
        run: () => {}
      })
    })
  }
})

test('Jcode concurrency tracker detects write-write, write-read, and read-write collisions across runs', (t) => {
  concurrencyTracker.reset()
  t.after(() => concurrencyTracker.reset())

  // Run 1 acquires read on file A
  const r1 = concurrencyTracker.acquire('run-1', 'src/main.ts', 'read', '/workspace')
  assert.equal(r1.conflict, null)

  // Run 1 re-accesses same file as read or write without self-conflict
  const r1Self = concurrencyTracker.acquire('run-1', 'src/main.ts', 'write', '/workspace')
  assert.equal(r1Self.conflict, null)

  // Run 2 attempts to write to file A while Run 1 has write lease -> write-write conflict
  const r2Write = concurrencyTracker.acquire('run-2', 'src/main.ts', 'write', '/workspace')
  assert.ok(r2Write.conflict)
  assert.equal(r2Write.conflict.type, 'write-write')
  assert.equal(r2Write.conflict.conflictingRunId, 'run-1')

  // Run 3 attempts to read file A while Run 1 has write lease -> read-write conflict
  const r3Read = concurrencyTracker.acquire('run-3', 'src/main.ts', 'read', '/workspace')
  assert.ok(r3Read.conflict)
  assert.equal(r3Read.conflict.type, 'read-write')

  // Releasing Run 1 clears leases for Run 1
  concurrencyTracker.releaseAllForRun('run-1')
  assert.ok(!concurrencyTracker.getActiveFiles().some(f => f.runId === 'run-1'))

  // Conflicts are logged
  const conflicts = concurrencyTracker.getConflicts()
  assert.ok(conflicts.length >= 2)
})

function leaseFixture(t) {
  concurrencyTracker.reset()
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-leases-')))
  t.after(() => {
    concurrencyTracker.reset()
    rmSync(root, { recursive: true, force: true })
  })
  const directory = join(root, 'workspace')
  const alias = join(root, 'alias')
  mkdirSync(directory)
  symlinkSync('workspace', alias, 'dir')
  const file = join(directory, 'file.ts')
  writeFileSync(file, 'original')
  const fileAlias = join(root, 'file-alias.ts')
  symlinkSync('workspace/file.ts', fileAlias, 'file')
  return { directory, alias, file, fileAlias }
}

test('Jcode blocks concurrent writes through file and directory symlink aliases', (t) => {
  const { file, fileAlias, alias } = leaseFixture(t)
  assert.equal(concurrencyTracker.acquire('writer', file, 'write').conflict, null)
  for (const path of [fileAlias, join(alias, 'file.ts')]) {
    const { conflict } = concurrencyTracker.acquire('other-writer', path, 'write')
    assert.equal(conflict?.type, 'write-write', 'an alias must not bypass the write guard')
    assert.equal(conflict.path, file)
    assert.equal(conflict.conflictingRunId, 'writer')
  }
  assert.deepEqual(concurrencyTracker.getActiveFiles().map(l => l.runId), ['writer'])
})

test('Jcode canonicalizes missing files through existing symlink ancestors', (t) => {
  const { directory, alias } = leaseFixture(t)
  const file = join(directory, 'not-created', 'nested', 'new.ts')
  const aliasedFile = join(alias, 'not-created', 'nested', 'new.ts')
  assert.equal(concurrencyTracker.acquire('writer', aliasedFile, 'write').conflict, null)
  assert.equal(concurrencyTracker.acquire('other-writer', file, 'write').conflict?.type, 'write-write')
  assert.equal(concurrencyTracker.getActiveFiles()[0].path, file)
  mkdirSync(join(directory, 'not-created', 'nested'), { recursive: true })
  writeFileSync(file, 'created')
  concurrencyTracker.release('writer', file)
  assert.deepEqual(concurrencyTracker.getActiveFiles(), [])
  assert.equal(concurrencyTracker.acquire('other-writer', aliasedFile, 'write').conflict, null)
})

for (const [heldMode, requestedMode, type] of [
  ['write', 'write', 'write-write'],
  ['write', 'read', 'read-write'],
  ['read', 'write', 'write-read']
]) {
  test(`Jcode checks ${type} conflicts through a symlinked working directory`, (t) => {
    const { directory, alias, file } = leaseFixture(t)
    concurrencyTracker.acquire('holder', 'file.ts', heldMode, directory)
    const conflict = concurrencyTracker.checkConflict('requester', './file.ts', requestedMode, alias)
    assert.equal(conflict?.type, type)
    assert.equal(conflict.path, file)
    assert.equal(concurrencyTracker.getConflicts()[0].path, file)
    assert.equal(concurrencyTracker.getActiveFiles().length, 1, 'checking must not acquire a lease')
  })
}

test('Jcode releases a file lease through either symlink alias', (t) => {
  const { alias, file, fileAlias } = leaseFixture(t)
  for (const path of [fileAlias, join(alias, 'file.ts')]) {
    concurrencyTracker.acquire('writer', file, 'write')
    concurrencyTracker.release('writer', path)
    assert.deepEqual(concurrencyTracker.getActiveFiles(), [], 'releasing an alias must clear the canonical lease')
    assert.equal(concurrencyTracker.checkConflict('next-writer', file, 'write'), null)
  }
})

test('Jcode merges same-run aliases and preserves unrelated and shared read leases', (t) => {
  const { alias, file, fileAlias } = leaseFixture(t)
  concurrencyTracker.acquire('reader', fileAlias, 'read')
  assert.equal(concurrencyTracker.acquire('other-reader', 'file.ts', 'read', alias).conflict, null)
  concurrencyTracker.releaseAllForRun('other-reader')
  assert.equal(concurrencyTracker.acquire('reader', file, 'write').conflict, null)
  assert.equal(concurrencyTracker.acquire('reader', fileAlias, 'read').conflict, null)
  assert.equal(concurrencyTracker.getActiveFiles().length, 1, 'same-run aliases share a lease')
  assert.equal(concurrencyTracker.getActiveFiles()[0].mode, 'write', 'read must not downgrade a write lease')
  assert.equal(concurrencyTracker.acquire('other-writer', 'other.ts', 'write', alias).conflict, null)
  concurrencyTracker.releaseAllForRun('reader')
  assert.deepEqual(concurrencyTracker.getActiveFiles().map(l => l.runId), ['other-writer'])
  assert.equal(concurrencyTracker.acquire('next-writer', fileAlias, 'write').conflict, null)
})

test('Hermes learning signals differentiate urgency and category for closed-loop reflection', () => {
  const run = (id, patch = {}) => ({ id, prompt: 'Fix backend endpoint', result: 'done', status: 'succeeded', provider: 'codex', cwd: '/tmp', trigger: 'ui', ...patch })
  const calls = n => Array.from({ length: n }, (_, i) => ({ type: 'tool_call', data: { name: 'shell', input: { command: `step ${i}` } } }))

  // Standard substantial task -> normal urgency
  const sub = policy.learningSignalWithUrgency(run('1'), calls(12), 5, false, false)
  assert.ok(sub)
  assert.equal(sub.urgency, 'normal')
  assert.equal(sub.category, 'substantial_procedure')

  // User correction -> high urgency (Hermes expedited reflection)
  const corrected = [{ type: 'user', data: { text: 'Fix backend endpoint' } }, { type: 'user', data: { text: 'No, that was wrong, use port 8080 instead', steering: true } }]
  const corr = policy.learningSignalWithUrgency(run('2'), corrected, 5, false, false)
  assert.ok(corr)
  assert.equal(corr.urgency, 'high')
  assert.equal(corr.category, 'user_correction')

  // Broken skill -> high urgency
  const broken = policy.learningSignalWithUrgency(run('3', { status: 'failed' }), calls(5), 5, true, false)
  assert.ok(broken)
  assert.equal(broken.urgency, 'high')
  assert.equal(broken.category, 'skill_defect')

  // Recovered one-off tool failure -> queued for the normal batch, not an immediate review
  const recov = policy.learningSignalWithUrgency(run('4'), [...calls(5), { type: 'tool_result', data: { isError: true, output: 'err' } }], 5, false, false)
  assert.ok(recov)
  assert.equal(recov.urgency, 'normal')
  assert.equal(recov.category, 'tool_failure_recovery')
})

test('Hermes skill utility and health evaluation classifies performance and actionable recommendations', () => {
  const report = skillUsage.evaluateSkills()
  assert.equal(report.length, 4)

  const good = report.find(r => r.name === 'good-skill')
  assert.equal(good.health, 'healthy')
  assert.equal(good.recommendation, 'keep')
  assert.equal(good.successRate, 0.9)

  const fragile = report.find(r => r.name === 'fragile-skill')
  assert.equal(fragile.health, 'at_risk')
  assert.equal(fragile.recommendation, 'patch')
  assert.equal(fragile.successRate, 0.5)

  const failing = report.find(r => r.name === 'failing-skill')
  assert.equal(failing.health, 'failing')
  assert.equal(failing.recommendation, 'review')
  assert.equal(failing.successRate, 0.2)

  const unused = report.find(r => r.name === 'unused-skill')
  assert.equal(unused.health, 'untested')
  assert.equal(unused.recommendation, 'keep')
  assert.equal(unused.successRate, null)
})

test('Jcode swarm ops and Hermes evaluation are exposed in ops registry', async () => {
  const opsModule = await loadModule('src/main/ops.ts', {
    './runs': {
      startRun: () => ({ id: 'sub-1', status: 'queued', title: 'Subtask' }),
      waitForRun: async (id) => ({ id, status: 'succeeded', result: 'task completed', error: null }),
      activeRunIds: () => [],
      cancelRun: () => true,
      resolveApproval: () => null,
      instantReply: () => ({}),
      sendMessage: async () => ({ run: {}, steered: false }),
      steerRun: async () => ({}),
      runKind: () => 'task',
      pauseRunAdmissions: () => true,
      resumeRunAdmissions: () => {},
      inRunProfile: (_id, _token, fn) => fn(),
      runGate: () => null
    },
    './concurrency-tracker': { concurrencyTracker },
    './skill-usage': skillUsage
  })

  // runs_batch
  assert.ok(opsModule.ops.runs_batch)
  const batchResult = await opsModule.ops.runs_batch.handler({
    tasks: [
      { prompt: 'Analyze module A', scopedContext: true },
      { prompt: 'Analyze module B', scopedContext: true }
    ],
    wait: true
  }, { actor: 'agent', runId: 'parent-1' })
  assert.equal(batchResult.runs.length, 2)
  assert.equal(batchResult.runs[0].status, 'succeeded')

  // runs_wait_many
  assert.ok(opsModule.ops.runs_wait_many)
  const waitManyResult = await opsModule.ops.runs_wait_many.handler({ ids: ['sub-1', 'sub-2'] }, { actor: 'agent' })
  assert.equal(waitManyResult.runs.length, 2)

  // runs_active_files
  assert.ok(opsModule.ops.runs_active_files)
  const activeFiles = opsModule.ops.runs_active_files.handler({}, { actor: 'agent' })
  assert.ok(Array.isArray(activeFiles.activeFiles))
  assert.ok(Array.isArray(activeFiles.conflicts))

  // skills_evaluate
  assert.ok(opsModule.ops.skills_evaluate)
  const evalResult = opsModule.ops.skills_evaluate.handler({}, { actor: 'agent' })
  assert.ok(evalResult.length >= 4)
})

test('a caller mistake is returned without becoming a harness fault; a crashing handler still is one', async () => {
  const recorded = []
  const { invoke } = await loadModule('src/main/ops.ts', {
    './faults': { recordFault: (fault) => { recorded.push(fault.source) }, listFaults: () => [], updateFault: () => null, faultDue: () => false },
    './runs': { runKind: () => 'task', activeRunIds: () => [], cancelRun() {}, resolveApproval() {}, instantReply() {}, sendMessage() {}, startRun() {}, steerRun() {}, waitForRun() {}, pauseRunAdmissions() {}, resumeRunAdmissions() {}, inRunProfile() {}, runGate() {} }
  })
  await assert.rejects(invoke('models_set', { provider: 'claude' }, { actor: 'user' }), { name: 'UsageError', message: /Nothing to change/ })
  assert.deepEqual(recorded, [])
  await assert.rejects(invoke('runs_get', { id: 'x' }, { actor: 'user' }), /Database is not open/)
  assert.deepEqual(recorded, ['op:runs_get'])
})
