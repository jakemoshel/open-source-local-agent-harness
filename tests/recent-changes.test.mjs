import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deferred, loadModule, tick } from './load-module.mjs'

async function scheduleOpsFixture() {
  const config = await loadModule('src/main/config.ts', { './db': { audit() {} } })
  const scheduler = await loadModule('src/main/scheduler.ts', {
    './config': config,
    './db': { audit() {}, kvGet() {}, kvSet() {} },
    './runs': { startRun() {}, waitForRun() {} },
    './maintenance': { holdCompletion() {} },
    './schedule-notifications': { notifyScheduledRun() {} }
  })
  // Isolate unrelated operations; unexpected dependency calls must fail loudly.
  const mocks = Object.fromEntries([...readFileSync('src/main/ops.ts', 'utf8').matchAll(/import \{ ([^}]+) \} from '(\.\/[^']+)'/g)].map(([, names, path]) => [
    path, Object.fromEntries(names.split(',').map((name) => [name.trim(), () => { throw new Error(`Unexpected call to ${path}:${name}`) }]))
  ]))
  const schedules = { value: { schedules: [] }, write(value) { this.value = value } }
  const audits = []
  const api = await loadModule('src/main/ops.ts', {
    ...mocks,
    electron: { shell: {} },
    './config': { ...config, files: { schedules }, cfg: () => ({ defaultProvider: 'claude' }) },
    './db': { ...mocks['./db'], audit: (...args) => audits.push(args) },
    './scheduler': scheduler,
    './runs': { ...mocks['./runs'], runKind: () => 'task' },
    './faults': { ...mocks['./faults'], recordFault() {} },
    './models': { ...mocks['./models'], listModels: async () => ({ models: [], live: false }) },
    './granola-sync': {}, './terminal': {}, './doctor': {}
  })
  return { schedules, audits, upsert: (args) => api.invoke('schedules_upsert', args, { actor: 'agent', admin: true }) }
}

test('schedule field-only updates preserve recurring and one-off job fields', async () => {
  const { schedules, audits, upsert } = await scheduleOpsFixture()
  for (const timing of [{ cron: '0 9 * * *' }, { runAt: '2099-01-01T09:00:00-05:00' }]) {
    let expected = {
      id: 'daily', name: 'Daily', cron: '', prompt: 'Send my briefing', enabled: true,
      provider: 'claude', model: 'saved-model', cwd: '/tmp', timezone: 'America/New_York',
      persistentConversation: true, source: 'custom', ...timing
    }
    schedules.value = { schedules: [expected] }
    for (const patch of [{ enabled: false }, { name: 'Renamed' }, { deliver: { gateway: 'slack', target: 'C123' } }]) {
      const before = expected
      expected = { ...expected, ...patch }
      assert.deepEqual(await upsert({ id: 'daily', ...patch }), expected)
      assert.deepEqual(schedules.value.schedules, [expected])
      assert.deepEqual(audits.at(-1).slice(3), [before, expected])
    }
  }
})

test('one-off schedule renames do not erase their prompt', async () => {
  const { schedules, upsert } = await scheduleOpsFixture()
  const before = { id: 'reminder', name: 'Reminder', cron: '', runAt: '2099-01-01T09:00:00-05:00', prompt: 'Remember the appointment', enabled: true }
  schedules.value = { schedules: [before] }
  assert.deepEqual(await upsert({ id: before.id, name: 'Appointment' }), { ...before, name: 'Appointment' })
})

