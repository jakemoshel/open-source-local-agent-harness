// A one-shot launchd job. Uses only Node built-ins; never imports the running app.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function atomic(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.tmp'
  const fd = openSync(tmp, 'w', 0o600)
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, file)
  const dir = openSync(dirname(file), 'r')
  try { fsyncSync(dir) } finally { closeSync(dir) }
}
export function read(file) { try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
export const terminal = phase => ['succeeded', 'rolled-back', 'failed'].includes(phase)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

export async function execute(job, overrides = {}) {
  const dir = job.directory
  const stateFile = join(dir, 'state.json')
  const staged = `${job.target}.updating-${job.id}`
  const previous = `${job.target}.previous-${job.id}`
  const failed = `${job.target}.failed-${job.id}`
  const checkout = join(dir, 'source')
  const healthFile = join(dir, 'health.json')
  let state = read(stateFile) ?? { phase: 'queued' }
  const command = promisify(execFile)
  const api = {
    sleep, alive,
    run: async (cmd, args, cwd = dir, timeout = 20 * 60000) => {
      const { stdout } = await command(cmd, args, { cwd, env: { ...job.environment, CI: '1', GIT_TERMINAL_PROMPT: '0', CSC_IDENTITY_AUTO_DISCOVERY: 'false', JARVIS_BUILD_COMMIT: job.commit, JARVIS_SOURCE_DIR: job.source }, timeout, maxBuffer: 8 * 1024 ** 2 })
      return stdout.trim()
    },
    ...overrides
  }
  const set = (phase, message) => {
    state = { ...state, jobId: job.id, commit: job.commit, phase, message, workerPid: process.pid, updatedAt: Date.now() }
    atomic(stateFile, state)
  }
  const start = () => api.run('/bin/bash', [join(dir, 'start.sh'), job.target, (read(join(dir, 'handoff.json'))?.reopen ?? job.reopen) ? '1' : '0'], dir, 30000)
  const stop = async () => {
    await api.run('/bin/launchctl', ['bootout', `gui/${job.uid}/${job.serviceLabel}`], dir, 15000).catch(() => undefined)
    // Read the PID published by the app's control/health handshake. No broad pkill patterns.
    const health = read(healthFile)
    if (health?.pid && health.commit === job.commit && api.alive(health.pid)) {
      await api.run('/bin/kill', ['-TERM', String(health.pid)], dir, 5000).catch(() => undefined)
      for (let i = 0; i < 20 && api.alive(health.pid); i++) await api.sleep(250)
      if (api.alive(health.pid)) await api.run('/bin/kill', ['-KILL', String(health.pid)], dir, 5000)
    }
  }
  const rollback = async message => {
    if (!existsSync(previous)) throw new Error('Previous app is missing; automatic rollback requires repair')
    await stop()
    if (existsSync(job.target)) renameSync(job.target, failed)
    renameSync(previous, job.target)
    set('rolled-back', message)
    await start()
  }
  const healthy = () => { const h = read(healthFile); return h?.jobId === job.id && h.commit === job.commit && h.healthy && api.alive(h.pid) }
  const awaitHealth = async () => {
    for (let i = 0; i < 90; i++) { if (healthy()) return true; await api.sleep(2000) }
    return false
  }
  const succeed = () => {
    set('succeeded', `Updated to ${job.commit.slice(0, 7)}`)
    // Keep only this job's previous bundle for manual rollback.
    const base = basename(job.target), keep = new Set([basename(previous)])
    for (const name of readdirSync(dirname(job.target))) {
      if (!keep.has(name) && (name.startsWith(`${base}.previous-`) || name.startsWith(`${base}.failed-`) || name.startsWith(`${base}.updating-`))) rmSync(join(dirname(job.target), name), { recursive: true, force: true })
    }
    rmSync(checkout, { recursive: true, force: true })
  }
  if (terminal(state.phase)) return state
  try {
    // An interrupted rename sequence is resolved before any new build or install.
    if (['installing', 'verifying'].includes(state.phase)) {
      if (existsSync(previous)) {
        // The new app may still be inside its health window; give it the full window before rolling back.
        if (state.phase === 'verifying' && existsSync(job.target) && !existsSync(staged)) {
          if (!read(healthFile)) await start().catch(() => undefined)
          if (await awaitHealth()) { succeed(); return state }
        }
        await rollback('The interrupted update was rolled back to the previous app.')
        return state
      }
      // No backup means the first rename never occurred. Do not quit a new app instance.
      set('ready', 'Build ready; waiting for Jarvis to finish active work')
      rmSync(join(dir, 'handoff.json'), { force: true })
    }
    if (state.phase !== 'ready') {
      set('building', 'Preparing a clean snapshot of the selected commit')
      if (!/^[a-f0-9]{40}$/.test(job.commit)) throw new Error('Invalid update commit')
      await api.run('git', ['cat-file', '-e', `${job.commit}^{commit}`], job.source)
      rmSync(checkout, { recursive: true, force: true }); mkdirSync(checkout, { recursive: true, mode: 0o700 })
      await api.run('git', ['archive', '--format=tar', '--output', join(dir, 'source.tar'), job.commit], job.source)
      await api.run('/usr/bin/tar', ['-xf', join(dir, 'source.tar'), '-C', checkout])
      rmSync(join(dir, 'source.tar'), { force: true })
      set('building', 'Installing dependencies in the isolated build directory')
      await api.run('npm', ['ci', '--no-audit', '--no-fund'], checkout)
      set('building', 'Running type checks and regression tests before packaging')
      await api.run('npm', ['run', 'check'], checkout)
      set('building', 'Building the new app; Jarvis remains available')
      await api.run(join(checkout, 'node_modules/.bin/electron-vite'), ['build'], checkout)
      const args = ['--mac', '--arm64', '--dir', '--publish', 'never']
      const electronDist = join(checkout, 'node_modules/electron/dist')
      if (existsSync(join(electronDist, 'Electron.app'))) args.push(`-c.electronDist=${electronDist}`)
      if (job.signingIdentity) args.push(`-c.mac.identity=${job.signingIdentity}`)
      await api.run(join(checkout, 'node_modules/.bin/electron-builder'), args, checkout)
      const built = join(checkout, 'dist/mac-arm64', `${job.appName}.app`)
      if (!existsSync(join(built, 'Contents/MacOS', job.appName))) throw new Error('Build did not produce the expected application')
      if (!job.signingIdentity) {
        await api.run('/usr/bin/xattr', ['-cr', built])
        const sign = job.localSigning ? ['--sign', job.localSigning.hash, '--keychain', job.localSigning.keychain] : ['--sign', '-']
        await api.run('/usr/bin/codesign', ['--force', '--deep', ...sign, built])
      }
      await api.run('/usr/bin/codesign', ['--verify', '--deep', built])
      set('building', 'Checking packaged dependencies with the packaged runtime')
      await api.run('/usr/bin/env', ['ELECTRON_RUN_AS_NODE=1', join(built, 'Contents/MacOS', job.appName), join(built, 'Contents/Resources/updater/probe.cjs')], dir, 60000)
      rmSync(staged, { recursive: true, force: true })
      await api.run('/usr/bin/ditto', [built, staged])
      await api.run('/usr/bin/codesign', ['--verify', '--deep', staged])
      set('ready', 'Build ready; waiting for Jarvis to finish active work')
    }
    let handoff
    for (;;) {
      handoff = read(join(dir, 'handoff.json'))
      // A handoff is only valid while fresh or while its issuer is still exiting; a stale one never stops a live app.
      if (handoff?.jobId === job.id && handoff.commit === job.commit && Number.isInteger(handoff.pid) && handoff.pid > 0 && (api.alive(handoff.pid) || Date.now() - (handoff.at ?? 0) < 60000)) break
      await api.sleep(1000)
    }
    // Handoff is issued only after runs and deliveries have drained. Unload
    // KeepAlive before waiting so it cannot race us by relaunching the old app.
    await api.run('/bin/launchctl', ['bootout', `gui/${job.uid}/${job.serviceLabel}`], dir, 15000).catch(() => undefined)
    for (let i = 0; i < 120 && api.alive(handoff.pid); i++) await api.sleep(500)
    if (api.alive(handoff.pid)) throw new Error('Jarvis did not exit after handoff; app replacement was cancelled')
    if (!existsSync(job.target) || !existsSync(staged)) throw new Error('App or staged build is missing; refusing replacement')
    if (existsSync(previous)) throw new Error('Backup path already exists; refusing to overwrite it')
    set('installing', 'Installing the verified build')
    renameSync(job.target, previous)
    try { renameSync(staged, job.target) } catch (e) { renameSync(previous, job.target); throw e }
    set('verifying', 'Waiting for the new app to report healthy')
    await start()
    if (await awaitHealth()) { succeed(); return state }
    await rollback('The new app failed its health check. The previous version was restored.')
  } catch (e) {
    if (existsSync(previous) && ['installing', 'verifying'].includes(state.phase)) {
      try { await rollback('Installation failed. The previous version was restored.'); return state } catch { /* Preserve all bundles for repair. */ }
    }
    set('failed', String(e.message ?? e).slice(0, 2000))
    rmSync(checkout, { recursive: true, force: true })
    rmSync(staged, { recursive: true, force: true })
    // If the app already handed off, bring it back even when staging/swap failed.
    if (read(join(dir, 'handoff.json')) && existsSync(job.target)) await start().catch(() => undefined)
  }
  return state
}

export async function main(file) {
  const job = read(file)
  if (!job || resolve(job.directory) !== dirname(resolve(file))) throw new Error('Invalid updater job')
  const lock = join(job.directory, 'worker.lock')
  if (existsSync(lock)) {
    const owner = read(lock)
    if (owner?.pid && alive(owner.pid)) return
    rmSync(lock)
  }
  const fd = openSync(lock, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); fsyncSync(fd) } finally { closeSync(fd) }
  try { await execute(job) } finally { rmSync(lock, { force: true }) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1 })
}
