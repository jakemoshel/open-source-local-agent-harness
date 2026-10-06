import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Self-repair never pushes: its commits land on this local branch, which also follows upstream and is what gets installed. */
export const LOCAL_BRANCH = 'jarvis/local'

/**
 * Fetches upstream <branch> and folds it into LOCAL_BRANCH: created at upstream, fast-forwarded, or merged in a scratch
 * worktree so local fixes survive upstream updates. Returns the LOCAL_BRANCH tip. A conflict leaves the branch untouched.
 */
export async function syncLocalBranch(dir: string, branch: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const g = async (...args: string[]) => (await run('git', args, { cwd: dir, env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 })).stdout.trim()
  const ok = (...args: string[]) => g(...args).then(() => true, () => false)
  const local = `refs/heads/${LOCAL_BRANCH}`
  await g('fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`)
  const upstream = await g('rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`)
  if (!await ok('rev-parse', '--verify', '--quiet', local)) { await g('update-ref', local, upstream, ''); return upstream }
  const tip = await g('rev-parse', local)
  if (await ok('merge-base', '--is-ancestor', upstream, tip)) return tip
  if (await ok('merge-base', '--is-ancestor', tip, upstream)) { await g('update-ref', local, upstream, tip); return upstream }
  const scratch = join(tmpdir(), `jarvis-merge-${process.pid}-${Date.now()}`)
  await g('worktree', 'add', '--quiet', '--detach', scratch, tip)
  try {
    const merge = (...args: string[]) => run('git', ['-c', 'user.name=Jarvis', '-c', 'user.email=jarvis@localhost', ...args], { cwd: scratch, env, timeout: 120_000 })
    try { await merge('merge', '--no-edit', '--quiet', upstream) } catch {
      await merge('merge', '--abort').catch(() => undefined)
      throw new Error(`Local self-repair commits on ${LOCAL_BRANCH} conflict with upstream ${branch}; resolve them on that branch`)
    }
    const merged = (await run('git', ['rev-parse', 'HEAD'], { cwd: scratch, env })).stdout.trim()
    await g('update-ref', local, merged, tip)
    return merged
  } finally { await g('worktree', 'remove', '--force', scratch).catch(() => undefined) }
}
