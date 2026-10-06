import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execute, atomic, read } from '../resources/updater/worker.mjs'
const commit = 'b'.repeat(40)
function fixture(t, { badProbe = false, badChecks = false, healthy = true, staleHealth = false, liveCaller = false, staleHandoff = false, reopen } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-worker-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const job = { id: 'test-job', directory, source: '/source', target: join(directory, 'Jarvis.app'), commit, appName: 'Jarvis', serviceLabel: 'test', uid: 501, reopen: true, environment: {} }
  mkdirSync(job.target); writeFileSync(join(job.target, 'version'), 'old')
  let started = 0, sawReady = false
  const commands = []
  const api = {
    alive: pid => pid === 9876 || liveCaller && pid === 1234,
    sleep: async () => {
      const state = read(join(directory, 'state.json'))
      if (state.phase === 'ready') { sawReady = true; assert.equal(readFileSync(join(job.target, 'version'), 'utf8'), 'old'); atomic(join(directory, 'handoff.json'), { jobId: job.id, commit, pid: 1234, at: staleHandoff ? 0 : Date.now(), reopen }) }
    },
    run: async (cmd, args) => {
      commands.push([cmd, args])
      if (cmd === 'npm' && args[1] === 'check' && badChecks) throw new Error('Regression checks failed')
      if (cmd.endsWith('electron-builder')) {
        const app = join(directory, 'source/dist/mac-arm64/Jarvis.app')
        mkdirSync(join(app, 'Contents/MacOS'), { recursive: true }); writeFileSync(join(app, 'Contents/MacOS/Jarvis'), '')
        writeFileSync(join(app, 'version'), 'new')
      }
      if (cmd === '/usr/bin/env' && badProbe) throw new Error("Cannot find module 'undici'")
      if (cmd === '/usr/bin/ditto') cpSync(args[0], args[1], { recursive: true })
      if (cmd === '/bin/bash') {
        started++
        if (healthy && readFileSync(join(job.target, 'version'), 'utf8') === 'new') atomic(join(directory, 'health.json'), { jobId: staleHealth ? 'other-job' : job.id, commit, healthy: true, pid: 9876 })
      }
      return ''
    }
  }
  return { job, api, commands, started: () => started, sawReady: () => sawReady }
}
test('independent worker probes, waits for handoff, swaps and accepts transaction-specific health', async t => {
  const f = fixture(t)
  const result = await execute(f.job, f.api)
  assert.equal(result.phase, 'succeeded'); assert.equal(f.sawReady(), true)
  assert.equal(readFileSync(join(f.job.target, 'version'), 'utf8'), 'new')
  assert.equal(readFileSync(join(f.job.target + '.previous-test-job', 'version'), 'utf8'), 'old')
  assert.ok(f.commands.some(([cmd]) => cmd === '/usr/bin/env'))
  const check = f.commands.findIndex(([cmd, args]) => cmd === 'npm' && args[1] === 'check')
  const build = f.commands.findIndex(([cmd]) => cmd.endsWith('electron-vite'))
  assert.ok(check >= 0 && check < build)
  assert.equal(f.started(), 1)
})
test('failed regression checks stop the update before building or handoff', async t => {
  const f = fixture(t, { badChecks: true })
  const result = await execute(f.job, f.api)
  assert.equal(result.phase, 'failed'); assert.match(result.message, /Regression checks failed/)
  assert.equal(readFileSync(join(f.job.target, 'version'), 'utf8'), 'old')
  assert.equal(f.sawReady(), false); assert.equal(f.started(), 0)
  assert.ok(!f.commands.some(([cmd]) => cmd.endsWith('electron-builder') || cmd === '/usr/bin/env'))
})