test('schedule creation requirements, defaults and invalid updates remain enforced', async () => {
  const { schedules, audits, upsert } = await scheduleOpsFixture()
  for (const args of [{ cron: '0 9 * * *' }, { id: 'unknown', enabled: false }, { name: 'Missing timing' }]) {
    await assert.rejects(upsert(args))
    assert.deepEqual(schedules.value.schedules, [])
  }
  const created = await upsert({ name: 'Backup', cron: '0 9 * * *', op: 'memory_backup' })
  assert.equal(typeof created.id, 'string')
  assert.equal(created.enabled, true)
  assert.equal(created.prompt, '')
  for (const patch of [{ cron: 'invalid' }, { runAt: 'invalid' }, { runAt: '2000-01-01T09:00:00-05:00' }, { timezone: 'invalid' }, { op: 'schedules_delete' }]) {
    await assert.rejects(upsert({ id: created.id, ...patch }))
    assert.deepEqual(schedules.value.schedules, [created])
    assert.equal(audits.length, 1)
  }
  const oneOff = await upsert({ name: 'Reminder', runAt: '2099-01-01T09:00:00-05:00', prompt: 'Remember' })
  assert.equal(oneOff.cron, '')
  assert.equal(oneOff.enabled, true)
})

test('schedule resets and provider changes preserve unrelated fields', async () => {
  const { schedules, upsert } = await scheduleOpsFixture()
  const before = { id: 'daily', name: 'Daily', cron: '0 9 * * *', prompt: 'Briefing', enabled: false,
    provider: 'claude', model: 'saved-model', effort: 'high', timezone: 'America/New_York', cwd: '/tmp', deliver: { gateway: 'slack', target: 'C123' } }
  schedules.value = { schedules: [before] }
  const { model, effort, ...switched } = before
  assert.deepEqual(await upsert({ id: before.id, provider: 'codex' }), { ...switched, provider: 'codex' })
  const { provider, timezone, cwd, deliver, ...reset } = switched
  assert.deepEqual(await upsert({ id: before.id, provider: null, timezone: null, cwd: null, deliver: null }), reset)
  assert.deepEqual(await upsert({ id: before.id, prompt: '' }), { ...reset, prompt: '' })
})

