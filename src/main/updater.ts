import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { currentUpdate, finishedUpdate, readUpdateFile, updateRoot, writeUpdateFile, type UpdateJob, type UpdateJobState } from './update-jobs'
import { pendingCompletions } from './maintenance'
import { loginsBusyForUpdate } from './provider-login'
import { deliver } from './gateways'
import { replyTarget } from './recovery'
import { execFile } from 'node:child_process'
import { existsSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow, Notification } from 'electron'
import type { UpdateStatus } from '@shared/types'
import { bus } from './bus'
import { cfg } from './config'
import { audit, getRun, kvGet, kvSet } from './db'
import { expandHome, loginEnv, resolveLoginPath, which } from './paths'
import { activeRunIds, pauseRunAdmissions, resumeRunAdmissions } from './runs'
import { controlListening } from './control'
import { appBundlePath, runDetached, SELF_LABEL, START_JARVIS_SH } from './system'
import { localSigningIdentity } from './signing'
import { syncLocalBranch } from './local-branch'

declare const __BUILD_COMMIT__: string
declare const __SOURCE_DIR__: string

const run = promisify(execFile)
const HEALTHY_AFTER = 20_000

const status: UpdateStatus = {
  state: 'idle',
  currentCommit: __BUILD_COMMIT__,
  remoteCommit: null,
  behind: [],
  sourceDir: '',
  auto: true,
  lastCheck: null,
  message: null,
  waitingForRuns: 0,
  signed: false
}

let busy = false
let stopped = true
let timer: NodeJS.Timeout | null = null
let monitor: NodeJS.Timeout | null = null
let enqueue: Promise<UpdateStatus> | null = null
let polling = false
let lastLaunch = 0
let idleSince = 0
let handingOff = false
/** A finished job whose notices are settled needs nothing more; a new job writes a new ID to current.json. */
let settledJob: string | null = null

export function sourceDir(): string {
  return expandHome(cfg().update.sourceDir || __SOURCE_DIR__)
}


export function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...loginEnv(), PATH: resolveLoginPath(), CI: '1', GIT_TERMINAL_PROMPT: '0' }
  for (const k of Object.keys(env)) if (k.startsWith('ELECTRON_') || k === 'NODE_OPTIONS') delete env[k]
  if (!cfg().update.signingIdentity) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  return env
}

async function sh(cmd: string, args: string[], timeout = 120_000): Promise<string> {
  const { stdout } = await run(cmd, args, { cwd: sourceDir(), env: buildEnv(), timeout, maxBuffer: 64 * 1024 * 1024 })
  return stdout.trim()
}

const git = (...args: string[]) => sh('git', args)

function set(patch: Partial<UpdateStatus>): void {
  Object.assign(status, patch)
  bus.emit('update:status', getUpdateStatus())
}

export function getUpdateStatus(): UpdateStatus {
  const u = cfg().update
  return {
    ...status,
    sourceDir: sourceDir(),
    auto: u.auto,
    signed: !!u.signingIdentity,
    waitingForRuns: status.phase === 'ready' ? activeRunIds().length : 0,
    state: app.isPackaged || status.state !== 'idle' ? status.state : 'unsupported'
  }
}

