import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { parse } from 'dotenv'
import type { EnvEntry } from '@shared/types'
import { loginEnv, paths, resolveLoginPath } from './paths'
import { isOwner } from './profile-context'
import { join } from 'node:path'

const BILLING_PATTERNS: [RegExp, string][] = [
  [/^ANTHROPIC_/, 'Anthropic API credentials or endpoints (subscription OAuth only)'],
  [/^CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$/, 'Cloud-provider billing for Claude Code'],
  [/^AWS_BEARER_TOKEN_BEDROCK$/, 'Bedrock billing'],
  [/^(OPENAI_|CODEX_API_KEY$)/, 'OpenAI API credentials or endpoints (ChatGPT login only)'],
  [/^(OPENROUTER|NOUS|GEMINI|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|CEREBRAS|PERPLEXITY)_API_KEY$/, 'Pay-per-token model API key']
]

export function billingReason(key: string): string | null {
  for (const [re, reason] of BILLING_PATTERNS) if (re.test(key)) return reason
  return null
}

export function readEnvFile(): Record<string, string> {
  if (!existsSync(paths.env)) return {}
  return parse(readFileSync(paths.env, 'utf8'))
}

function quote(v: string): string {
  if (/^[A-Za-z0-9_./:@+-]*$/.test(v)) return v
  // dotenv keeps single- and backtick-quoted values verbatim (including newlines) and only expands \n in
  // double quotes, so JSON-style escaping would corrupt backslashes. Use a quote the value doesn't contain.
  const q = ["'", '`', '"'].find((c) => !v.includes(c)) ?? "'"
  return `${q}${v}${q}`
}

export function writeEnvFile(vars: Record<string, string>): void {
  const body = Object.entries(vars)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${quote(v)}`)
    .join('\n')
  // Created 0600 from the first byte (no world-readable window) and swapped in atomically.
  const tmp = `${paths.env}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, body + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, paths.env)
}

export function mask(v: string): string {
  if (!v) return ''
  if (v.length <= 8) return '•'.repeat(v.length)
  return `${v.slice(0, 4)}${'•'.repeat(Math.min(12, v.length - 8))}${v.slice(-4)}`
}

export function listEnv(): EnvEntry[] {
  return Object.entries(readEnvFile()).map(([key, value]) => {
    const reason = billingReason(key)
    return { key, value, masked: mask(value), blocked: !!reason, reason: reason ?? undefined }
  })
}

/** withEnvFile: false leaves out ~/.jarvis/.env, for runs that must not see the user's secrets. */
export function agentEnv(extra: Record<string, string> = {}, { withEnvFile = true } = {}): Record<string, string> {
  const out: Record<string, string> = {}
  const inherited = isOwner() ? { ...process.env, ...loginEnv() } : Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []))
  for (const [k, v] of Object.entries(inherited)) {
    if (v === undefined || billingReason(k)) continue
    if (k.startsWith('ELECTRON_') || k === 'NODE_OPTIONS' || k.startsWith('CLAUDECODE') || k === 'CLAUDE_CODE_ENTRYPOINT') continue
    out[k] = v
  }
  if (withEnvFile) for (const [k, v] of Object.entries(readEnvFile())) if (!billingReason(k)) out[k] = v
  for (const [k, v] of Object.entries(extra)) if (!billingReason(k)) out[k] = v
  // File-supplied variables cannot re-enable process injection or select someone else's login.
  for (const key of Object.keys(out)) if (key === 'NODE_OPTIONS' || key.startsWith('ELECTRON_') || key.startsWith('DYLD_') || key.startsWith('LD_')) delete out[key]
  if (!isOwner()) {
    out.CLAUDE_CONFIG_DIR = join(paths.home, 'auth', 'claude')
    out.CLAUDE_SECURESTORAGE_CONFIG_DIR = out.CLAUDE_CONFIG_DIR
    out.CODEX_HOME = join(paths.home, 'auth', 'codex')
    // Their own account's claude.ai connectors stay off too: connections are the owner's only.
    out.ENABLE_CLAUDEAI_MCP_SERVERS = 'false'
  }
  out.PATH = resolveLoginPath()
  return out
}

export function blockedInProcessEnv(): string[] {
  return Object.keys(process.env).filter((k) => billingReason(k))
}