for (const reopen of [false, true]) for (const healthy of [false, true]) test(`worker uses handoff reopen=${reopen} for ${healthy ? 'install' : 'rollback'}, not its queued snapshot`, async t => {
  const f = fixture(t, { reopen, healthy })
  f.job.reopen = !reopen
  const result = await execute(f.job, f.api)
  assert.equal(result.phase, healthy ? 'succeeded' : 'rolled-back')
  const starts = f.commands.filter(([cmd]) => cmd === '/bin/bash')
  assert.equal(starts.length, healthy ? 1 : 2)
  for (const [, args] of starts) assert.equal(args[2], reopen ? '1' : '0')
})
test('a missing bundled dependency fails before handoff and leaves the working app untouched', async t => {
  const f = fixture(t, { badProbe: true })
  const result = await execute(f.job, f.api)
  assert.equal(result.phase, 'failed'); assert.match(result.message, /undici/)
  assert.equal(readFileSync(join(f.job.target, 'version'), 'utf8'), 'old')
  assert.equal(f.sawReady(), false); assert.equal(f.started(), 0)
})
for (const staleHealth of [false, true]) test(`failed health rolls back without accepting ${staleHealth ? 'another transaction' : 'missing health'}`, async t => {
  const f = fixture(t, { healthy: staleHealth, staleHealth })
  const result = await execute(f.job, f.api)
  assert.equal(result.phase, 'rolled-back')
  assert.equal(readFileSync(join(f.job.target, 'version'), 'utf8'), 'old')
  assert.equal(f.started(), 2)
})
test('a caller that fails to exit is never killed or replaced', async t => {
  const f = fixture(t, { liveCaller: true })
  const result = await execute(f.job, f.api)
  assert.equal(result.phase, 'failed'); assert.match(result.message, /did not exit/)
  assert.equal(readFileSync(join(f.job.target, 'version'), 'utf8'), 'old')
  assert.ok(!f.commands.some(([cmd]) => cmd === '/bin/kill'))
})
test('worker restart repairs a crash between the two app renames', async t => {
  const f = fixture(t)
  const { renameSync } = await import('node:fs')
  renameSync(f.job.target, f.job.target + '.previous-test-job')
  atomic(join(f.job.directory, 'state.json'), { phase: 'installing' })
  const result = await execute(f.job, f.api)
  assert.equal(result.phase, 'rolled-back'); assert.equal(existsSync(f.job.target), true)
  assert.equal(readFileSync(join(f.job.target, 'version'), 'utf8'), 'old')
})
test('a stale handoff from an exited app never triggers replacement', async t => {
  const f = fixture(t, { staleHandoff: true })
  let waits = 0
  const sleep = f.api.sleep
  f.api.sleep = async () => { await sleep(); if (++waits > 5) throw new Error('still waiting for a fresh handoff') }
  const result = await execute(f.job, f.api)
  assert.equal(result.phase, 'failed'); assert.match(result.message, /fresh handoff/)
  assert.equal(readFileSync(join(f.job.target, 'version'), 'utf8'), 'old')
  assert.ok(!f.commands.some(([cmd, args]) => cmd === '/bin/launchctl' && args[0] === 'bootout'))
})
test('worker restart during verification waits for the new app instead of rolling back', async t => {
  const f = fixture(t)
  const { renameSync } = await import('node:fs')
  renameSync(f.job.target, f.job.target + '.previous-test-job')
  mkdirSync(f.job.target); writeFileSync(join(f.job.target, 'version'), 'new')
  atomic(join(f.job.directory, 'state.json'), { phase: 'verifying' })
  let checks = 0
  f.api.sleep = async () => { if (++checks === 3) atomic(join(f.job.directory, 'health.json'), { jobId: f.job.id, commit, healthy: true, pid: 9876 }) }
  const result = await execute(f.job, f.api)
  assert.equal(result.phase, 'succeeded')
  assert.equal(readFileSync(join(f.job.target, 'version'), 'utf8'), 'new')
})
test('success prunes bundles from older update jobs but keeps this rollback copy', async t => {
  const f = fixture(t)
  for (const old of ['.previous-old-job', '.failed-old-job', '.updating-old-job']) mkdirSync(f.job.target + old)
  const result = await execute(f.job, f.api)
  assert.equal(result.phase, 'succeeded')
  for (const old of ['.previous-old-job', '.failed-old-job', '.updating-old-job']) assert.equal(existsSync(f.job.target + old), false)
  assert.equal(existsSync(f.job.target + '.previous-test-job'), true)
})