function errText(err: unknown): string {
  const e = err as { stderr?: string; message?: string }
  const tail = (e.stderr || '').trim().split('\n').slice(-6).join('\n')
  return tail || e.message || String(err)
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  const current = currentUpdate()
  if (current && !finishedUpdate(current.state.phase)) { reflect(current.job, current.state); return getUpdateStatus() }
  if (busy) return getUpdateStatus()
  const dir = sourceDir()
  if (!existsSync(join(dir, '.git'))) {
    set({ state: 'error', message: `No git checkout at ${dir}. Set update.sourceDir in config.json.` })
    return getUpdateStatus()
  }
  busy = true
  set({ state: 'checking', message: null })
  try {
    // Upstream plus this Mac's own self-repair commits; nothing is ever pushed.
    const remote = await syncLocalBranch(dir, cfg().update.branch, buildEnv())
    const known = await git('cat-file', '-e', `${status.currentCommit}^{commit}`).then(
      () => true,
      () => false
    )
    // Checkout HEAD can be newer than the running app. It is never a substitute
    // for an unknown embedded build commit when deciding whether to update.
    const log = await git('log', '--format=%H%x09%s', ...(known ? [`${status.currentCommit}..${remote}`] : ['-n', '20', remote]))
    const behind = log
      ? log.split('\n').map((l) => {
          const [sha, ...rest] = l.split('\t')
          return { sha, subject: rest.join('\t') }
        })
      : []
    set({ state: behind.length ? 'available' : 'idle', remoteCommit: remote, behind, lastCheck: Date.now(), message: behind.length ? null : 'Up to date' })
  } catch (err) {
    set({ state: 'error', message: `Check failed: ${errText(err)}`, lastCheck: Date.now() })
  } finally {
    busy = false
  }
  return getUpdateStatus()
}

/** Queue a durable job and return. Builds and installs never execute inside an agent tool call. */
export function applyUpdate(opts: { actor?: 'user' | 'agent' | 'system'; callerRunId?: string; reply?: UpdateJob['reply'] } = {}): Promise<UpdateStatus> {
  if (!app.isPackaged) return Promise.reject(new Error('Updates require the installed app. In development, build and restart manually.'))
  if (enqueue) return enqueue
  enqueue = queueUpdate(opts).finally(() => { enqueue = null })
  return enqueue
}
async function queueUpdate(opts: { actor?: 'user' | 'agent' | 'system'; callerRunId?: string; reply?: UpdateJob['reply'] }): Promise<UpdateStatus> {
  const existing = currentUpdate()
  if (existing && !finishedUpdate(existing.state.phase)) { reflect(existing.job, existing.state); return getUpdateStatus() }
  await checkForUpdates()
  if (status.state !== 'available' || !status.remoteCommit) return getUpdateStatus()
  const node = which('node')
  if (!node) throw new Error('Node.js is required for the independent update worker')
  const id = randomUUID(), directory = join(updateRoot(), 'jobs', id)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const helper = app.isPackaged ? join(process.resourcesPath, 'updater/worker.mjs') : join(import.meta.dirname, '../../resources/updater/worker.mjs')
  copyFileSync(helper, join(directory, 'worker.mjs'))
  const inherited = buildEnv()
  // Persist only build plumbing, never the owner's login-shell secrets.
  const environment: Record<string, string> = {}
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'PATH']) if (inherited[key] || process.env[key]) environment[key] = String(inherited[key] || process.env[key])
  const caller = opts.callerRunId ? getRun(opts.callerRunId) : null
  const localSigning = cfg().update.signingIdentity ? null : await localSigningIdentity().catch(() => null)
  const job: UpdateJob = {
    id, directory, source: sourceDir(), target: appBundlePath(), commit: status.remoteCommit,
    previousCommit: status.currentCommit, appName: app.getName(), uid: userInfo().uid,
    serviceLabel: SELF_LABEL, reopen: opts.actor !== 'system', createdAt: Date.now(), actor: opts.actor ?? 'system',
    callerRunId: opts.callerRunId, reply: opts.reply ?? (caller ? replyTarget(caller) ?? undefined : undefined),
    signingIdentity: cfg().update.signingIdentity, localSigning, environment
  }
  writeFileSync(join(directory, 'start.sh'), `#!/bin/bash\nset -u\n${START_JARVIS_SH}\nstart_jarvis "$1"\nif [ "$2" = "1" ]; then open -a "$1"; fi\n`, { mode: 0o700 })
  writeUpdateFile(join(directory, 'job.json'), job)
  const state: UpdateJobState = { jobId: id, commit: job.commit, phase: 'queued', message: `Update to ${job.commit.slice(0, 7)} queued. A separate worker will build it; finish your reply normally. Jarvis will restart after active work and replies finish.`, updatedAt: Date.now() }
  writeUpdateFile(join(directory, 'state.json'), state)
  writeUpdateFile(join(updateRoot(), 'current.json'), { id })
  reflect(job, state)
  try { await launchWorker(job, node) }
  catch (err) { writeUpdateFile(join(directory, 'state.json'), { ...state, phase: 'failed', message: errText(err), updatedAt: Date.now() }); await pollUpdateJob() }
  audit(job.actor, 'system', `Queued update ${id} to ${job.commit.slice(0, 7)}`)
  return getUpdateStatus()
}
async function launchWorker(job: UpdateJob, node = which('node')): Promise<void> {
  if (!node) throw new Error('Node.js is missing; cannot resume update worker')
  lastLaunch = Date.now()
  await runDetached('update-worker', 'exec "$1" "$2" "$3"', [node, join(job.directory, 'worker.mjs'), join(job.directory, 'job.json')])
}
function reflect(job: UpdateJob, state: UpdateJobState): void {
  const phase = state.phase
  set({ jobId: job.id, remoteCommit: job.commit, phase, state: phase === 'succeeded' ? 'idle' : phase === 'failed' || phase === 'rolled-back' ? 'error' : phase === 'installing' || phase === 'verifying' ? 'installing' : 'building', message: state.message })
}
const alive = (pid: number | undefined) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }

