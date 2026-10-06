import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'
import type { ProviderLogin } from '@shared/types'
import { authStatus, claudeBinary, codexBinary } from './auth'
import { agentEnv } from './env'
import { profileId, withProfile } from './profile-context'
import { cleanOutput, RELAY } from './terminal'

/**
 * Subscription sign-in for someone who isn't at the Mac mini. The CLI runs here, in a hidden PTY scoped to the
 * profile's own credential store, and only its sign-in link goes to the person:
 * - Codex uses device authorization: they open the link anywhere and type the one-time code.
 * - Claude prints a link whose approval page shows a code; they send it back and it is typed into the waiting CLI.
 *   That code is single-use and only redeemable with the PKCE verifier held by this process, so it is not a credential.
 */
type Provider = ProviderLogin['provider']
type Listener = (info: ProviderLogin) => void

interface Login {
  info: ProviderLogin
  child: ChildProcessWithoutNullStreams
  output: string
  listeners: Map<string, Listener>
  timer: NodeJS.Timeout
  done: Promise<ProviderLogin>
  finish: (state: ProviderLogin['state'], detail: string) => void
}

const LOGIN_TTL_MS = 15 * 60_000
const START_TIMEOUT_MS = 30_000
const VERIFY_TIMEOUT_MS = 90_000
const MAX_OUTPUT = 64 * 1024
const logins = new Map<string, Login>()
const live = (l: Login | undefined): l is Login => !!l && (l.info.state === 'waiting' || l.info.state === 'verifying')
const snapshot = (l: Login): ProviderLogin => ({ ...l.info })

/**
 * Claude's approval page shows `<code>#<state>`. Accept a lone token (including wrapped copies) or one token on
 * its own line inside a longer paste. Never extract fragments from prose or URLs, or choose between two codes.
 */
export function normalizeLoginCode(text: string): string | null {
  const code = text.trim().replace(/[\r\n]+/g, '')
  const token = /^[\w.~-]{8,512}#[\w.~-]{8,512}$/
  if (token.test(code)) return code
  const candidates = [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => token.test(line)))]
  return candidates.length === 1 ? candidates[0] : null
}