test('Granola connection detection follows MCP changes without deleting its schedule', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-granola-config-'))
  try {
    const paths = Object.fromEntries(['config', 'safeguards', 'schedules', 'mcp', 'soul', 'memories', 'skills'].map((name) => [name, join(root, name)]))
    paths.home = root
    const c = await loadModule('src/main/config.ts', {
      './paths': { paths, migratedFromLegacy: false },
      './profile-context': { isOwner: () => true, bindProfile: (fn) => fn },
      './db': { audit() {} }
    })
    c.files.config.load()
    c.files.schedules.load()
    c.files.mcp.load()
    c.files.mcp.write({ mcpServers: { granola: { type: 'http', url: 'https://mcp.granola.ai/mcp' } } })
    c.ensureGranolaArchiveSchedule()
    assert.equal(c.files.schedules.value.schedules.find((s) => s.id === 'granola-archive')?.enabled, true)
    assert.equal(c.files.schedules.value.schedules.find((s) => s.id === 'granola-archive')?.op, 'meetings_sync_direct')
    const archive = c.files.schedules.value.schedules.find(s => s.id === 'granola-archive')
    c.files.schedules.write({ schedules: [{ ...archive, op: undefined, prompt: "Archive Granola meetings into Jarvis's separate meetings memory. Legacy steps", enabled: false, cron: '0 12 * * *' }] })
    c.ensureGranolaArchiveSchedule()
    assert.equal(c.files.schedules.value.schedules[0].op, 'meetings_sync_direct')
    assert.equal(c.files.schedules.value.schedules[0].enabled, false)
    assert.equal(c.files.schedules.value.schedules[0].cron, '0 12 * * *')
    c.files.schedules.write({ schedules: [{ ...archive, source: 'custom', op: undefined, prompt: 'My own sync procedure' }] })
    c.ensureGranolaArchiveSchedule()
    assert.equal(c.files.schedules.value.schedules[0].prompt, 'My own sync procedure')
    assert.equal(c.files.schedules.value.schedules[0].op, undefined)
    c.files.mcp.write({ mcpServers: {} })
    c.ensureGranolaArchiveSchedule()
    assert.equal(c.files.schedules.value.schedules.find((s) => s.id === 'granola-archive')?.enabled, true)
    assert.equal(c.hasGranolaConnection(), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('nightly Granola job arms only while its MCP connection is available', async () => {
  const bus = new EventEmitter()
  const created = []
  let connected = false
  class FakeCron {
    constructor(expr, opts) { this.expr = expr; this.opts = opts; this.stopped = false; created.push(this) }
    stop() { this.stopped = true }
    nextRuns() { return [] }
  }
  const schedule = { id: 'granola-archive', name: 'Archive', cron: '30 20 * * *', prompt: 'sync', enabled: true }
  const scheduler = await loadModule('src/main/scheduler.ts', {
    'croner': { Cron: FakeCron },
    './profile-context': { profileId: () => 'owner', bindProfile: (fn) => fn },
    './bus': { bus },
    './config': { cfg: () => ({ timezone: 'America/New_York' }), files: { schedules: { value: { schedules: [schedule] } } }, hasGranolaConnection: () => connected, MEMORY_INGEST_PROMPT: 'ingest', MEMORY_REVIEW_PROMPT: 'review' },
    './db': { audit() {}, kvGet: () => null, kvSet() {} },
    './schedule-notifications': { notifyScheduledRun: async () => {} },
    './runs': { startRun() {}, waitForRun() {} }
  })
  try {
    scheduler.startScheduler()
    assert.equal(created.filter((c) => !c.opts.paused).length, 0)
    connected = true
    bus.emit('config:changed', 'mcp')
    const armed = created.find((c) => !c.opts.paused)
    assert.ok(armed)
    connected = false
    bus.emit('config:changed', 'mcp')
    assert.equal(armed.stopped, true)
    assert.equal(created.filter((c) => !c.opts.paused).length, 1)
  } finally {
    scheduler.stopScheduler()
  }
})

async function schedulerFixture(initial) {
  const bus = new EventEmitter()
  const profiles = await loadModule('src/main/profile-context.ts')
  const stores = new Map()
  const runs = []
  const completions = new Map()
  const store = () => {
    const id = profiles.profileId()
    if (!stores.has(id)) stores.set(id, {
      kv: new Map(),
      schedules: {
        value: { schedules: initial.map(s => ({ ...s })) },
        write(value) { this.value = value; bus.emit('config:changed', 'schedules') }
      }
    })
    return stores.get(id)
  }
  const scheduler = await loadModule('src/main/scheduler.ts', {
    './profile-context': profiles,
    './bus': { bus },
    './config': {
      cfg: () => ({ timezone: 'UTC' }), files: { get schedules() { return store().schedules } },
      hasGranolaConnection: () => false, MEMORY_INGEST_PROMPT: 'ingest', MEMORY_REVIEW_PROMPT: 'review'
    },
    './db': { audit() {}, kvGet: key => store().kv.get(key) ?? null, kvSet: (key, value) => store().kv.set(key, value) },
    './maintenance': { holdCompletion: () => () => {} },
    './schedule-notifications': { notifyScheduledRun: async () => {} },
    './runs': {
      startRun(input) {
        const run = { id: `run-${runs.length}`, input, profile: profiles.profileId() }
        runs.push(run)
        completions.set(run.id, deferred())
        return run
      },
      waitForRun: id => completions.get(id).promise
    }
  })
  async function finish() {
    for (const [id, done] of completions) done.resolve({ id, status: 'completed' })
    await tick()
  }
  return { scheduler, bus, profiles, store, runs, finish, async close() { scheduler.stopScheduler(); await finish() } }
}

const reminder = (id, at, enabled = false) => ({ id, name: id, cron: '', runAt: new Date(at).toISOString(), prompt: `Remember ${id}`, enabled })
const schedulerNow = Date.parse('2026-10-03T12:00:00Z')

test('enabling an overdue one-off catches up once after startup', async t => {
  const f = await schedulerFixture([reminder('recent', schedulerNow - 60_000)])
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: schedulerNow })
  try {
    f.scheduler.startScheduler()
    t.mock.timers.tick(60_000)
    assert.equal(f.runs.length, 0, 'disabled reminders must not run at startup')
    f.store().schedules.write({ schedules: [{ ...f.store().schedules.value.schedules[0], enabled: true }] })
    f.bus.emit('config:changed', 'config')
    f.bus.emit('config:changed', 'mcp')
    assert.equal(f.runs.length, 0, 'catch-up must be deferred beyond the config write')
    t.mock.timers.tick(1)
    assert.equal(f.runs.length, 1, 'enabling a recent overdue reminder must start it without restart or wake')
    assert.equal(f.runs[0].input.triggerRef, 'recent')
    f.scheduler.catchUpSchedules()
    assert.equal(f.runs.length, 1, 'overlapping catch-up passes must share the in-flight run')
    await tick()
    t.mock.timers.tick(1)
    assert.equal(f.store().schedules.value.schedules[0].enabled, false)
    await f.finish()
    f.store().schedules.write({ schedules: [{ ...f.store().schedules.value.schedules[0], enabled: true }] })
    t.mock.timers.tick(1)
    await tick()
    assert.equal(f.runs.length, 1, 'a previously fired reminder must not replay after re-enabling')
    assert.equal(f.store().schedules.value.schedules[0].enabled, false)
  } finally { await f.close() }
})

test('schedule-change catch-up retires expired one-offs and leaves future or disabled jobs alone', async t => {
  const initial = [reminder('boundary', schedulerNow - 12 * 3600_000), reminder('expired', schedulerNow - 12 * 3600_000 - 1),
    reminder('future', schedulerNow + 3600_000), reminder('disabled', schedulerNow - 60_000)]
  const f = await schedulerFixture(initial)
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: schedulerNow })
  try {
    f.scheduler.startScheduler()
    f.store().schedules.write({ schedules: initial.map(s => ({ ...s, enabled: s.id !== 'disabled' })) })
    t.mock.timers.tick(0)
    await tick()
    t.mock.timers.tick(1)
    assert.deepEqual(f.runs.map(r => r.input.triggerRef), ['boundary'])
    assert.deepEqual(f.store().schedules.value.schedules.map(s => [s.id, s.enabled]),
      [['boundary', false], ['expired', false], ['future', true], ['disabled', false]])
  } finally { await f.close() }
})

