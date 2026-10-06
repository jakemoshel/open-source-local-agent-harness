import { realpathSync, existsSync } from 'node:fs'
import { dirname, relative, resolve, isAbsolute, join } from 'node:path'
import { isOwner } from './profile-context'
import { paths } from './paths'

// These operations affect shared Mac infrastructure or the admin's trust policy.
const ADMIN_OPS = /^(profiles_(create|update|invite|call)|gateways_(configure|restart)|safeguards_(update|set|revert)|services_|app_restart$|harness_restart$|doctor$|update_|permissions_|open_settings_pane$|hermes_|terminal_)/
export function memberCanInvoke(name: string): boolean { return !ADMIN_OPS.test(name) }

/** Resolve existing parents too: a symlink must not turn a profile-local path into an escape. */
export function assertProfilePath(path: string): void {
  if (isOwner()) return
  const absolute = resolve(path)
  let parent = absolute
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent)
  const resolved = resolve(realpathSync(parent), relative(parent, absolute))
  const root = realpathSync(paths.home)
  const rel = relative(root, resolved)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Path is outside your profile')
}

export function assertMemberInput(name: string, args: Record<string, any>): void {
  if (isOwner()) return
  if (!memberCanInvoke(name)) throw new Error('Only the owner can manage shared settings and other profiles')
  if (args.cwd) assertProfilePath(args.cwd)
  if (name === 'config_update') {
    const allowed = new Set(['defaultProvider', 'timezone', 'learning', 'providers', 'memory'])
    for (const key of Object.keys(args.patch ?? {})) if (!allowed.has(key)) throw new Error(`The owner manages config field: ${key}`)
    const p = args.patch ?? {}
    for (const v of Object.values(p.providers ?? {}) as Record<string, unknown>[]) {
      for (const key of Object.keys(v)) if (!['model', 'effort', 'reasoningEffort'].includes(key)) throw new Error('The owner manages provider executables and settings sources')
    }
    for (const key of Object.keys(p.memory ?? {})) if (!['startupInstructions', 'recap'].includes(key)) throw new Error('The owner manages memory locations and limits')
  }
  if (name === 'mcp_upsert' || name === 'mcp_delete') throw new Error('Connections are only available to the owner’s agent')
  if (name === 'env_set' && /^(HOME|PATH|NODE_|ELECTRON_|DYLD_|LD_|CLAUDE_|CODEX_|JARVIS_|BASH_ENV|ENV$)/.test(args.key)) throw new Error('The owner manages runtime and authentication variables; use your profile login')
  if (name === 'gateways_send' || (name === 'schedules_upsert' && args.deliver)) throw new Error('Ask the owner to configure outbound delivery; conversational replies are automatic')
}

export function assertMemberToolPath(path: string, cwd: string, writing = false): void {
  if (isOwner()) return
  const p = resolve(cwd, path)
  assertProfilePath(p)
  const allowed = [join(paths.home, 'workspace'), paths.memories, paths.skills]
  const tools = join(paths.home, 'tools')
  if (!writing && (p === tools || p.startsWith(tools + '/'))) return
  if (p === paths.soul || allowed.some((root) => p === root || p.startsWith(root + '/'))) return
  throw new Error('Agent file tools are limited to this profile’s workspace, memory and skills; authentication and settings require harness operations')
}
