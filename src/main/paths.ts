import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { profileHome, ROOT_HOME } from './profile-context'

export const HOME = ROOT_HOME

export const paths = {
  get home() { return profileHome() },
  get config() { return join(profileHome(), 'config.json') },
  get safeguards() { return join(profileHome(), 'safeguards.json') },
  get schedules() { return join(profileHome(), 'schedules.json') },
  get mcp() { return join(profileHome(), 'mcp.json') },
  get env() { return join(profileHome(), '.env') },
  get soul() { return join(profileHome(), 'SOUL.md') },
  get memories() { return join(profileHome(), 'memories') },
  get skills() { return join(profileHome(), 'skills') },
  get data() { return join(profileHome(), 'data') },
  get db() { return join(profileHome(), 'data', 'harness.db') },
  get logs() { return join(profileHome(), 'logs') },
  get backups() { return join(profileHome(), 'backups') },
  socket: Buffer.byteLength(join(HOME, 'control.sock')) < 100 ? join(HOME, 'control.sock') : join(tmpdir(), `jarvis-${createHash('sha1').update(HOME).digest('hex').slice(0, 10)}.sock`)
}

export let migratedFromLegacy = false

export function ensureDirs(): void {
  const legacy = join(homedir(), '.ea-harness')
  if (!process.env.JARVIS_HOME && !existsSync(HOME) && existsSync(legacy)) {
    renameSync(legacy, HOME)
    migratedFromLegacy = true
    for (const f of [paths.config, paths.schedules, paths.mcp, paths.safeguards]) {
      if (!existsSync(f)) continue
      const text = readFileSync(f, 'utf8')
      if (text.includes(legacy)) writeFileSync(f, text.split(legacy).join(HOME))
    }
  }
  for (const d of [paths.home, paths.memories, paths.skills, paths.data, paths.logs, paths.backups]) {
    mkdirSync(d, { recursive: true })
  }
  // Holds .env, the control socket and transcripts: owner only.
  chmodSync(paths.home, 0o700)
}

export function expandHome(p: string): string {
  return p.startsWith('~/') || p === '~' ? join(homedir(), p.slice(1)) : p
}

let loginEnvCache: Record<string, string> | null = null

export function loginEnv(): Record<string, string> {
  if (loginEnvCache) return loginEnvCache
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const out = execFileSync(shell, ['-ilc', 'printf "__ENV_START__"; env -0'], { encoding: 'utf8', timeout: 8000, maxBuffer: 8 * 1024 * 1024 })
    const body = out.split('__ENV_START__').pop() ?? ''
    const env: Record<string, string> = {}
    for (const pair of body.split('\0')) {
      const i = pair.indexOf('=')
      if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1)
    }
    for (const k of ['PWD', 'OLDPWD', 'SHLVL', '_']) delete env[k]
    loginEnvCache = env
  } catch {
    loginEnvCache = {}
  }
  return loginEnvCache
}

let loginPath: string | null = null

export function resolveLoginPath(): string {
  if (loginPath) return loginPath
  const fallback = [
    join(HOME, 'cli/bin'),
    join(homedir(), '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]
  const found = loginEnv().PATH || process.env.PATH || ''
  loginPath = Array.from(new Set([...found.split(':'), ...fallback])).filter(Boolean).join(':')
  return loginPath
}

/** Found binaries, briefly cached: every run start resolves the CLIs, and a sync spawn blocks the main process. Misses are not cached, so a fresh install is seen at once. */
const whichCache = new Map<string, { path: string; at: number }>()
const WHICH_TTL_MS = 5 * 60_000

export function which(bin: string): string | null {
  const hit = whichCache.get(bin)
  if (hit && Date.now() - hit.at < WHICH_TTL_MS && existsSync(hit.path)) return hit.path
  try {
    const path = execFileSync('/usr/bin/which', [bin], { encoding: 'utf8', env: { PATH: resolveLoginPath() } }).trim() || null
    if (path) whichCache.set(bin, { path, at: Date.now() })
    else whichCache.delete(bin)
    return path
  } catch {
    whichCache.delete(bin)
    return null
  }
}
