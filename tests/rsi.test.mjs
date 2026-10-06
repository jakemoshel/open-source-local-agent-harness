import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadModule } from './load-module.mjs'

const rsi = await loadModule('src/shared/rsi.ts')
const scope = { size: 'small', reason: 'Known local fix', files: ['one.ts'], components: ['runtime'], estimatedMinutes: 10, validation: 'checks', priority: 65 }
test('RSI defaults, saved-config migration and review-driven routing', () => {
  const settings = rsi.rsiSettingsSchema.parse({ enabled: true, maxPerDay: 100 })
  assert.equal(settings.small.model, 'sonnet'); assert.equal(settings.large.model, 'sol')
  assert.equal(settings.maxAttempts, 0); assert.equal(settings.maxPerDay, 100)
  assert.equal(rsi.routeAssessment(scope, settings).size, 'small')
  for (const change of [{ files: ['a', 'b', 'c', 'd'] }, { components: ['a', 'b'] }, { estimatedMinutes: 31 }, { size: 'large' }]) assert.equal(rsi.routeAssessment({ ...scope, ...change }, settings).size, 'large')
  assert.equal(rsi.routeAssessment({ ...scope, files: ['a', 'b', 'c', 'd'] }, { ...settings, smallMaxFiles: 4 }).size, 'small')
  assert.equal(rsi.routeAssessment({ ...scope, priority: 100 }, settings).size, 'small', 'severity does not inflate implementation size')
  assert.throws(() => rsi.assessmentSchema.parse({ ...scope, reason: '' }))
})

test('incremental context FTS refreshes edits, removes deleted/forgotten records and separates profiles', async t => {
  const root = mkdtempSync(join(tmpdir(), 'rsi-context-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  const file = join(root, 'deploy.md'), other = join(root, 'other.md')
  writeFileSync(file, '---\nid: deployment\naliases: [shipping]\n---\nRelease to Kubernetes with helm')
  writeFileSync(other, 'Persistent unrelated content')
  let profile = 'owner'
  const c = await loadModule('src/main/context.ts', {
    './config': { cfg: () => ({ memory: { contextRoots: [root] } }) }, './paths': { expandHome: x => x },
    './profile-context': { profileId: () => profile }, './db': { getDb: () => db, kvGet() {}, kvSet() {}, listRuns: () => [] }, './rsi-metrics': { recordRsiMetric() {} }
  })
  assert.equal(c.contextSearch('shipping')[0].id, 'deployment')
  assert.equal(c.contextSearch('Kubernetes')[0].id, 'deployment')
  const unchanged = c.records().find(r => r.path === other)
  writeFileSync(file, '---\nid: deployment\n---\nRelease to Nomad')
  c.invalidateContext()
  assert.equal(c.contextSearch('Kubernetes').length, 0); assert.equal(c.contextSearch('Nomad').length, 1)
  assert.equal(c.records().find(r => r.path === other), unchanged, 'unchanged markdown is not reparsed')
  writeFileSync(file, '---\nid: deployment\nstatus: forgotten\n---\nRelease to Nomad')
  c.invalidateContext(); assert.equal(c.contextSearch('Nomad').length, 0)
  assert.equal(db.prepare("SELECT body FROM context_fts WHERE path = ?").get(file).body, '')
  rmSync(file); c.invalidateContext(); c.records()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM context_stamps WHERE path = ?').get(file).n, 0)
  profile = 'member'; assert.equal(c.contextSearch('unrelated').length, 1)
})

test('run and updater measurements use observed duration and installed commit buckets', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  db.exec('CREATE TABLE rsi_metrics(id INTEGER PRIMARY KEY, ts INTEGER, commit_sha TEXT, kind TEXT, data TEXT); CREATE TABLE events(run_id TEXT, type TEXT, data TEXT)')
  const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?)')
  insert.run('r', 'tool_result', JSON.stringify({ isError: true })); insert.run('r', 'user', JSON.stringify({ text: 'Deploy instead of testing' })); insert.run('r', 'user', JSON.stringify({ text: 'I meant staging', steering: true }))
  const bus = new EventEmitter()
  const m = await loadModule('src/main/rsi-metrics.ts', {
    './bus': { bus }, './db': { getDb: () => db },
    './profile-context': { OWNER_ID: 'owner', withProfile: (_id, fn) => fn() }
  })
  m.startRsiMetrics()
  bus.emit('run:finished', { id: 'r', createdAt: 1, startedAt: 2, finishedAt: 102, status: 'succeeded', provider: 'claude', model: 'sonnet' }, 'task')
  bus.emit('update:status', { state: 'building', phase: 'building', remoteCommit: 'next-commit' })
  bus.emit('update:status', { state: 'available', phase: 'ready', remoteCommit: 'next-commit' })
  const rows = m.rsiStatistics()
  assert.equal(rows.find(r => r.kind === 'task').durationMs, 100)
  assert.equal(rows.find(r => r.kind === 'task').toolErrors, 1)
  assert.equal(rows.find(r => r.kind === 'task').corrections, 1)
  assert.equal(rows.find(r => r.kind === 'build').commit, 'next-commit')
})
