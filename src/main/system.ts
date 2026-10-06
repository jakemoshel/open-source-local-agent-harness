import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { app, systemPreferences } from 'electron'
import type { PermissionStatus, ServiceInfo } from '@shared/types'
import { cfg, files } from './config'
import { audit } from './db'
import { expandHome, loginEnv, paths } from './paths'
import { allProfiles } from './profiles'

const run = promisify(execFile)
const UID = userInfo().uid
const AGENTS_DIR = join(homedir(), 'Library/LaunchAgents')
export const SELF_LABEL = 'com.macminijarvis.app'

function kindOf(label: string, program: string | null): ServiceInfo['kind'] {
  const s = `${label} ${program ?? ''}`.toLowerCase()
  if (label === SELF_LABEL) return 'jarvis'
  if (s.includes('hermes')) return 'hermes'
  if (s.includes('bluebubbles')) return 'bluebubbles'
  return 'other'
}

/** Async: a synchronous plutil per LaunchAgent blocked the main process once per plist on every Services refresh. */
async function plistJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8', timeout: 5000 })).stdout)
  } catch {
    return null
  }
}

async function launchState(label: string): Promise<{ loaded: boolean; pid: number | null; lastExit: number | null }> {
  try {
    const { stdout } = await run('/bin/launchctl', ['print', `gui/${UID}/${label}`], { timeout: 5000 })
    const pid = /\bpid = (\d+)/.exec(stdout)?.[1]
    const exit = /last exit code = (-?\d+)/.exec(stdout)?.[1]
    return { loaded: true, pid: pid ? Number(pid) : null, lastExit: exit ? Number(exit) : null }
  } catch {
    return { loaded: false, pid: null, lastExit: null }
  }
}

async function disabledSet(): Promise<Set<string>> {
  try {
    const { stdout } = await run('/bin/launchctl', ['print-disabled', `gui/${UID}`], { timeout: 5000 })
    return new Set([...stdout.matchAll(/"([^"]+)" => (?:disabled|true)/g)].map((m) => m[1]))
  } catch {
    return new Set()
  }
}

export async function listServices(all = false): Promise<ServiceInfo[]> {
  const disabled = await disabledSet()
  const plists = existsSync(AGENTS_DIR) ? readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.plist')) : []
  // One launchctl query per agent: run them together rather than one after another.
  const out = (await Promise.all(plists.map(async (f): Promise<ServiceInfo | null> => {
    const path = join(AGENTS_DIR, f)
    const p = await plistJson(path)
    const label = String(p?.Label ?? basename(f, '.plist'))
    const args = (p?.ProgramArguments as string[] | undefined) ?? []
    const program = (p?.Program as string | undefined) ?? args[0] ?? null
    const kind = kindOf(label, [program, ...args].join(' '))
    if (!all && kind === 'other') return null
    return { label, plist: path, program: [program, ...args.slice(1)].filter(Boolean).join(' ') || null, ...(await launchState(label)), disabled: disabled.has(label), kind }
  }))).filter((s): s is ServiceInfo => s !== null)
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label))
}

async function find(label: string): Promise<ServiceInfo> {
  const s = (await listServices(true)).find((x) => x.label === label)
  if (!s) throw new Error(`No LaunchAgent with label ${label} in ~/Library/LaunchAgents`)
  return s
}

export async function serviceAction(label: string, action: 'start' | 'stop' | 'restart' | 'enable' | 'disable'): Promise<ServiceInfo> {
  const s = await find(label)
  const target = `gui/${UID}/${label}`
  const lc = (...args: string[]) => run('/bin/launchctl', args, { timeout: 15_000 })
  switch (action) {
    case 'restart':
      if (s.loaded) await lc('kickstart', '-k', target)
      else await lc('bootstrap', `gui/${UID}`, s.plist!)
      break
    case 'start':
      if (s.disabled) await lc('enable', target)
      if (!s.loaded) await lc('bootstrap', `gui/${UID}`, s.plist!)
      else await lc('kickstart', target)
      break
    case 'stop':
      if (s.loaded) await lc('bootout', target)
      break
    case 'disable':
      if (s.loaded) await lc('bootout', target).catch(() => undefined)
      await lc('disable', target)
      break
    case 'enable':
      await lc('enable', target)
      if (!(await launchState(label)).loaded) await lc('bootstrap', `gui/${UID}`, s.plist!)
      break
  }
  return find(label)
}

