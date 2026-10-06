import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execute } from '../resources/updater/worker.mjs'

for (const dirty of [false, true]) test(`updater builds pinned remote snapshot without changing ${dirty ? 'dirty' : 'feature-branch'} source`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-snapshot-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'source'); mkdirSync(source)
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(source, 'file.txt'), 'remote release'); git('add', '.'); git('commit', '-m', 'release')
  const commit = git('rev-parse', 'HEAD')
  git('switch', '-c', 'feature'); writeFileSync(join(source, 'file.txt'), 'local feature'); git('commit', '-am', 'feature')
  if (dirty) writeFileSync(join(source, 'file.txt'), 'uncommitted work')
  const before = git('status', '--porcelain'), head = git('rev-parse', 'HEAD')
  const directory = join(root, 'job'); mkdirSync(directory)
  const job = { id: 'test', directory, source, target: join(root, 'old.app'), appName: 'Jarvis', commit }
  let built = null
  const result = await execute(job, { run: async (cmd, args, cwd) => {
    if (cmd === 'npm') { built = readFileSync(join(cwd, 'file.txt'), 'utf8'); throw new Error('BUILD_REACHED') }
    return execFileSync(cmd, args, { cwd, encoding: 'utf8' })
  } })
  assert.match(result.message, /BUILD_REACHED/)
  assert.equal(built, 'remote release')
  assert.equal(git('rev-parse', 'HEAD'), head); assert.equal(git('status', '--porcelain'), before)
  assert.equal(git('branch', '--show-current'), 'feature')
})
