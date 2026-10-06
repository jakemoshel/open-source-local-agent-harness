import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadModule } from './load-module.mjs'

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim()
const commit = (cwd, file, text, msg) => { writeFileSync(join(cwd, file), text); git(cwd, 'add', '-A'); git(cwd, 'commit', '--quiet', '-m', msg) }

test('local self-repair commits survive upstream updates and origin is never written', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-local-'))
  try {
    const origin = join(root, 'origin.git'), src = join(root, 'src'), up = join(root, 'up')
    git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin)
    git(root, 'clone', '--quiet', origin, up)
    commit(up, 'a.txt', 'a', 'init'); git(up, 'push', '--quiet', 'origin', 'HEAD:main')
    git(root, 'clone', '--quiet', origin, src)
    const { LOCAL_BRANCH, syncLocalBranch } = await loadModule('src/main/local-branch.ts')

    const first = await syncLocalBranch(src, 'main', env)
    assert.equal(first, git(src, 'rev-parse', 'origin/main'), 'created at upstream')

    // A local fix, then an unrelated upstream change: both end up on the local branch.
    const wt = join(root, 'wt'); git(src, 'worktree', 'add', '--quiet', wt, LOCAL_BRANCH)
    commit(wt, 'fix.txt', 'fix', 'local fix'); git(src, 'worktree', 'remove', wt)
    commit(up, 'b.txt', 'b', 'upstream change'); git(up, 'push', '--quiet', 'origin', 'HEAD:main')
    const merged = await syncLocalBranch(src, 'main', env)
    assert.equal(git(src, 'show', `${merged}:fix.txt`), 'fix')
    assert.equal(git(src, 'show', `${merged}:b.txt`), 'b')
    assert.equal(git(up, 'ls-remote', origin, `refs/heads/${LOCAL_BRANCH}`), '', 'nothing is pushed')

    // A conflicting upstream change leaves the local branch as it was.
    const wt2 = join(root, 'wt2'); git(src, 'worktree', 'add', '--quiet', wt2, LOCAL_BRANCH)
    commit(wt2, 'a.txt', 'local', 'local edit'); git(src, 'worktree', 'remove', wt2)
    const before = git(src, 'rev-parse', LOCAL_BRANCH)
    commit(up, 'a.txt', 'upstream', 'upstream edit'); git(up, 'push', '--quiet', 'origin', 'HEAD:main')
    await assert.rejects(syncLocalBranch(src, 'main', env), /conflict with upstream/)
    assert.equal(git(src, 'rev-parse', LOCAL_BRANCH), before)
    assert.equal(git(src, 'worktree', 'list').split('\n').length, 1, 'the scratch worktree is removed')
    assert.equal(readFileSync(join(src, 'a.txt'), 'utf8'), 'a', "the owner's checkout is untouched")
  } finally { rmSync(root, { recursive: true, force: true }) }
})
