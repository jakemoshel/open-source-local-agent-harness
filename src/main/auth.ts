import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AuthStatus } from '@shared/types'
import { cfg } from './config'
import { agentEnv } from './env'
import { expandHome, which } from './paths'
import { profileId } from './profile-context'

const run = promisify(execFile)

function binary(configured: string | undefined, fallback: string): string | null {
  if (!configured) return which(fallback)
  if (!configured.includes('/') && !configured.startsWith('~')) return which(configured) ?? which(fallback)
  const path = expandHome(configured)
  try {
    accessSync(path, constants.X_OK)
    return path
  } catch {
    return which(fallback)
  }
}

export function claudeBinary(): string | null {
  return binary(cfg().providers.claude.executable, 'claude')
}

export function codexBinary(): string | null {
  return binary(cfg().providers.codex.executable, 'codex')
}

const cache = new Map<string, { at: number; value: AuthStatus }>()
const inFlight = new Map<string, Promise<AuthStatus>>()

export async function authStatus(force = false): Promise<AuthStatus> {
  const key = profileId()
  const cached = cache.get(key)
  if (!force && cached && Date.now() - cached.at < 10 * 60_000) return cached.value
  // Many runs starting at once share one check instead of spawning a CLI each.
  const running = inFlight.get(key)
  if (running) return running
  const check = Promise.all([claudeAuth(), codexAuth()])
    .then(([claude, codex]) => {
      const value = { claude, codex }
      cache.set(key, { at: Date.now(), value })
      return value
    })
    .finally(() => inFlight.delete(key))
  inFlight.set(key, check)
  return check
}

function parseClaudeStatus(stdout: string, nonzero = false): AuthStatus['claude'] | null {
  let raw: unknown
  try { raw = JSON.parse(stdout) } catch { return null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const s = raw as Record<string, unknown>
  if (s.loggedIn === false) return { ok: false, installed: true, method: null, plan: null, detail: 'Not logged in. Send /connect claude to reconnect your subscription.' }
  // Missing/malformed output is not proof of a logout. A nonzero exit cannot establish a healthy login either.
  if (nonzero || s.loggedIn !== true || typeof s.authMethod !== 'string' || !s.authMethod) return null
  if (s.apiProvider !== undefined && typeof s.apiProvider !== 'string') return null
  const subscription = s.authMethod === 'claude.ai' && (s.apiProvider ?? 'firstParty') === 'firstParty'
  const plan = typeof s.subscriptionType === 'string' ? s.subscriptionType : null
  const email = typeof s.email === 'string' ? s.email : null
  return {
    ok: subscription,
    installed: true,
    method: s.authMethod,
    plan,
    detail: subscription
      ? `Claude ${plan ?? ''} subscription${email ? ` · ${email}` : ''}`.trim()
      : `Logged in via ${s.authMethod} — API billing is not allowed. Send /connect claude and choose your Claude subscription.`
  }
}

async function claudeAuth(): Promise<AuthStatus['claude']> {
  const bin = claudeBinary()
  if (!bin) return { ok: false, installed: false, method: null, plan: null, detail: 'Claude Code CLI not installed' }
  try {
    const { stdout } = await run(bin, ['auth', 'status'], { env: agentEnv(), timeout: 15_000 })
    const status = parseClaudeStatus(stdout)
    if (status) return status
    throw new Error('Claude auth status returned an unrecognized response')
  } catch (err) {
    const e = err as Error & { stderr?: string; stdout?: string; killed?: boolean; code?: unknown; signal?: string }
    // npm left only the placeholder (its install script didn't run); the installer can repair it.
    if (/native binary not installed/i.test(`${e.message}${e.stderr ?? ''}${e.stdout ?? ''}`)) {
      return { ok: false, installed: false, method: null, plan: null, detail: 'Claude Code install is incomplete. Click Install missing CLIs.' }
    }
    // Claude exits 1 with valid loggedIn:false JSON. Treat only that completed check as a definite logout;
    // timeouts, spawn failures and malformed output remain unknown, as with Codex below.
    if (!e.killed && !e.signal && typeof e.code === 'number' && e.code !== 0) {
      const status = parseClaudeStatus(e.stdout ?? '', true)
      if (status) return status
    }
    return { ok: false, installed: true, unknown: true, method: null, plan: null, detail: `Could not read Claude auth status: ${e.message.split('\n')[0]}` }
  }
}

async function codexAuth(): Promise<AuthStatus['codex']> {
  const bin = codexBinary()
  if (!bin) return { ok: false, installed: false, method: null, detail: 'Codex CLI not installed' }
  const authFile = join(agentEnv().CODEX_HOME || join(homedir(), '.codex'), 'auth.json')
  let mode: string | null = null
  if (existsSync(authFile)) {
    try {
      const a = JSON.parse(readFileSync(authFile, 'utf8')) as { auth_mode?: string; OPENAI_API_KEY?: string | null }
      mode = a.auth_mode ?? (a.OPENAI_API_KEY ? 'apikey' : null)
    } catch {
      mode = null
    }
  }
  try {
    const { stdout, stderr } = await run(bin, ['login', 'status'], { env: agentEnv(), timeout: 15_000 })
    const text = `${stdout}${stderr}`.trim()
    const chatgpt = /chatgpt/i.test(text) && mode !== 'apikey'
    return {
      ok: chatgpt,
      installed: true,
      method: chatgpt ? 'chatgpt' : mode,
      detail: chatgpt ? 'ChatGPT subscription' : `${text || 'Not logged in'} — API billing is not allowed. Run \`codex login\` and sign in with ChatGPT.`
    }
  } catch (err) {
    const e = err as Error & { killed?: boolean; code?: unknown; stderr?: string; stdout?: string }
    const text = `${e.stdout ?? ''}${e.stderr ?? ''}`
    // `codex login status` exits non-zero when logged out; a timeout or spawn failure says nothing about the login.
    if (e.killed || typeof e.code === 'string' || !/not logged in|log ?in/i.test(text)) {
      return { ok: false, installed: true, unknown: true, method: mode, detail: `Could not read Codex login status: ${e.message.split('\n')[0]}` }
    }
    return { ok: false, installed: true, method: mode, detail: `Not logged in: ${text.trim().split('\n')[0] || e.message.split('\n')[0]}. Run \`codex login\`.` }
  }
}

export function startAuthWatch(): void {
  void authStatus(true)
  setInterval(() => void authStatus(true), 9 * 60_000).unref()
}

export class BillingGuardError extends Error {}

/**
 * Blocks runs only on a definite answer (logged out, API-key login). If the status check itself failed, the run goes
 * ahead: both providers verify subscription billing again at startup (Claude's apiKeySource, Codex's account type).
 */
export async function assertSubscription(provider: 'claude' | 'codex'): Promise<void> {
  const s = await authStatus()
  const p = s[provider]
  if (p.ok) return
  const fresh = (await authStatus(true))[provider]
  if (!fresh.ok && !fresh.unknown) throw new BillingGuardError(fresh.detail)
}
