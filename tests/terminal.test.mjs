import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { loadModule } from './load-module.mjs'

async function fixture(opts = {}) {
  const children = []
  const spawn = () => {
    const child = new EventEmitter(), writes = []
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.stdout.setEncoding = child.stderr.setEncoding = () => {}
    child.stdin = new EventEmitter(); child.stdin.write = text => { writes.push(text); return true }
    child.stdin.end = () => { child.ends++; child.emit('exit', 0, null) }
    child.pid = 1234 + children.length
    child.writes = writes
    child.ends = 0
    children.push(child)
    return child
  }
  const api = await loadModule('src/main/terminal.ts', {
    'node:child_process': { spawn }, './config': { defaultCwd: () => process.cwd() },
    './env': { agentEnv: () => ({}) }, './paths': { expandHome: x => x }
  })
  const terminal = await api.openTerminal({ ...opts, waitMs: 0 })
  return { child: children[0], writes: children[0].writes, children, api, terminal }
}

test('automatic terminal names remain unique after history pruning and repeated opens', async () => {
  const f = await fixture()
  f.child.emit('exit', 0, null)
  for (let i = 1; i < 20; i++) {
    await f.api.openTerminal({ waitMs: 0 })
    f.children.at(-1).emit('exit', 0, null)
  }
  const first = await f.api.openTerminal({ waitMs: 0 })
  const active = await f.api.openTerminal({ waitMs: 0 })
  assert.equal(first.name, 'term-21')
  assert.equal(active.name, 'term-22')
  f.children[20].emit('exit', 0, null)
  assert.equal(f.api.listTerminals().length, 21, 'history prunes to 20 exited sessions plus the live terminal')
  await assert.rejects(f.api.readTerminal(f.terminal.id), /No terminal/)

  const names = new Set([first.name, active.name])
  for (let i = 0; i < 30; i++) {
    let opened
    await assert.doesNotReject(async () => { opened = await f.api.openTerminal({ waitMs: 0 }) }, 'pruning must not make unnamed opens collide')
    assert.equal(names.has(opened.name), false, 'automatic names must not repeat after pruning')
    names.add(opened.name)
    const running = f.api.listTerminals().filter(t => t.running)
    assert.equal(running.length, 2)
    assert.equal(new Set(running.map(t => t.name)).size, 2)
    assert.equal((await f.api.readTerminal(active.name)).id, active.id)
    f.children.at(-1).emit('exit', 0, null)
    assert.equal(f.api.listTerminals().length, 21)
  }
})

test('removing exited history does not reuse an automatic terminal name', async () => {
  const f = await fixture()
  f.child.emit('exit', 0, null)
  f.api.closeTerminal(f.terminal.id)
  assert.equal(f.api.listTerminals().length, 0)
  const current = await f.api.openTerminal({ waitMs: 0 })
  assert.notEqual(current.name, f.terminal.name, 'automatic numbering must not reset when retained history is removed')
})

test('automatic terminal names skip active explicit names, including concurrent blank-name opens', async () => {
  const f = await fixture({ name: 'term-2' })
  let opened
  await assert.doesNotReject(async () => {
    opened = await Promise.all([
      f.api.openTerminal({ waitMs: 0 }),
      f.api.openTerminal({ name: '   ', waitMs: 0 }),
      f.api.openTerminal({ name: '', waitMs: 0 })
    ])
  }, 'automatic naming must skip an explicitly reserved name')
  assert.deepEqual(opened.map(t => t.name), ['term-1', 'term-3', 'term-4'])
  assert.equal(new Set(f.api.listTerminals().map(t => t.name)).size, 4)
  assert.equal((await f.api.readTerminal('term-2')).id, f.terminal.id)
})

test('explicit terminal names still reject active collisions before spawning', async () => {
  const f = await fixture({ name: 'build' })
  await assert.rejects(f.api.openTerminal({ name: ' build ', waitMs: 0 }), /A terminal named "build" is already open/)
  assert.equal(f.children.length, 1)
  f.child.emit('exit', 0, null)
  const reused = await f.api.openTerminal({ name: ' build ', waitMs: 0 })
  assert.equal(reused.name, 'build')
  assert.equal(f.children.length, 2)
})

test('sending to a reused terminal name targets the running session', async () => {
  const f = await fixture({ name: 'build' })
  f.child.emit('exit', 0, null)
  await f.api.openTerminal({ name: 'build', waitMs: 0 })
  await assert.doesNotReject(f.api.sendToTerminal('build', { input: 'new command', waitMs: 0 }))
  assert.deepEqual(f.children[1].writes, ['new command\r'])
  assert.deepEqual(f.writes, [])
  await assert.rejects(f.api.sendToTerminal(f.terminal.id, { input: 'old command', waitMs: 0 }), /has exited/)
})

test('reading a reused name returns the running session while old output remains accessible by ID', async () => {
  const f = await fixture({ name: 'build' })
  f.child.stdout.emit('data', 'old output')
  f.child.emit('exit', 0, null)
  const current = await f.api.openTerminal({ name: 'build', waitMs: 0 })
  f.children[1].stdout.emit('data', 'current output')
  const read = await f.api.readTerminal('build')
  assert.equal(read.id, current.id)
  assert.equal(read.output, 'current output')
  assert.match((await f.api.readTerminal(f.terminal.id)).output, /old output/)
})

