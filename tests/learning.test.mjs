import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { loadModule } from './load-module.mjs'

const policy = await loadModule('src/main/learning-policy.ts')
const run = (id, patch = {}) => ({ id, prompt: 'Deploy the application', result: 'verified', status: 'succeeded', provider: 'codex', cwd: '/tmp', trigger: 'ui', ...patch })
const calls = n => Array.from({ length: n }, (_, i) => ({ type: 'tool_call', data: { name: 'shell', input: { command: `step ${i}` } } }))

test('learning requires evidence, captures short corrections, and skips already-saved lessons', () => {
  assert.equal(policy.learningSignal(run('1'), calls(5), 5, false, false), null)
  assert.equal(policy.learningSignal(run('1'), calls(12), 5, false, false), 'substantial task without a saved procedure')
  assert.equal(policy.learningSignal(run('1'), calls(12), 5, true, false), null)
  const corrected = [{ type: 'user', data: { text: 'Deploy the application' } }, { type: 'user', data: { text: 'I meant the staging deployment instead', steering: true } }]
  assert.ok(policy.learningSignal(run('1'), corrected, 5, false, false))
  assert.equal(policy.learningSignal(run('1'), corrected, 5, false, true), null)
  const recovered = [...calls(5), { type: 'tool_result', data: { isError: true, output: 'wrong path' } }]
  assert.equal(policy.learningSignal(run('1'), recovered, 5, false, false), 'recovered tool failure')
  assert.equal(policy.learningSignal(run('1', { status: 'failed' }), recovered, 5, false, false), 'tool failure needs review')
})

test('an opening task prompt is not a correction unless it follows an earlier turn; recovered errors are not urgent', () => {
  const opening = [{ type: 'user', data: { text: 'Use pnpm instead of npm and find what is wrong with the build' } }]
  assert.equal(policy.learningSignal(run('1'), opening, 5, false, false), null)
  assert.equal(policy.learningSignal(run('1'), opening, 5, false, false, true), 'user correction or explicit instruction')
  const recovered = [...calls(5), { type: 'tool_result', data: { isError: true, output: 'no such file' } }]
  assert.equal(policy.learningSignalWithUrgency(run('1'), recovered, 5, false, false).urgency, 'normal')
  assert.equal(policy.learningSignalWithUrgency(run('1', { status: 'failed' }), recovered, 5, false, false).urgency, 'high')
})

test('review digest retains successful evidence and stays bounded; review cannot execute procedures', () => {
  const evidence = [...calls(5), { type: 'tool_result', data: { isError: false, output: 'deploy --target staging succeeded' } }]
  assert.match(policy.learningDigest(run('1'), evidence), /deploy --target staging succeeded/)
  assert.ok(policy.learningDigest(run('1', { prompt: 'x'.repeat(50_000) }), calls(100)).length <= 9000)
  assert.equal(policy.reviewToolAllowed('Bash', { command: 'anything' }), false)
  assert.equal(policy.reviewToolAllowed('mcp__harness__harness_call', { op: 'gateways_send' }), false)
  assert.equal(policy.reviewToolAllowed('mcp__harness__harness_call', { op: 'skills_patch' }), true)
})

async function learningHarness() {
  let profile = 'owner', active = false, recent = true, reject = false
  const bus = new EventEmitter(), stores = new Map(), tasks = new Map(), events = new Map(), activity = new Map(), started = []
  const config = { timezone: 'America/New_York', learning: { reflect: true, curate: false, minToolCalls: 5, minTasksBetween: 10, cooldownHours: 0, effort: 'low' } }
  const kv = () => { if (!stores.has(profile)) stores.set(profile, new Map()); return stores.get(profile) }
  const api = await loadModule('src/main/learning.ts', {
    './profile-context': { profileId: () => profile, bindProfile: fn => fn },
    './bus': { bus }, './config': { cfg: () => config },
    './db': { getDb: () => ({ prepare: sql => ({ get: () => sql.includes('title LIKE') ? active : recent }) }), getRun: id => tasks.get(id), listEvents: id => events.get(id) ?? [], kvGet: k => structuredClone(kv().get(k) ?? null), kvSet: (k, v) => kv().set(k, structuredClone(v)) },
    './skill-usage': { runSkillActivity: id => activity.get(id) ?? { loaded: false, saved: false }, evaluateSkills: () => [] },
    './memory': { listMemoryFiles: () => [] }, './faults': { recordFault: () => null },
    './runs': { startRun: input => { if (reject) throw Error('maintenance'); started.push(input); return { id: `review-${started.length}` } } }
  })
  api.startLearning()
  return { api, started, stores, config, setProfile: p => { profile = p }, setActive: v => { active = v }, setRecent: v => { recent = v }, setReject: v => { reject = v }, finish(id, ev = calls(12), patch = {}, kind = 'task', saved = false) { const r = run(id, patch); tasks.set(id, r); events.set(id, ev); activity.set(id, { loaded: false, saved }); bus.emit('run:finished', r, kind) } }
}

test('100 substantial user tasks produce at most ten bounded reviews, never recursive or scheduled reviews', async () => {
  const h = await learningHarness()
  for (let i = 0; i < 100; i++) h.finish(String(i))
  assert.equal(h.started.length, 10)
  assert.ok(h.started.every(s => !s.forkFrom && s.prompt.length < 22_000))
  h.finish('scheduled', calls(12), { trigger: 'schedule' })
  h.finish('background', calls(12), { trigger: 'agent' }, 'reflection')
  assert.equal(h.started.length, 10)
})