test('deferred schedule catch-up keeps the changed profile and observes cancellation', async t => {
  const f = await schedulerFixture([reminder('recent', schedulerNow - 60_000)])
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: schedulerNow })
  try {
    f.scheduler.startScheduler()
    f.profiles.withProfile('member', () => {
      f.scheduler.startScheduler()
      f.store().schedules.write({ schedules: [{ ...f.store().schedules.value.schedules[0], enabled: true }] })
    })
    t.mock.timers.tick(1)
    await tick()
    assert.deepEqual(f.runs.map(r => r.profile), ['member'])
    assert.equal(f.store().schedules.value.schedules[0].enabled, false, 'owner schedules must remain untouched')
    f.store().schedules.write({ schedules: [{ ...f.store().schedules.value.schedules[0], enabled: true }] })
    f.store().schedules.write({ schedules: [{ ...f.store().schedules.value.schedules[0], enabled: false }] })
    t.mock.timers.tick(1)
    assert.equal(f.runs.length, 1, 'disabling before catch-up must cancel the reminder')
    f.store().schedules.write({ schedules: [{ ...f.store().schedules.value.schedules[0], enabled: true }] })
    f.scheduler.stopScheduler()
    t.mock.timers.tick(1)
    assert.equal(f.runs.length, 1, 'stopping must cancel pending catch-up')
    f.bus.emit('config:changed', 'schedules')
    t.mock.timers.tick(60_000)
    assert.equal(f.runs.length, 1, 'config changes must not restart a stopped scheduler')
  } finally { await f.close() }
})