/** Reconcile durable progress after restarts; hand off only after runs AND their replies drain. */
export async function pollUpdateJob(): Promise<void> {
  if (polling) return
  polling = true
  try {
    const id = readUpdateFile<{ id?: string }>(join(updateRoot(), 'current.json'))?.id
    if (id && id === settledJob) return
    const current = currentUpdate()
    if (!current) return
    const { job, state } = current
    // Only on change: reflecting every second re-emitted update:status (tray rebuild, renderer IPC, fault sweep) for the whole build.
    if (status.jobId !== job.id || status.phase !== state.phase || status.message !== state.message) reflect(job, state)
    if (finishedUpdate(state.phase)) {
      // A worker that failed after our handoff leaves this process running; reopen it for work.
      if (handingOff) handingOff = false
      resumeRunAdmissions()
      if (state.phase === 'rolled-back' && kvGet<string>('update:failedCommit') !== job.commit) kvSet('update:failedCommit', job.commit)
      if (await notifyResult(job, state)) settledJob = job.id
      return
    }
    if (!alive(state.workerPid) && Date.now() - lastLaunch > 30000) await launchWorker(job)
    if (state.phase !== 'ready' || handingOff) { idleSince = 0; return }
    const stale = readUpdateFile<{ pid?: number }>(join(job.directory, 'handoff.json'))
    if (stale && stale.pid !== process.pid) rmSync(join(job.directory, 'handoff.json'), { force: true })
    // Never quit unless a live worker is waiting to install and restart us.
    if (!alive(state.workerPid)) { idleSince = 0; return }
    if (activeRunIds().length || pendingCompletions() || loginsBusyForUpdate()) { idleSince = 0; return }
    if (!idleSince) { idleSince = Date.now(); return }
    if (Date.now() - idleSince < 5000) return
    if (!pauseRunAdmissions('Jarvis is installing an update. Please resend after it restarts.', false)) { idleSince = 0; return }
    // Automatic updates used to close a visible window and relaunch hidden, looking like a random Cmd-Q.
    // Visibility can change while the worker builds, so capture it at handoff, not when the job was queued.
    const reopen = job.reopen || BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isVisible())
    // No await between admission freeze, durable handshake, and quit scheduling.
    writeUpdateFile(join(job.directory, 'handoff.json'), { jobId: job.id, commit: job.commit, pid: process.pid, at: Date.now(), reopen })
    handingOff = true
    audit('system', 'system', `Restarting for update ${job.id.slice(0, 8)} to ${job.commit.slice(0, 7)}; reopen=${reopen}`)
    set({ state: 'installing', message: 'All work and replies finished. Restarting with the prepared update.' })
    setTimeout(() => app.quit(), 100).unref()
  } catch (err) {
    if (!handingOff) resumeRunAdmissions()
    set({ state: 'error', message: errText(err) })
  } finally { polling = false }
}
/** True once nothing is left to send for this job. */
async function notifyResult(job: UpdateJob, state: UpdateJobState): Promise<boolean> {
  const file = join(job.directory, 'notification.json')
  const notice = readUpdateFile<{ desktop?: boolean; chat?: string; retryAt?: number; attempts?: number }>(file) ?? {}
  const title = state.phase === 'succeeded' ? 'Jarvis update completed' : state.phase === 'rolled-back' ? 'Jarvis update rolled back' : 'Jarvis update failed'
  const text = `${title}: ${state.message} (job ${job.id.slice(0, 8)})`
  if (!notice.desktop) {
    new Notification({ title, body: state.message }).show()
    notice.desktop = true; writeUpdateFile(file, notice)
    audit('system', 'system', text)
  }
  if (!job.reply || notice.chat === 'sent' || notice.chat === 'uncertain' || (notice.attempts ?? 0) >= 5) return true
  if ((notice.retryAt ?? 0) > Date.now()) return false
  // Record intent before sending: if we crash after delivery, don't send a duplicate on restart.
  if (notice.chat === 'sending') { notice.chat = 'uncertain'; writeUpdateFile(file, notice); return true }
  notice.chat = 'sending'; notice.attempts = (notice.attempts ?? 0) + 1; writeUpdateFile(file, notice)
  try { await deliver(job.reply.gateway, job.reply.target, text); notice.chat = 'sent' }
  catch (err) {
    notice.chat = (err as { noRetry?: boolean }).noRetry ? 'uncertain' : 'failed'
    notice.retryAt = Date.now() + 60000
  }
  writeUpdateFile(file, notice)
  return notice.chat === 'sent' || notice.chat === 'uncertain'
}

