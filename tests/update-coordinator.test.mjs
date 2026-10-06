import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { loadModule } from './load-module.mjs'
import { atomic, read } from '../resources/updater/worker.mjs'
const old = 'a'.repeat(40), next = 'b'.repeat(40)
async function fixture(t, { realGit = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-coordinator-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.git'))
  globalThis.__BUILD_COMMIT__ = old; globalThis.__SOURCE_DIR__ = root
  const resources = process.resourcesPath; process.resourcesPath = resolve('resources'); t.after(() => { process.resourcesPath = resources })
  let active = ['caller'], pending = 0, quit = 0, notesBusy = false, loginBusy = false, visible = false, resumes = 0
  const detached = [], pauses = [], delivered = [], notifications = []
  const mock = {
    electron: { app: { isPackaged: true, getName: () => 'Jarvis', quit: () => { quit++ } }, BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, isVisible: () => visible }] }, Notification: class { constructor(opts) { notifications.push(opts) } show() {} } },
    'node:child_process': { execFile: (cmd, args, opts, cb) => realGit
      ? execFile(cmd, args, opts, (error, stdout, stderr) => cb(error, { stdout, stderr }))
      : cb(null, { stdout: args[0] === 'rev-parse' ? next : args[0] === 'log' ? next + '\tFix packaging' : '', stderr: '' }) },
    './paths': { paths: { data: root, backups: root }, expandHome: p => p, loginEnv: () => ({ SECRET: 'must-not-persist', HOME: root }), resolveLoginPath: () => '/usr/bin', which: () => '/node' },
    './config': { cfg: () => ({ update: { sourceDir: root, branch: 'main', auto: true } }) },
    './db': { audit() {}, getRun: () => ({ trigger: 'imessage', conversationKey: 'imessage:chat' }), kvGet() {}, kvSet() {} },
    './runs': { activeRunIds: () => active, pauseRunAdmissions: (_reason, force) => { pauses.push(force); return !active.length }, resumeRunAdmissions() { resumes++ } },
    './maintenance': { pendingCompletions: () => pending },
    './notes': { notesBusyForUpdate: () => notesBusy },
    './provider-login': { loginsBusyForUpdate: () => loginBusy },
    './recovery': { replyTarget: () => ({ gateway: 'imessage', target: 'chat' }) },
    './gateways': { deliver: async (...args) => delivered.push(args) },
    './control': { controlListening: () => true },
    './bus': { bus: new EventEmitter() },
    './signing': { localSigningIdentity: async () => ({ hash: 'sign', keychain: '/keychain' }) },
    './system': { appBundlePath: () => join(root, 'Jarvis.app'), SELF_LABEL: 'test', START_JARVIS_SH: 'start_jarvis() { :; }', runDetached: async (...args) => detached.push(args) }
  }
  const updater = await loadModule('src/main/updater.ts', mock)
  const job = () => read(join(root, 'updater/jobs', read(join(root, 'updater/current.json')).id, 'job.json'))
  const phase = (name, workerPid = process.pid) => { const j = job(); atomic(join(j.directory, 'state.json'), { jobId: j.id, commit: j.commit, phase: name, message: name, workerPid, updatedAt: Date.now() }) }
  return { root, updater, mock, job, phase, detached, pauses, delivered, notifications, quit: () => quit, resumes: () => resumes, active: v => active = v, pending: v => pending = v, notesBusy: v => notesBusy = v, loginBusy: v => loginBusy = v, visible: v => visible = v }
}