test('routine tasks and foreground saves spend no reflection runs; corrections survive batching and active review deferral', async () => {
  const h = await learningHarness()
  for (let i = 0; i < 20; i++) h.finish(`routine-${i}`, calls(5))
  for (let i = 0; i < 20; i++) h.finish(`saved-${i}`, calls(12), {}, 'task', true)
  assert.equal(h.started.length, 0)
  h.setActive(true)
  h.finish('correction', [{ type: 'user', data: { text: 'Next time use the staging target', steering: true } }])
  assert.equal(h.started.length, 0)
  h.setActive(false); h.finish('next', calls(1))
  assert.equal(h.started.length, 1)
  assert.match(h.started[0].prompt, /Next time use the staging target/)
})

test('a recovered tool error waits for the normal batch instead of starting a review per task', async () => {
  const h = await learningHarness()
  const recovered = [...calls(5), { type: 'tool_result', data: { isError: true, output: 'no such file' } }]
  for (let i = 0; i < 9; i++) h.finish(`recovered-${i}`, recovered)
  assert.equal(h.started.length, 0)
  h.finish('recovered-9', recovered)
  assert.equal(h.started.length, 1)
})

test('cooldown and per-profile counters persist; rejected admissions retain evidence; idle curation skips', async () => {
  const h = await learningHarness()
  h.config.learning.cooldownHours = 6
  for (let i = 0; i < 20; i++) h.finish(`owner-${i}`)
  assert.equal(h.started.length, 1)
  h.setProfile('alice')
  for (let i = 0; i < 9; i++) h.finish(`alice-${i}`)
  assert.equal(h.started.length, 1)
  h.setReject(true)
  const originalError = console.error; console.error = () => {}
  try { h.finish('alice-9') } finally { console.error = originalError }
  assert.equal(h.started.length, 1)
  h.setReject(false); h.finish('alice-10', calls(1))
  assert.equal(h.started.length, 2)
  assert.match(h.started[1].prompt, /Signal:/)
  h.setRecent(false)
  assert.equal(h.api.curate(false), null)
  assert.ok(h.api.curate())
})

test('skill pointers are bounded and relevant; patches preserve versions and pinned skills resist agent writes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-skill-learning-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const s = await loadModule('src/main/skills.ts', { './config': { cfg: () => ({ skillsDir: dir }) }, './paths': { expandHome: x => x } })
  const content = (name, description, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n1. Verify deployment.`
  s.saveSkill('staging-deploy', content('staging-deploy', 'Deploy staging application and verify rollback'))
  s.saveSkill('staging-check', content('staging-check', 'Check staging deployment application health'))
  s.saveSkill('staging-rollback', content('staging-rollback', 'Rollback staging application deployment'))
  s.saveSkill('meetings', content('meetings', 'Read Granola meeting notes'))
  assert.equal(s.skillHints('hello how are you').text, '')
  assert.equal(s.skillHints('please help with my application').text, '', 'one generic word is insufficient')
  const hint = s.skillHints('deploy staging application')
  assert.equal(hint.names.length, 2)
  assert.ok(!hint.names.includes('meetings'))
  assert.ok(hint.text.length < 850)
  assert.doesNotMatch(hint.text, /1\. Verify/)
  s.patchSkill('staging-deploy', 'Verify deployment.', 'Verify deployment and rollback.', true)
  assert.match(s.readSkill('staging-deploy').content, /and rollback/)
  const history = join(s.readSkill('staging-deploy').skill.dir, '.history')
  assert.match(readFileSync(join(history, readdirSync(history)[0]), 'utf8'), /1\. Verify deployment\./)
  assert.throws(() => s.patchSkill('staging-deploy', 'missing', 'new'), /match exactly once/)
  s.saveSkill('meetings', content('meetings', 'Read Granola meeting notes', 'pinned: true\n'))
  assert.throws(() => s.patchSkill('meetings', 'Verify deployment.', 'Changed', true), /Pinned/)
  assert.throws(() => s.saveSkill('invalid', 'no frontmatter'), /frontmatter/)
  s.saveSkill('folder-name', content('folder-name', 'Original skill'))
  writeFileSync(s.readSkill('folder-name').skill.path, content('renamed', 'Renamed in frontmatter', 'pinned: true\n'))
  assert.throws(() => s.saveSkill('folder-name', content('folder-name', 'Agent overwrite'), true), /already holds another skill/)
  assert.match(s.readSkill('renamed').content, /pinned: true/)
})

test('skill retrieval counts deduplicate by task and distinguish suggestions from loads and task outcomes', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT); CREATE TABLE skill_activity (name TEXT, run_id TEXT, action TEXT, ts INTEGER, PRIMARY KEY(name,run_id,action)); INSERT INTO runs VALUES ('a','succeeded'),('b','failed');`)
  const s = await loadModule('src/main/skill-usage.ts', { './db': { getDb: () => db } })
  s.recordSkill('deploy', 'a', 'suggested'); s.recordSkill('deploy', 'a', 'loaded'); s.recordSkill('deploy', 'a', 'loaded'); s.recordSkill('deploy', 'b', 'loaded')
  assert.deepEqual({ ...s.skillStats()[0] }, { name: 'deploy', suggested: 1, loaded: 2, succeeded: 1, failed: 1, lastLoadedAt: s.skillStats()[0].lastLoadedAt })
  assert.deepEqual(s.runSkillActivity('a'), { loaded: true, saved: false })
  s.recordSkill('deploy', 'a', 'saved'); assert.equal(s.runSkillActivity('a').saved, true)
  db.close()
})