export function markHealthy(): void {
  const current = currentUpdate()
  const job = current && current.job.commit === status.currentCommit && !finishedUpdate(current.state.phase) ? current.job : null
  const health = job ? { jobId: job.id, commit: status.currentCommit, pid: process.pid, healthy: false } : null
  if (job) writeUpdateFile(join(job.directory, 'health.json'), health)
  setTimeout(() => {
    if (!controlListening()) return
    // First upgrade is still launched by the OLD installer, which expects this raw marker.
    mkdirSync(updateRoot(), { recursive: true, mode: 0o700 })
    writeFileSync(join(updateRoot(), 'healthy'), status.currentCommit, { mode: 0o600 })
    if (job) writeUpdateFile(join(job.directory, 'health.json'), { ...health, healthy: true })
  }, HEALTHY_AFTER).unref()
}

async function tick(): Promise<void> {
  if (!app.isPackaged || busy || stopped) return
  await checkForUpdates()
  if (status.state !== 'available' || !cfg().update.auto) return
  if (status.remoteCommit === kvGet<string>('update:failedCommit')) { set({ message: 'This commit previously rolled back; automatic installation is paused.' }); return }
  await applyUpdate({ actor: 'system' })
}
export function startUpdater(): void {
  stopUpdater(); stopped = false
  monitor = setInterval(() => void pollUpdateJob(), 1000); monitor.unref()
  void pollUpdateJob()
  const schedule = () => { if (!stopped) timer = setTimeout(() => void tick().catch(err => set({ state: 'error', message: errText(err) })).finally(schedule), cfg().update.checkHours * 3600000) }
  timer = setTimeout(() => void tick().catch(err => set({ state: 'error', message: errText(err) })).finally(schedule), 120000)
}
export function stopUpdater(): void {
  stopped = true
  if (timer) clearTimeout(timer)
  if (monitor) clearInterval(monitor)
  timer = monitor = null
  // The independent update worker deliberately remains alive.
}