for (const unknown of [false, true]) test(`UPDATE pins the fresh remote tip with restricted fetch config and ${unknown ? 'unknown' : 'three-commits-behind'} installed build`, async t => {
  const f = await fixture(t, { realGit: true })
  const git = (...args) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(f.root, 'release'), 'installed'); git('add', 'release'); git('commit', '-m', 'installed')
  const installed = git('rev-parse', 'HEAD')
  const remote = join(f.root, 'remote.git')
  git('init', '--bare', remote); git('remote', 'add', 'origin', remote)
  git('push', 'origin', 'main:main', 'main:other')
  git('config', 'remote.origin.fetch', '+refs/heads/other:refs/remotes/origin/other')
  // Leave origin/main stale even though the remote and checkout HEAD advance.
  for (let i = 1; i <= 3; i++) {
    writeFileSync(join(f.root, 'release'), `release ${i}`); git('commit', '-am', `release ${i}`)
  }
  const latest = git('rev-parse', 'HEAD')
  git('push', remote, 'main:main')
  assert.equal(git('rev-parse', 'origin/main'), installed)
  globalThis.__BUILD_COMMIT__ = unknown ? 'unknown' : installed
  const updater = await loadModule('src/main/updater.ts', f.mock)
  const checked = await updater.checkForUpdates()
  assert.equal(checked.state, 'available'); assert.equal(checked.remoteCommit, latest)
  if (!unknown) assert.equal(checked.behind.length, 3)
  const result = await updater.applyUpdate({ actor: 'user' })
  assert.equal(result.phase, 'queued'); assert.equal(f.job().commit, latest)
  assert.equal(git('rev-parse', 'HEAD'), latest)
})
test('update returns a durable ticket while caller is active; force cannot cancel the caller or its final reply', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const f = await fixture(t)
  const result = await f.updater.applyUpdate({ actor: 'agent', callerRunId: 'caller', force: true })
  assert.equal(result.phase, 'queued'); assert.ok(result.jobId); assert.equal(f.detached.length, 1)
  assert.equal(f.job().environment.SECRET, undefined)
  assert.equal((await f.updater.applyUpdate({ actor: 'agent' })).jobId, result.jobId)
  assert.equal(f.detached.length, 1)
  f.phase('ready'); await f.updater.pollUpdateJob(); assert.equal(f.quit(), 0)
  f.active([]); f.pending(1); await f.updater.pollUpdateJob(); assert.equal(f.pauses.length, 0)
  f.pending(0); f.notesBusy(true); await f.updater.pollUpdateJob(); assert.equal(f.pauses.length, 0)
  f.notesBusy(false); t.mock.timers.tick(1); await f.updater.pollUpdateJob()
  t.mock.timers.tick(5000); await f.updater.pollUpdateJob(); t.mock.timers.tick(100)
  assert.deepEqual(f.pauses, [false]); assert.equal(f.quit(), 1)
  assert.equal(read(join(f.job().directory, 'handoff.json')).jobId, result.jobId)
})
test('new process reads the same job and reports completion once to the originating chat', async t => {
  const f = await fixture(t)
  await f.updater.applyUpdate({ actor: 'agent', callerRunId: 'caller' }); f.phase('succeeded')
  const restarted = await loadModule('src/main/updater.ts', f.mock)
  await restarted.pollUpdateJob(); await restarted.pollUpdateJob()
  assert.equal(restarted.getUpdateStatus().phase, 'succeeded')
  assert.equal(f.notifications.length, 1); assert.equal(f.delivered.length, 1)
  assert.deepEqual(f.delivered[0].slice(0, 2), ['imessage', 'chat'])
})

for (const visible of [false, true]) test(`automatic update waits for login and preserves ${visible ? 'visible' : 'hidden'} window at handoff`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const f = await fixture(t)
  await f.updater.applyUpdate({ actor: 'system' })
  assert.equal(f.job().reopen, false)
  f.active([]); f.phase('ready'); f.loginBusy(true)
  await f.updater.pollUpdateJob(); t.mock.timers.tick(6000); await f.updater.pollUpdateJob()
  assert.equal(f.quit(), 0); assert.equal(f.pauses.length, 0)
  f.loginBusy(false); f.visible(visible)
  await f.updater.pollUpdateJob(); t.mock.timers.tick(5000); await f.updater.pollUpdateJob(); t.mock.timers.tick(100)
  assert.equal(f.quit(), 1)
  assert.equal(read(join(f.job().directory, 'handoff.json')).reopen, visible)
})
test('new build supplies both transaction health and the legacy installer health marker', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t)
  await f.updater.applyUpdate({ actor: 'user' }); f.phase('verifying')
  globalThis.__BUILD_COMMIT__ = next
  const restarted = await loadModule('src/main/updater.ts', f.mock)
  restarted.markHealthy()
  assert.equal(read(join(f.job().directory, 'health.json')).healthy, false)
  t.mock.timers.tick(20000)
  assert.equal(read(join(f.job().directory, 'health.json')).healthy, true)
  assert.equal(readFileSync(join(f.job().directory, '../../healthy'), 'utf8'), next)
})
test('Jarvis never quits for a dead worker, and resumes work if the worker fails after handoff', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const f = await fixture(t)
  await f.updater.applyUpdate({ actor: 'user' }); f.active([])
  f.phase('ready', 2 ** 22 + 1)
  const handoff = join(f.job().directory, 'handoff.json')
  atomic(handoff, { jobId: f.job().id, commit: next, pid: 1, at: 0 })
  for (let i = 0; i < 3; i++) { await f.updater.pollUpdateJob(); t.mock.timers.tick(6000) }
  assert.equal(f.quit(), 0); assert.equal(f.pauses.length, 0); assert.equal(read(handoff), null)
  f.phase('ready')
  await f.updater.pollUpdateJob(); t.mock.timers.tick(6000); await f.updater.pollUpdateJob(); t.mock.timers.tick(100)
  assert.equal(f.quit(), 1)
  const before = f.resumes()
  f.phase('failed'); await f.updater.pollUpdateJob()
  assert.ok(f.resumes() > before)
})
