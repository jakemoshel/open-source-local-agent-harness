import { execFile } from 'node:child_process'
import { existsSync, statfsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { DoctorCheck, DoctorReport } from '@shared/types'
import { authStatus } from './auth'
import { cfg, files, validTimezone } from './config'
import { controlListening } from './control'
import { getDb, listRuns } from './db'
import { blockedInProcessEnv } from './env'
import { gatewayStatuses, restartFailedGateways } from './gateways'
import { listMemoryFiles, soulPath } from './memory'
import { expandHome, paths, which } from './paths'
import { catchUpSchedules, scheduleError } from './scheduler'
import { appBundlePath, listServices, permissionStatus, SELF_LABEL, syncKeepAlive } from './system'
import { getUpdateStatus } from './updater'
import { mcpShareStatus } from './mcp-share'
import { concurrencyTracker } from './concurrency-tracker'
import { faultDue, listFaults, type Fault } from './faults'

const run = promisify(execFile)
const GB = 1024 ** 3

type Check = Omit<DoctorCheck, 'id' | 'area'>
const ok = (title: string, detail = ''): Check => ({ status: 'ok', title, detail })
const warn = (title: string, detail: string, fix?: string): Check => ({ status: 'warn', title, detail, fix })
const fail = (title: string, detail: string, fix?: string): Check => ({ status: 'fail', title, detail, fix })

async function out(cmd: string, args: string[]): Promise<string | null> {
  try {
    return (await run(cmd, args, { timeout: 10_000 })).stdout
  } catch {
    return null
  }
}

const checks: { id: string; area: DoctorCheck['area']; run: () => Promise<Check> | Check }[] = [
  {
    id: 'app-location',
    area: 'system',
    run: () => {
      if (!app.isPackaged) return ok('Development build', process.execPath)
      const path = appBundlePath()
      if (path.includes('/AppTranslocation/')) return fail('Running from a translocated copy', path, 'Quit, drag Mac Mini Jarvis into /Applications, and open it from there. Updates and the startup service cannot work from here.')
      if (!path.startsWith('/Applications/')) return warn('Not installed in /Applications', path, 'Move the app into /Applications so updates and the startup service point at a stable path.')
      return ok('Installed', path)
    }
  },
  {
    id: 'claude',
    area: 'agents',
    run: async () => {
      const a = (await authStatus(true)).claude
      return a.ok ? ok('Claude Code on a subscription', [a.method, a.plan].filter(Boolean).join(' · ')) : fail('Claude Code not ready', a.detail, 'Run `claude`, then /login with your Claude subscription.')
    }
  },
  {
    id: 'latency',
    area: 'agents',
    run: () => {
      // Median time to first output over the last 200 runs that recorded it.
      const ms = (getDb().prepare(`SELECT json_extract(usage,'$.firstOutputMs') ms FROM runs
        WHERE json_extract(usage,'$.firstOutputMs') IS NOT NULL ORDER BY created_at DESC LIMIT 200`).all() as { ms: number }[]).map((r) => r.ms).sort((a, b) => a - b)
      const median = ms.length ? `${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)}s` : 'n/a'
      const mcp = mcpShareStatus().map((m) => `${m.name}${m.running ? '' : ' (stopped)'}: ${m.sessions} session${m.sessions === 1 ? '' : 's'}`)
      const detail = [`First output: ${median} (${ms.length} runs)`, 'Agent processes exit after each job', `Shared MCP servers: ${mcp.join(', ') || 'none yet'}`].join('\n')
      return ok(ms.length ? `First output in ${median} (median)` : 'No latency samples yet', detail)
    }
  },
  {
    id: 'resource-efficiency',
    area: 'agents',
    run: () => {
      const mem = process.memoryUsage()
      const heapMb = (mem.heapUsed / 1024 ** 2).toFixed(1)
      const rssMb = (mem.rss / 1024 ** 2).toFixed(1)
      const activeFiles = concurrencyTracker.getActiveFiles()
      const conflicts = concurrencyTracker.getConflicts()
      const detail = [
        `Harness RAM: ${rssMb} MB RSS · ${heapMb} MB heap`,
        'Agent processes exit after each job',
        `Active file leases: ${activeFiles.length} · Recent file conflicts: ${conflicts.length}`
      ].join('\n')

      if (mem.rss > 1.5 * 1024 ** 3) {
        return warn('High harness RAM usage', detail, 'Restart Jarvis if RAM usage continues to climb.')
      }
      return ok(`Harness memory & concurrency healthy (${rssMb} MB RSS)`, detail)
    }
  },
  {
    id: 'codex',
    area: 'agents',
    run: async () => {
      const a = (await authStatus()).codex
      if (a.ok) return ok('Codex on ChatGPT', a.method ?? '')
      const needed = cfg().defaultProvider === 'codex' || Object.values(cfg().gateways).some((g) => typeof g === 'object' && g.provider === 'codex')
      return needed ? fail('Codex not ready', a.detail, 'Run `codex login`.') : warn('Codex not ready', a.detail, 'Only needed for Codex runs: `codex login`.')
    }
  },
  {
    id: 'billing-env',
    area: 'agents',
    run: () => {
      const keys = blockedInProcessEnv()
      return keys.length ? warn('Pay-per-token keys in Jarvis’s environment', `${keys.join(', ')} (stripped from every agent)`, 'Remove them from your shell profile to be safe.') : ok('No API billing keys in the environment')
    }
  },
  {
    id: 'config',
    area: 'system',
    run: () => {
      const notes = Object.values(files)
        .map((f) => f.recovered)
        .filter(Boolean)
      if (notes.length) return warn('Recovered damaged config at startup', notes.join('\n'), 'Review the restored files in ~/.jarvis; the damaged copies were kept as *.corrupt-*.')
      if (!validTimezone(cfg().timezone)) return fail('Invalid timezone', cfg().timezone, 'Fix "timezone" in config.json.')
      return ok('Config files valid', `timezone ${cfg().timezone}`)
    }
  },
  {
    id: 'database',
    area: 'system',
    run: () => {
      const result = getDb().pragma('quick_check', { simple: true })
      const size = statSync(paths.db).size
      const wal = existsSync(`${paths.db}-wal`) ? statSync(`${paths.db}-wal`).size : 0
      if (result !== 'ok') return fail('Database integrity check failed', String(result), 'Quit Jarvis and restore data/harness.db from a backup, or move it aside to start fresh.')
      return ok('Database healthy', `${(size / 1024 ** 2).toFixed(1)} MB${wal > 64 * 1024 ** 2 ? `, WAL ${(wal / 1024 ** 2).toFixed(0)} MB` : ''}`)
    }
  },
  {
    id: 'disk',
    area: 'system',
    run: () => {
      const s = statfsSync(paths.home)
      const free = s.bavail * s.bsize
      const text = `${(free / GB).toFixed(1)} GB free`
      if (free < 2 * GB) return fail('Disk almost full', text, 'Free up space: runs, builds and backups will start failing.')
      if (free < 10 * GB) return warn('Disk space low', text)
      return ok('Disk space', text)
    }
  },
  {
    id: 'control-socket',
    area: 'agents',
    run: () => (controlListening() ? ok('Harness tools socket listening', paths.socket) : fail('Harness tools socket down', paths.socket, 'Restart Jarvis. Codex runs cannot use harness tools until then.'))
  },
  {
    id: 'gateways',
    area: 'gateways',
    run: () => {
      const on = gatewayStatuses().filter((g) => g.enabled)
      if (!on.length) return warn('No gateways enabled', 'Jarvis only answers in the app.', 'Enable iMessage or Slack under Gateways.')
      const bad = on.filter((g) => g.state !== 'running')
      if (bad.length) return fail(`${bad.map((g) => g.name).join(', ')} not connected`, bad.map((g) => `${g.name}: ${g.state} — ${g.detail}`).join('\n'), 'Jarvis retries automatically with backoff; doctor --fix retries now.')
      return ok('Gateways connected', on.map((g) => g.name).join(', '))
    }
  },
  {
    id: 'hermes-conflict',
    area: 'gateways',
    run: async () => {
      const live = (await listServices()).filter((s) => s.kind === 'hermes' && s.pid)
      if (live.length && cfg().gateways.imessage.enabled) return fail('Hermes is still running', `${live.map((s) => s.label).join(', ')} — both will answer iMessages`, 'Settings → Import → Cut over from Hermes.')
      return ok('No competing Hermes gateway')
    }
  },
  {
    id: 'startup-service',
    area: 'resilience',
    run: async () => {
      if (!app.isPackaged) return ok('Startup service skipped in development')
      if (!cfg().ui.keepAlive) return warn('Startup service off', 'Jarvis will not start after a reboot or restart after a crash.', 'Settings → System → Run as a macOS startup service.')
      const self = (await listServices()).find((s) => s.label === SELF_LABEL)
      if (!self) return fail('LaunchAgent missing', `~/Library/LaunchAgents/${SELF_LABEL}.plist`, 'doctor --fix reinstalls it.')
      if (self.program && !self.program.startsWith(process.execPath)) return fail('LaunchAgent points at another copy', self.program, 'doctor --fix rewrites it for this install.')
      if (self.disabled) return fail('LaunchAgent disabled', self.label, `launchctl enable gui/$(id -u)/${SELF_LABEL}`)
      if (!self.pid || self.pid !== process.pid) return warn('Crash restart not active yet', 'This Jarvis was not started by launchd, so a crash will not bring it back.', 'Restart Jarvis once (Settings → Restart Jarvis) to hand it to launchd.')
      return ok('Starts at login and restarts after crashes')
    }
  },
  {
    id: 'power',
    area: 'resilience',
    run: async () => {
      const pm = (await out('/usr/bin/pmset', ['-g'])) ?? ''
      const auto = /^\s*autorestart\s+(\d)/m.exec(pm)?.[1]
      const sleep = /^\s*sleep\s+(\d+)/m.exec(pm)?.[1]
      const problems: string[] = []
      if (auto !== '1') problems.push('does not power on after an outage')
      if (sleep && sleep !== '0') problems.push(`system sleeps after ${sleep} min`)
      return problems.length ? warn('Power settings', `This Mac ${problems.join(' and ')}.`, 'sudo pmset -a autorestart 1 sleep 0') : ok('Powers on after outages; never sleeps')
    }
  },
  {
    id: 'auto-login',
    area: 'resilience',
    run: async () => {
      const user = (await out('/usr/bin/defaults', ['read', '/Library/Preferences/com.apple.loginwindow', 'autoLoginUser']))?.trim()
      const fv = (await out('/usr/bin/fdesetup', ['status'])) ?? ''
      if (/FileVault is On/.test(fv)) return warn('FileVault is on', 'After a power outage the Mac waits at the unlock screen and Jarvis stays down until someone types the password. macOS updates do restart unattended.', 'For an unattended server, turn FileVault off and enable automatic login.')
      if (!user) return warn('Automatic login off', 'After a reboot, Jarvis (a per-user service) waits until someone logs in.', 'System Settings → Users & Groups → Automatically log in as…')
      return ok('Logs in automatically after reboots', user)
    }
  },
  {
    id: 'full-disk-access',
    area: 'resilience',
    run: () => (permissionStatus().fullDiskAccess ? ok('Full Disk Access granted') : warn('No Full Disk Access', 'Agents cannot read Messages, Mail or other protected data.', 'Settings → Permissions → Full Disk Access, then restart Jarvis.'))
  },
  {
    id: 'accessibility',
    area: 'system',
    run: () => (permissionStatus().accessibility ? ok('Accessibility granted') : warn('No Accessibility access', 'Agents cannot click or type in other apps (System Events UI scripting).', 'System Settings → Privacy & Security → Accessibility → enable Mac Mini Jarvis.'))
  },
  {
    id: 'screen-recording',
    area: 'system',
    run: () => (permissionStatus().screenRecording ? ok('Screen Recording granted') : warn('No Screen Recording access', 'Agents cannot take screenshots to see what is on screen.', 'System Settings → Privacy & Security → Screen & System Audio Recording → enable Mac Mini Jarvis.'))
  },
  {
    id: 'schedules',
    area: 'schedules',
    run: () => {
      const all = files.schedules.value.schedules.filter((s) => s.enabled)
      const invalid = all.filter((s) => scheduleError(s))
      if (invalid.length) return fail('Invalid cron expressions', invalid.map((s) => `${s.name}: ${s.runAt ?? s.cron}`).join('\n'), 'Fix them under Schedules.')
      const since = Date.now() - 24 * 3600_000
      const failed = listRuns({ trigger: 'schedule', limit: 100 }).filter((r) => r.createdAt >= since && r.status === 'failed')
      if (failed.length) return warn(`${failed.length} scheduled run(s) failed in the last day`, failed.slice(0, 5).map((r) => `${r.title}: ${r.error ?? ''}`).join('\n'))
      const pending = files.schedules.value.schedules.filter((s) => s.pendingEnable).length
      return ok(`${all.length} schedule(s) active`, pending ? `${pending} waiting for cutover` : '')
    }
  },
  {
    id: 'queue',
    area: 'agents',
    run: () => {
      const stale = listRuns({ status: 'queued', limit: 50 }).filter((r) => Date.now() - r.createdAt > 30 * 60_000)
      return stale.length ? warn(`${stale.length} run(s) queued for over 30 minutes`, `Concurrency limit ${cfg().maxConcurrentRuns}; runs time out after ${cfg().maxRunMinutes} min.`, 'Cancel stuck runs under Runs, or raise maxConcurrentRuns.') : ok('Run queue moving')
    }
  },
  {
    id: 'memory',
    area: 'memory',
    run: () => {
      const notes: string[] = []
      if (!existsSync(soulPath())) notes.push('SOUL.md missing — Jarvis has no identity prompt')
      for (const m of listMemoryFiles()) if (m.limit && m.content.length > m.limit) notes.push(`${m.name} is ${m.content.length}/${m.limit} chars`)
      const missing = cfg().memory.contextRoots.filter((r) => !existsSync(expandHome(r)))
      if (missing.length) notes.push(`Context roots not found: ${missing.join(', ')}`)
      return notes.length ? warn('Memory needs attention', notes.join('\n')) : ok('Memory and context roots in place', `${cfg().memory.contextRoots.length} context root(s)`)
    }
  },
  {
    id: 'mcp',
    area: 'agents',
    run: () => {
      const broken = Object.entries(files.mcp.value.mcpServers)
        .filter(([, s]) => s.enabled !== false && s.command)
        .filter(([, s]) => (isAbsolute(s.command!) ? !existsSync(s.command!) : !which(s.command!)))
      return broken.length ? warn('MCP servers with missing commands', broken.map(([n, s]) => `${n}: ${s.command}`).join('\n'), 'Install the command or disable the server under Integrations.') : ok('MCP server commands resolve')
    }
  },
  {
    id: 'faults',
    area: 'system',
    run: () => {
      const recent = listFaults({ limit: 200 }).filter((f) => Date.now() - f.lastSeen < 7 * 86_400_000 && f.status !== 'ignored')
      const due = recent.filter((f) => faultDue(f))
      const lines = (fs: Fault[]) => fs.slice(0, 5).map((f) => `${f.fingerprint} ${f.source} ×${f.count}: ${f.message.slice(0, 140)}`).join('\n')
      if (due.length) return warn(`${due.length} harness bug(s) need a fix`, lines(due), 'Ask Jarvis to look at faults_list, or mark one ignored with faults_set_status.')
      const code = recent.filter((f) => f.cls === 'code')
      return ok(code.length ? `${code.length} harness error(s) seen this week, none repeating` : 'No harness bugs this week', lines(code))
    }
  },
  {
    id: 'updates',
    area: 'updates',
    run: () => {
      const u = getUpdateStatus()
      if (u.state === 'unsupported') return ok('Updates skipped in development')
      if (!existsSync(join(u.sourceDir, '.git'))) return warn('No source checkout for updates', u.sourceDir, 'Clone the repo there or set update.sourceDir in config.json.')
      for (const bin of ['git', 'npm', 'node']) if (!which(bin)) return fail(`${bin} not found`, 'Updates build from source and need git, npm and node on your login PATH.')
      if (u.state === 'error') return warn('Last update attempt failed', u.message ?? '')
      if (u.state === 'available') return warn(`${u.behind.length} update(s) waiting`, u.behind.slice(0, 3).map((c) => c.subject).join('\n'), u.auto ? 'Installs automatically when runs are idle.' : 'Install from Settings → Updates.')
      return ok('Up to date', u.currentCommit.slice(0, 7))
    }
  }
]

export async function runDoctor(opts: { fix?: boolean } = {}): Promise<DoctorReport> {
  const fixed: string[] = []
  if (opts.fix) {
    await restartFailedGateways()
    fixed.push('Retried disconnected gateways')
    if (app.isPackaged && cfg().ui.keepAlive) {
      await syncKeepAlive()
      fixed.push('Rewrote the startup LaunchAgent')
    }
    catchUpSchedules()
    fixed.push('Ran any schedules missed in the last 12 hours')
  }
  const results = await Promise.all(
    checks.map(async (c): Promise<DoctorCheck> => {
      try {
        return { id: c.id, area: c.area, ...(await c.run()) }
      } catch (err) {
        return { id: c.id, area: c.area, status: 'fail', title: `Check ${c.id} crashed`, detail: (err as Error).message }
      }
    })
  )
  const fails = results.filter((r) => r.status === 'fail').length
  const warns = results.filter((r) => r.status === 'warn').length
  const summary = fails ? `${fails} system${fails === 1 ? '' : 's'} down, ${warns} warning${warns === 1 ? '' : 's'}` : warns ? `Operational, ${warns} warning${warns === 1 ? '' : 's'}` : 'All systems nominal'
  return { at: Date.now(), summary, checks: results, fixed }
}

export function formatDoctor(r: DoctorReport): string {
  const icon = { ok: '✓', warn: '!', fail: '✗' } as const
  const lines = [`JARVIS diagnostics — ${r.summary}`, '']
  for (const c of r.checks) {
    lines.push(`${icon[c.status]} ${c.title}${c.detail && c.status === 'ok' ? `  ${c.detail}` : ''}`)
    if (c.status !== 'ok') {
      for (const l of c.detail.split('\n').filter(Boolean)) lines.push(`    ${l}`)
      if (c.fix) lines.push(`    → ${c.fix}`)
    }
  }
  if (r.fixed.length) lines.push('', 'Repairs:', ...r.fixed.map((f) => `  • ${f}`))
  return lines.join('\n')
}