export async function restartApp(name: string): Promise<{ restarted: string }> {
  await run('/usr/bin/osascript', ['-e', `tell application ${JSON.stringify(name)} to quit`], { timeout: 20_000 }).catch(() => undefined)
  await new Promise((r) => setTimeout(r, 2000))
  await run('/usr/bin/open', ['-g', '-a', name], { timeout: 20_000 })
  return { restarted: name }
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Run a shell script as its own one-shot launchd job. It outlives this process (launchd kills a job's
 * children when the job exits), which is what restarting or replacing Jarvis needs.
 */
export async function runDetached(name: string, script: string, args: string[]): Promise<void> {
  const label = `${SELF_LABEL}.${name}`
  const dir = join(paths.data, 'jobs')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.sh`)
  writeFileSync(file, `#!/bin/bash\nset -u\n${script}\nlaunchctl bootout "gui/${UID}/${label}" 2>/dev/null\n`, { mode: 0o700 })
  const plist = join(dir, `${label}.plist`)
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${['/bin/bash', file, ...args].map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(join(dir, `${name}.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(join(dir, `${name}.log`))}</string>
</dict>
</plist>
`
  )
  await run('/bin/launchctl', ['bootout', `gui/${UID}/${label}`], { timeout: 15_000 }).catch(() => undefined)
  await run('/bin/launchctl', ['bootstrap', `gui/${UID}`, plist], { timeout: 15_000 })
}

/** Shell snippet: start Jarvis under its LaunchAgent when installed (so crashes restart it), else via open. */
export const START_JARVIS_SH = `start_jarvis() {
  local APP="$1" PLIST="$HOME/Library/LaunchAgents/${SELF_LABEL}.plist" JOB="gui/$(id -u)/${SELF_LABEL}"
  if launchctl print "$JOB" >/dev/null 2>&1; then
    launchctl kickstart -k "$JOB" && return 0
  elif [ -f "$PLIST" ]; then
    launchctl bootstrap "gui/$(id -u)" "$PLIST" && return 0
  fi
  open -g -a "$APP" --args --hidden
}`

export function appBundlePath(): string {
  return dirname(dirname(dirname(process.execPath)))
}

export function scheduleSelfRestart(reason: string, actor: 'user' | 'agent' = 'agent'): { restarting: true } {
  audit(actor, 'system', `Restarting Mac Mini Jarvis: ${reason}`)
  setTimeout(() => {
    if (!app.isPackaged) {
      app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden').concat('--hidden') })
      return app.exit(0)
    }
    const script = `PID="$1"; APP="$2"
${START_JARVIS_SH}
for _ in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
start_jarvis "$APP"`
    runDetached('restart', script, [String(process.pid), appBundlePath()])
      .then(() => app.quit())
      .catch(() => {
        app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden').concat('--hidden') })
        app.exit(0)
      })
  }, 1500)
  return { restarting: true }
}

export function permissionStatus(): PermissionStatus {
  let fullDiskAccess = false
  for (const probe of [join(homedir(), 'Library/Messages/chat.db'), join(homedir(), 'Library/Safari/Bookmarks.plist'), join(homedir(), 'Library/Mail')]) {
    try {
      if (!existsSync(probe)) continue
      if (statSync(probe).isDirectory()) readdirSync(probe)
      else closeSync(openSync(probe, 'r'))
      fullDiskAccess = true
      break
    } catch {
      fullDiskAccess = false
      break
    }
  }
  let accessibility = false
  let screenRecording = false
  try {
    accessibility = systemPreferences.isTrustedAccessibilityClient(false)
    screenRecording = systemPreferences.getMediaAccessStatus('screen') === 'granted'
  } catch {
    // Not available outside macOS; reported as not granted.
  }
  return { fullDiskAccess, accessibility, screenRecording, loginShellEnv: Object.keys(loginEnv()).length, packaged: app.isPackaged, appPath: app.isPackaged ? appBundlePath() : process.execPath }
}

export const SETTINGS_PANES: Record<string, string> = {
  fullDiskAccess: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  loginItems: 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'
}

function selfPlist(): string {
  return join(AGENTS_DIR, `${SELF_LABEL}.plist`)
}

export async function syncKeepAlive(): Promise<string> {
  if (!app.isPackaged) return 'Keep-alive only applies to the installed app'
  const want = cfg().ui.keepAlive
  const path = selfPlist()
  if (want) {
    mkdirSync(AGENTS_DIR, { recursive: true })
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SELF_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>--hidden</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>${xml(join(homedir(), 'Library/Logs/Mac Mini Jarvis/launchd.log'))}</string>
</dict>
</plist>
`
    mkdirSync(join(homedir(), 'Library/Logs/Mac Mini Jarvis'), { recursive: true })
    writeFileSync(path, plist)
    app.setLoginItemSettings({ openAtLogin: false })
    return 'Installed LaunchAgent: from next login, starts automatically and restarts after a crash'
  }
  if (existsSync(path)) unlinkSync(path)
  app.setLoginItemSettings({ openAtLogin: cfg().ui.launchAtLogin })
  return 'Removed LaunchAgent'
}

export async function memoryBackup(): Promise<{ file: string; kept: number; items: string[] }> {
  const dir = join(paths.backups, 'memory')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const file = join(dir, `memory-${stamp}.tgz`)
  const sources = [
    paths.soul,
    paths.memories,
    paths.skills,
    paths.config,
    paths.schedules,
    paths.safeguards,
    paths.mcp,
    ...cfg().memory.contextRoots.map(expandHome)
  ].filter((p) => existsSync(p))
  const rel = sources.map((p) => p.replace(/^\/+/, ''))
  await run('/usr/bin/tar', ['-czf', file, '--exclude', '.git', '--exclude', 'node_modules', '-C', '/', ...rel], { timeout: 10 * 60_000 })
  const all = readdirSync(dir)
    .filter((f) => f.startsWith('memory-') && f.endsWith('.tgz'))
    .sort()
  for (const old of all.slice(0, Math.max(0, all.length - 30))) unlinkSync(join(dir, old))
  return { file, kept: Math.min(all.length, 30), items: rel }
}

export async function hermesCutover(): Promise<{ stopped: string[]; enabledGateways: string[]; enabledSchedules: string[]; notes: string[] }> {
  const notes: string[] = []
  const stopped: string[] = []
  for (const s of await listServices()) {
    if (s.kind !== 'hermes') continue
    try {
      await serviceAction(s.label, 'disable')
      stopped.push(s.label)
    } catch (err) {
      notes.push(`Could not stop ${s.label}: ${(err as Error).message}`)
    }
  }
  if (!stopped.length) notes.push('No Hermes LaunchAgents found — stop the Hermes gateway manually if it is still running.')
  const enabledGateways: string[] = []
  const c = structuredClone(cfg())
  // Inbound iMessages are routed by profile contacts; the owner profile always has at least one.
  if (allProfiles().some((p) => p.enabled && p.handles.length)) {
    c.gateways.imessage.enabled = true
    enabledGateways.push('imessage')
  } else notes.push('iMessage left off: no allowed senders configured.')
  if (c.gateways.slack.allowedUsers.length) {
    c.gateways.slack.enabled = true
    enabledGateways.push('slack')
  }
  files.config.write(c)
  const enabledSchedules: string[] = []
  files.schedules.write({
    schedules: files.schedules.value.schedules.map((s) => {
      if (s.enabled || !s.pendingEnable) return s
      enabledSchedules.push(s.name)
      return { ...s, enabled: true, pendingEnable: undefined }
    })
  })
  audit('user', 'migration', `Cut over from Hermes: stopped ${stopped.length} service(s), enabled ${enabledGateways.join(', ') || 'no gateways'}`, null, { stopped, enabledGateways, enabledSchedules })
  return { stopped, enabledGateways, enabledSchedules, notes }
}