test('closing a reused terminal name closes the running session, not its retained predecessor', async () => {
  const f = await fixture({ name: 'build' })
  f.child.emit('exit', 0, null)
  const current = await f.api.openTerminal({ name: 'build', waitMs: 0 })
  assert.equal(f.api.closeTerminal('build').id, current.id)
  assert.equal(f.children[1].ends, 1)
  assert.equal(f.child.ends, 0)
  assert.equal(f.api.listTerminals().length, 2)
  f.api.closeTerminal(f.terminal.id)
  assert.deepEqual(f.api.listTerminals().map(t => t.id), [current.id])
})

test('an exited reused name resolves to the last-opened session even with tied timestamps', async t => {
  t.mock.method(Date, 'now', () => 1000)
  const f = await fixture({ name: 'build' })
  f.child.emit('exit', 0, null)
  const current = await f.api.openTerminal({ name: 'build', waitMs: 0 })
  assert.equal(current.startedAt, f.terminal.startedAt)
  f.children[1].emit('error', new Error('new session failed'))
  const read = await f.api.readTerminal('build')
  assert.equal(read.id, current.id)
  assert.match(read.output, /new session failed/)
  assert.equal(f.api.closeTerminal('build').id, current.id)
  assert.equal((await f.api.readTerminal('build')).id, f.terminal.id)
  f.api.closeTerminal('build')
  await assert.rejects(f.api.readTerminal('build'), /No terminal/)
})

test('exact terminal IDs take precedence over another session with that name', async () => {
  const f = await fixture()
  f.child.emit('exit', 0, null)
  const named = await f.api.openTerminal({ name: f.terminal.id, waitMs: 0 })
  assert.equal((await f.api.readTerminal(f.terminal.id)).id, f.terminal.id)
  await assert.rejects(f.api.sendToTerminal(f.terminal.id, { input: 'command', waitMs: 0 }), /has exited/)
  assert.equal(f.api.closeTerminal(f.terminal.id).id, f.terminal.id)
  assert.equal((await f.api.readTerminal(f.terminal.id)).id, named.id)
})

test('invalid terminal wait patterns and keys cannot execute the command', async () => {
  const f = await fixture()
  await assert.rejects(f.api.sendToTerminal(f.terminal.id, { input: 'side-effect', until: '[', waitMs: 0 }), /Invalid until/)
  await assert.rejects(f.api.sendToTerminal(f.terminal.id, { input: 'side-effect', keys: ['invalid'], waitMs: 0 }), /Unknown key/)
  assert.deepEqual(f.writes, [])
  await f.api.sendToTerminal(f.terminal.id, { input: 'valid', waitMs: 0 })
  assert.deepEqual(f.writes, ['valid\r'])
})

test('a terminal spawn failure is reported as exited and cannot occupy an active slot forever', async () => {
  const f = await fixture()
  f.child.emit('error', new Error('Python missing'))
  assert.equal(f.api.listTerminals()[0].running, false)
  assert.match((await f.api.readTerminal(f.terminal.id)).output, /Python missing/)
  await assert.rejects(f.api.sendToTerminal(f.terminal.id, { input: 'command' }), /has exited/)
})

test('terminal cleanup preserves backspace, overwrite and whitespace behavior', async () => {
  const { api: { cleanOutput } } = await fixture()
  const cases = [
    ['', ''],
    ['\b\babc', 'abc'],
    ['abc\b\bX', 'aX'],
    ['ab\b\b\bZ', 'Z'],
    ['ab\bc\bD', 'aD'],
    ['a\x00\bZ', 'aZ'], // Controls are erased by backspaces before being stripped.
    ['a\t\bZ \t', 'aZ'],
    ['ab\b\n\bc\bD\n', 'a\nD\n'],
    ['old\b\rnew\b!\r\n', 'ne!\n'],
    ['old\r\r', ''],
    ['old\r\r\nnext', 'old\nnext'],
    ['old\r\bnew', 'new'],
    ['\x1b[31mab\b\x1b[0m \t\r\n', 'a\n'],
    ['a\x1b]7;file://host/dir\x07\bZ', 'Z'],
    ['\x1b(Ba\x1b=\bZ', 'Z'],
    [' \tindented\ttext \t\u00a0', ' \tindented\ttext'],
    ['😀\bX', '\ud83dX'], // The existing normalizer erases UTF-16 code units.
    ['😀\b\bX', 'X'],
    ['a\u2028\bZ\x7f', 'aZ']
  ]
  for (const [raw, expected] of cases) assert.equal(cleanOutput(raw), expected, JSON.stringify(raw))
})

test('terminal reads and pattern waits clean large backspace-heavy output', async () => {
  const f = await fixture()
  const raw = '\x1b[32m' + 'ab\b'.repeat(30_000) + '\x1b[0m\r\nready \t'
  const expected = 'a'.repeat(30_000) + '\nready'
  f.child.stdout.emit('data', raw)
  const read = await f.api.readTerminal(f.terminal.id, { since: 0, maxChars: 100_000 })
  assert.equal(read.output, expected)
  assert.equal(read.cursor, raw.length)
  assert.equal(read.truncated, false)
  assert.equal((await f.api.readTerminal(f.terminal.id, { since: 0, maxChars: 10 })).output, expected.slice(-10))
  assert.equal((await f.api.readTerminal(f.terminal.id, { since: 0, maxChars: 100_000, raw: true })).output, raw)

  f.child.stdin.write = () => { f.child.stdout.emit('data', raw); return true }
  const sent = await f.api.sendToTerminal(f.terminal.id, { input: 'command', until: '^ready$', waitMs: 0 })
  assert.equal(sent.output, expected)
  assert.equal(sent.matched, true)
})