test('one-click setup installs only missing CLIs and coalesces concurrent clicks', async () => {
  let installed = false
  const commands = []
  const installer = await loadModule('src/main/cli-install.ts', {
    'node:child_process': { execFile: (bin, args, options, callback) => {
      commands.push({ bin, args, options })
      setImmediate(() => { if (bin === '/usr/bin/npm') installed = true; callback(null, '', '') })
    } },
    'node:fs': { mkdirSync: () => undefined, readFileSync: () => '{}' },
    './auth': { claudeBinary: () => '/usr/local/bin/claude', codexBinary: () => installed ? '/tmp/jarvis/cli/bin/codex' : null },
    './env': { agentEnv: () => ({ PATH: '/usr/bin:/bin' }) },
    './profile-context': { ROOT_HOME: '/tmp/jarvis' },
    './paths': { which: () => '/usr/bin/npm' }
  })
  const [a, b] = await Promise.all([installer.installMissingClis(), installer.installMissingClis()])
  assert.deepEqual(a, ['codex'])
  assert.deepEqual(b, ['codex'])
  const npm = commands.filter((c) => c.bin === '/usr/bin/npm')
  assert.equal(npm.length, 1)
  assert.deepEqual(npm[0].args, ['install', '--global', '--prefix', '/tmp/jarvis/cli', '@openai/codex'])
})

test('a Claude placeholder left by npm without install scripts is repaired by running its postinstall', async () => {
  let fixed = false
  const commands = []
  const claude = '/tmp/jarvis/cli/bin/claude'
  const installer = await loadModule('src/main/cli-install.ts', {
    'node:child_process': { execFile: (bin, args, options, callback) => {
      commands.push({ bin, args, cwd: options.cwd })
      setImmediate(() => {
        if (bin === '/bin/sh') fixed = true
        if (bin === claude && args[0] === '--version' && !fixed) return callback(Object.assign(new Error('Command failed'), { stderr: 'Error: claude native binary not installed.' }), '', '')
        callback(null, '', '')
      })
    } },
    'node:fs': { mkdirSync: () => undefined, readFileSync: () => JSON.stringify({ scripts: { postinstall: 'node install.cjs' } }) },
    './auth': { claudeBinary: () => claude, codexBinary: () => '/tmp/jarvis/cli/bin/codex' },
    './env': { agentEnv: () => ({ PATH: '/usr/bin:/bin' }) },
    './profile-context': { ROOT_HOME: '/tmp/jarvis' },
    './paths': { which: () => '/usr/bin/npm' }
  })
  assert.deepEqual(await installer.installMissingClis(), ['claude'])
  const post = commands.find((c) => c.bin === '/bin/sh')
  assert.deepEqual(post.args, ['-c', 'node install.cjs'])
  assert.equal(post.cwd, '/tmp/jarvis/cli/lib/node_modules/@anthropic-ai/claude-code')
  assert.equal(await installer.cliWorks(claude), true)
})

test('a stale configured CLI path falls back to the installed command', async () => {
  const auth = await loadModule('src/main/auth.ts', {
    './config': { cfg: () => ({ providers: { claude: { executable: '/missing/claude' }, codex: { executable: 'old-codex' } } }) },
    './env': { agentEnv: () => ({}) },
    './paths': { expandHome: (p) => p, which: (name) => ({ claude: '/tmp/jarvis/cli/bin/claude', codex: '/tmp/jarvis/cli/bin/codex' })[name] ?? null },
    './profile-context': { profileId: () => 'owner' }
  })
  assert.equal(auth.claudeBinary(), '/tmp/jarvis/cli/bin/claude')
  assert.equal(auth.codexBinary(), '/tmp/jarvis/cli/bin/codex')
})