function parseLoginOutput(provider: Provider, raw: string): { url: string | null; userCode: string | null } {
  const text = cleanOutput(raw)
  if (provider === 'claude') {
    const urls = text.match(/https:\/\/\S+\/oauth\/authorize\?\S+/g) ?? []
    // Prefer the link that shows a code to paste back; a localhost redirect can't reach this Mac from their phone.
    const url = urls.find((u) => /redirect_uri=https/.test(u)) ?? null
    return { url, userCode: null }
  }
  const url = /https:\/\/\S+/.exec(text)?.[0] ?? null
  const userCode = /one-time code[^\n]*\n\s*([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+)/i.exec(text)?.[1] ?? null
  return { url, userCode: url && userCode ? userCode : null }
}

function lastLine(raw: string): string {
  return cleanOutput(raw).split('\n').map((l) => l.replace(/^Paste code[^>]*>\s*/i, '').trim()).filter(Boolean).pop()?.slice(0, 300) ?? ''
}

export function loginStatus(provider: Provider): ProviderLogin | null {
  const l = logins.get(`${profileId()}:${provider}`)
  return l ? snapshot(l) : null
}

export function loginListening(provider: Provider, key: string): boolean {
  const l = logins.get(`${profileId()}:${provider}`)
  return live(l) && l.listeners.has(key)
}

/** The Claude sign-in in this profile that is waiting for the pasted code, if any. */
export function waitingForClaudeCode(): boolean {
  const l = logins.get(`${profileId()}:claude`)
  return live(l) && l.info.state === 'waiting' && l.info.needsCode
}

/** A subscription approval is active work too, across every profile. An update must not kill its PKCE process. */
export function loginsBusyForUpdate(): boolean {
  return [...logins.values()].some(live)
}

/**
 * Start a sign-in for the current profile, or return the one already waiting so a repeated request doesn't
 * invalidate a link the person may already have open. `listen` is told once when it ends; one per key.
 */
export async function startLogin(provider: Provider, listen?: { key: string; fn: Listener }): Promise<ProviderLogin> {
  const profile = profileId()
  const k = `${profile}:${provider}`
  const existing = logins.get(k)
  if (live(existing)) {
    if (listen) existing.listeners.set(listen.key, listen.fn)
    return snapshot(existing)
  }
  const bin = provider === 'claude' ? claudeBinary() : codexBinary()
  if (!bin) throw new Error(`${provider === 'claude' ? 'Claude Code' : 'Codex'} CLI is not installed`)
  const argv = provider === 'claude' ? [bin, 'auth', 'login', '--claudeai'] : [bin, 'login', '--device-auth', '-c', 'forced_login_method="chatgpt"']
  // BROWSER keeps Claude from opening the approval page on the Mac mini itself; the person opens it on their device.
  const env = { ...agentEnv(), TERM: 'xterm-256color', BROWSER: '/usr/bin/true', NO_COLOR: '1' }
  const child = spawn('/usr/bin/python3', ['-u', '-c', RELAY, '400', '48', ...argv], { cwd: homedir(), env, stdio: 'pipe' })

  let resolveDone!: (info: ProviderLogin) => void
  const login: Login = {
    info: { profile, provider, state: 'waiting', url: null, userCode: null, needsCode: provider === 'claude', expiresAt: Date.now() + LOGIN_TTL_MS, detail: 'Starting sign-in…' },
    child, output: '', listeners: new Map(listen ? [[listen.key, listen.fn]] : []),
    timer: setTimeout(() => login.finish('expired', 'The sign-in link expired. Start again to get a new one.'), LOGIN_TTL_MS),
    done: new Promise((r) => { resolveDone = r }),
    finish: (state, detail) => {
      if (!live(login)) return
      clearTimeout(login.timer)
      login.info = { ...login.info, state, detail, needsCode: false }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      const info = snapshot(login)
      for (const fn of login.listeners.values()) try { fn(info) } catch { /* a failed notification must not break the others */ }
      login.listeners.clear()
      resolveDone(info)
    }
  }
  login.timer.unref()
  logins.set(k, login)

  let ready!: () => void, failed!: (err: Error) => void
  const started = new Promise<void>((yes, no) => { ready = yes; failed = no })
  const onData = (chunk: string) => {
    login.output = (login.output + chunk).slice(-MAX_OUTPUT)
    if (login.info.url) return
    const found = parseLoginOutput(provider, login.output)
    if (found.url && (provider === 'claude' || found.userCode)) {
      login.info = { ...login.info, ...found, detail: provider === 'claude' ? 'Waiting for the code from the approval page' : 'Waiting for approval' }
      ready()
    }
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.stdin.on('error', () => undefined)
  child.on('error', (err) => { login.finish('failed', `Could not start sign-in: ${err.message}`); failed(err) })
  child.on('exit', () => {
    failed(new Error(lastLine(login.output) || 'The sign-in exited before showing a link'))
    if (!live(login)) return
    // The CLI exits after a completed or rejected sign-in; the credential store is the source of truth.
    login.info = { ...login.info, state: 'verifying', needsCode: false, detail: 'Checking the new login…' }
    const tail = lastLine(login.output)
    void withProfile(profile, () => authStatus(true))
      .then((status) => {
        const p = status[provider]
        if (p.ok) login.finish('connected', p.detail)
        else if (/fail|error|denied|invalid|expired/i.test(tail)) login.finish('failed', tail)
        else login.finish('failed', p.detail)
      })
      .catch((err: Error) => login.finish('failed', `Could not verify the login: ${err.message}`))
  })

  const timeout = setTimeout(() => failed(new Error('The sign-in did not show a link in time')), START_TIMEOUT_MS)
  try {
    await started
  } catch (err) {
    login.finish('failed', (err as Error).message)
    throw new Error(`Could not start ${provider === 'claude' ? 'Claude' : 'Codex'} sign-in: ${(err as Error).message}`)
  } finally {
    clearTimeout(timeout)
  }
  return snapshot(login)
}

/** Type the code from Claude's approval page into the waiting sign-in and wait for the result. */
export async function submitLoginCode(text: string): Promise<ProviderLogin> {
  const login = logins.get(`${profileId()}:claude`)
  if (!live(login) || !login.info.needsCode) throw new Error('No Claude sign-in is waiting for a code. Start one with /connect claude.')
  const code = normalizeLoginCode(text)
  if (!code) throw new Error('That doesn’t look like the code from Claude’s approval page. Copy the whole code, including the # in the middle.')
  const expectedState = login.info.url ? new URL(login.info.url).searchParams.get('state') : null
  if (!expectedState || code.split('#')[1] !== expectedState) throw new Error('That code belongs to a different sign-in. Use the latest link from /connect claude.')
  login.info = { ...login.info, state: 'verifying', needsCode: false, detail: 'Checking the code…' }
  login.child.stdin.write(code + '\r')
  const timer = setTimeout(() => login.finish('failed', 'Claude did not finish the sign-in. Start again.'), VERIFY_TIMEOUT_MS)
  timer.unref()
  try {
    return await login.done
  } finally {
    clearTimeout(timer)
  }
}

export function cancelLogin(provider: Provider): ProviderLogin | null {
  const l = logins.get(`${profileId()}:${provider}`)
  if (!l) return null
  l.finish('cancelled', 'Sign-in cancelled')
  return snapshot(l)
}

/** Stop every sign-in in a disabled profile. */
export function cancelAllLogins(profile: string): void {
  for (const l of logins.values()) if (l.info.profile === profile) l.finish('cancelled', 'Sign-in cancelled')
}

/** On quit: end the CLIs without messaging anyone, since gateways are shutting down too. */
export function stopAllLogins(): void {
  for (const l of logins.values()) {
    l.listeners.clear()
    l.finish('cancelled', 'Jarvis quit')
  }
}

const label = (p: Provider) => p === 'claude' ? 'Claude' : 'ChatGPT (Codex)'

/** What to send the person. `byOwner` changes who they are told started it, which Codex's own warning asks about. */
export function loginInstructions(info: ProviderLogin, byOwner = false): string {
  const minutes = Math.max(1, Math.round((info.expiresAt - Date.now()) / 60_000))
  const who = byOwner ? 'The owner started this sign-in for you' : 'You started this sign-in'
  if (info.provider === 'codex') {
    return `To connect your ChatGPT subscription to Jarvis:\n1. Open ${info.url} and sign in with your own ChatGPT account.\n2. Enter this code: ${info.userCode}\n\n${who}, so it's safe to continue. The code expires in ${minutes} min. I'll message you here when it's connected. Send /connect cancel to stop.`
  }
  return `To connect your Claude subscription to Jarvis:\n1. Open this link and sign in with your own Claude account:\n${info.url}\n2. After you approve, Claude shows a code. Copy it and send it here as its own message.\n\n${who}. The link expires in ${minutes} min. Send /connect cancel to stop.`
}

export function loginResultText(info: ProviderLogin): string {
  switch (info.state) {
    case 'connected': return `✅ ${label(info.provider)} is connected: ${info.detail}`
    case 'expired': return `${label(info.provider)} sign-in expired. Send /connect ${info.provider} for a new link.`
    case 'cancelled': return `${label(info.provider)} sign-in cancelled.`
    case 'failed': return `❌ ${label(info.provider)} sign-in failed: ${info.detail}\nSend /connect ${info.provider} to try again.`
    default: return info.detail
  }
}
