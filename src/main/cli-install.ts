import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ProviderId } from '@shared/types'
import { claudeBinary, codexBinary } from './auth'
import { agentEnv } from './env'
import { ROOT_HOME } from './profile-context'
import { which } from './paths'

const run = promisify(execFile)
const cliPrefix = join(ROOT_HOME, 'cli')
const packages: Record<ProviderId, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex'
}

let installing: Promise<ProviderId[]> | null = null
const binaryFor = (id: ProviderId) => id === 'claude' ? claudeBinary() : codexBinary()

/** Present and actually runs. Claude's npm package is a placeholder until its install script fetches the real binary. */
export async function cliWorks(bin: string | null): Promise<boolean> {
  if (!bin) return false
  try {
    await run(bin, ['--version'], { env: agentEnv(), timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Newer npm skips dependency install scripts unless approved, which leaves Claude Code without its native binary.
 * Run each package's own postinstall directly so the install works whatever npm's script policy is.
 */
async function runPostinstall(id: ProviderId): Promise<void> {
  const dir = join(cliPrefix, 'lib', 'node_modules', packages[id])
  let script: string | undefined
  try {
    script = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts?.postinstall
  } catch {
    return
  }
  if (!script) return
  await run('/bin/sh', ['-c', script], { cwd: dir, env: { ...agentEnv(), npm_config_update_notifier: 'false' }, timeout: 5 * 60_000, maxBuffer: 2 * 1024 * 1024 })
}

/** Install missing or broken CLIs in Jarvis's own user-writable directory. */
export function installMissingClis(): Promise<ProviderId[]> {
  if (installing) return installing
  installing = (async () => {
    const missing: ProviderId[] = []
    for (const id of ['claude', 'codex'] as const) if (!(await cliWorks(binaryFor(id)))) missing.push(id)
    if (!missing.length) return []
    const npm = which('npm')
    if (!npm) throw new Error('npm is required to install Claude Code and Codex. Install Node.js first (brew install node), then try again.')
    mkdirSync(cliPrefix, { recursive: true })
    try {
      await run(npm, ['install', '--global', '--prefix', cliPrefix, ...missing.map((id) => packages[id])], {
        env: { ...agentEnv(), npm_config_update_notifier: 'false' },
        timeout: 5 * 60_000,
        maxBuffer: 2 * 1024 * 1024
      })
      for (const id of missing) if (!(await cliWorks(binaryFor(id)))) await runPostinstall(id)
    } catch (err) {
      const e = err as Error & { stderr?: string }
      throw new Error(`CLI install failed: ${(e.stderr || e.message).trim().split('\n').slice(-4).join(' ')}`)
    }
    const failed: ProviderId[] = []
    for (const id of missing) if (!(await cliWorks(binaryFor(id)))) failed.push(id)
    if (failed.length) throw new Error(`Installed packages, but ${failed.join(' and ')} would not start. Check the Jarvis log, then try again.`)
    return missing
  })().finally(() => { installing = null })
  return installing
}
