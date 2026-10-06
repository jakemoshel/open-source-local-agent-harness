import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { loadModule } from './load-module.mjs'

async function config(root) {
  const paths = Object.fromEntries(['config', 'safeguards', 'schedules', 'mcp', 'soul', 'memories', 'skills'].map(name => [name, join(root, name)])); paths.home = root
  return (await loadModule('src/main/config.ts', { './paths': { paths, migratedFromLegacy: false }, './profile-context': { isOwner: () => true, bindProfile: fn => fn }, './db': { audit() {} } })).configSchema
}

test('compact defaults migrate the exact old defaults, preserve custom settings and support disabling snapshots', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-budget-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const schema = await config(root)
  const legacy = { inject: [{ file: 'PROFILE.md', maxChars: 18000 }, { file: 'NOW.md', maxChars: 8000 }, { file: 'TASKS.md', maxChars: 8000 }, { file: 'index.md', maxChars: 10000 }], recap: { enabled: false, maxTurns: 10, maxChars: 12000 } }
  const updated = schema.parse({ memory: legacy }).memory
  assert.equal(updated.inject.reduce((sum, entry) => sum + entry.maxChars, 0), 3600)
  assert.equal(updated.recap.maxChars, 2400); assert.equal(updated.recap.enabled, false)
  assert.deepEqual(updated.startupFiles, ['MEMORY.md'])
  const custom = schema.parse({ memory: { inject: [{ file: 'CUSTOM.md', maxChars: 500 }], recap: { maxTurns: 2, maxChars: 700 }, durableMaxChars: 0 } }).memory
  assert.deepEqual(custom.inject, [{ file: 'CUSTOM.md', maxChars: 500 }]); assert.equal(custom.recap.maxChars, 700); assert.equal(custom.durableMaxChars, 0)
})

test('startup excludes arbitrary memory files, bounds native/durable excerpts, preserves identity, and keeps full sources readable', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-context-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const schema = await config(root), cfg = schema.parse({ memory: { contextRoots: [join(root, 'context')], startupInstructions: 'Explicit user startup rule' } })
  mkdirSync(cfg.memory.memoriesDir, { recursive: true }); mkdirSync(cfg.memory.contextRoots[0])
  writeFileSync(cfg.memory.soulFile, 'Identity rules must survive unchanged.')
  writeFileSync(join(cfg.memory.memoriesDir, 'USER.md'), 'U'.repeat(4000))
  writeFileSync(join(cfg.memory.memoriesDir, 'MEMORY.md'), 'M'.repeat(4000))
  writeFileSync(join(cfg.memory.memoriesDir, 'other.md'), 'NEVER_AUTO_LOAD_THIS '.repeat(10000))
  for (const name of ['PROFILE.md', 'NOW.md', 'TASKS.md', 'index.md']) writeFileSync(join(cfg.memory.contextRoots[0], name), `# ${name}\n` + 'detail '.repeat(4000))
  const context = await loadModule('src/main/context.ts', { './config': { cfg: () => cfg }, './rsi-metrics': { recordRsiMetric() {} }, './profile-context': { profileId: () => 'owner' }, './paths': { expandHome: x => x }, './db': { getDb() {}, listEvents() {}, kvGet: () => null, kvSet() {}, listRuns: () => [] } })
  const memory = await loadModule('src/main/memory.ts', { './config': { cfg: () => cfg }, './paths': { expandHome: x => x, paths: { home: root } }, './profiles': { getProfile: () => ({ id: 'owner', name: 'Owner', role: 'admin' }) }, './skills': { skillsIndex: () => '' }, './context': context })
  const text = memory.buildContext()
  assert.doesNotMatch(text, /NEVER_AUTO_LOAD_THIS|# index\.md/)
  assert.match(text, /Identity rules must survive unchanged/); assert.match(text, /Explicit user startup rule/)
  assert.ok(memory.startupMemoryFiles().reduce((n, file) => n + file.content.length, 0) <= 3600)
  assert.ok(context.injectedSnapshot().reduce((n, file) => n + file.chars, 0) <= 3600)
  assert.ok(text.length < 11000, `actual startup chars: ${text.length}`)
  assert.ok(memory.searchMemoryFiles('NEVER_AUTO_LOAD_THIS').length)
  assert.equal(memory.readMemoryFile('other.md').content.length, 4000)
  const first = context.contextRead('index')
  assert.equal(first.content.length, 4000); assert.equal(first.nextOffset, 4000)
  assert.ok(first.totalChars > 10000)
  assert.equal(readFileSync(join(cfg.memory.memoriesDir, 'USER.md'), 'utf8').length, 4000, 'source files untouched')
  cfg.memory.durableMaxChars = 0; assert.deepEqual(context.injectedSnapshot(), [])
})

test('recap uses exactly the configured recent turns and bounded characters; zero disables it', async () => {
  const cfg = { memory: { recap: { enabled: true, maxTurns: 4, maxChars: 2400 } } }
  const tasks = Array.from({ length: 8 }, (_, i) => ({ id: `${i}`, prompt: `request-${i} ` + 'x'.repeat(1000), result: `answer-${i} ` + 'y'.repeat(1000), status: 'succeeded', createdAt: Date.now(), finishedAt: Date.now() }))
  const context = await loadModule('src/main/context.ts', { './config': { cfg: () => cfg }, './db': { getDb() {}, listEvents() {}, kvGet: () => null, kvSet() {}, listRuns: ({ limit }) => tasks.slice(0, limit) } })
  const recap = context.compactionRecap('chat')
  assert.doesNotMatch(recap, /request-4|answer-4/)
  assert.ok(recap.length < 2700)
  cfg.memory.recap.maxTurns = 0; assert.equal(context.compactionRecap('chat'), '')
})

test('short skill cores, aliases, local reference search, pagination, pinning and path boundaries', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-skill-reference-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const s = await loadModule('src/main/skills.ts', { './config': { cfg: () => ({ skillsDir: root }) }, './paths': { expandHome: x => x } })
  const body = '---\nname: deployment\ndescription: Release applications\naliases: [ship, publish]\n---\n\n1. Select the target.\n2. Read the matching reference.'
  const skill = s.saveSkill('deployment', body, true, 'operations')
  assert.equal(skill.dir, join(root, 'operations', 'deployment'))
  s.writeSkillReference('deployment', 'references/azure.md', 'Azure Kubernetes rate-limit mitigation.\n' + 'recipe '.repeat(1000), true)
  assert.equal(s.searchSkills('ship')[0].name, 'deployment')
  assert.equal(s.searchSkills('Kubernetes mitigation')[0].matchedFile, 'references/azure.md')
  assert.doesNotMatch(s.skillHints('Kubernetes mitigation').text, /rate-limit mitigation/)
  const page = s.readSkillPage('deployment', 0, 4000, 'references/azure.md')
  assert.equal(page.content.length, 4000); assert.equal(page.nextOffset, 4000)
  assert.equal(s.readSkillPage('deployment', page.nextOffset, 4000, 'references/azure.md').nextOffset, null)
  assert.equal(s.readSkillPage('deployment').references[0].file, 'references/azure.md')
  assert.throws(() => s.writeSkillReference('deployment', 'references/../../outside.md', 'no'), /Markdown path/)
  const outside = join(root, 'outside'); mkdirSync(outside); symlinkSync(outside, join(skill.dir, 'references', 'escape'))
  assert.throws(() => s.writeSkillReference('deployment', 'references/escape/secret.md', 'no'), /escapes/)
  assert.throws(() => s.saveSkill('huge', '---\nname: huge\ndescription: Large\n---\n' + 'x'.repeat(7000), true), /6,000/)
  s.saveSkill('deployment', body.replace('aliases:', 'pinned: true\naliases:'))
  assert.throws(() => s.writeSkillReference('deployment', 'references/azure.md', 'change', true), /Pinned/)
})

test('unchanged skill pages deduplicate within a session but reload, changed content and other sessions work', async () => {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE skill_pages (key TEXT PRIMARY KEY, hash TEXT NOT NULL, ts INTEGER NOT NULL)')
  const s = await loadModule('src/main/skill-usage.ts', { './db': { getDb: () => db } })
  const page = ['session-a', 'deploy', 'SKILL.md', 0, 4000, 'procedure']
  assert.equal(s.skillPageSeen(...page), false); assert.equal(s.skillPageSeen(...page), true)
  assert.equal(s.skillPageSeen(...page, true), false)
  assert.equal(s.skillPageSeen('session-b', ...page.slice(1)), false)
  assert.equal(s.skillPageSeen(...page.slice(0, -1), 'updated'), false)
  assert.equal(s.skillPageSeen('session-a', 'deploy', 'SKILL.md', 4000, 4000, 'second page'), false)
  db.close()
})

test('shipped memory prompts upgrade in place so nightly jobs keep memory-run permissions; edited prompts are left alone', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-schedules-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const paths = Object.fromEntries(['config', 'safeguards', 'schedules', 'mcp', 'soul', 'memories', 'skills'].map(name => [name, join(root, name)])); paths.home = root
  const config = await loadModule('src/main/config.ts', { './paths': { paths, migratedFromLegacy: false }, './profile-context': { isOwner: () => true, bindProfile: fn => fn }, './db': { audit() {} } })
  const retired = JSON.parse(readFileSync('tests/fixtures/retired-memory-prompts.json', 'utf8'))
  const custom = { id: 'memory-review', name: 'Review', cron: '0 1 * * 0', enabled: false, source: 'default', prompt: retired['memory-review'] + ' Also check birthdays.' }
  const old = { id: 'memory-ingest', name: 'Reconcile', cron: '0 2 * * *', enabled: true, source: 'default', prompt: retired['memory-ingest'] }
  const [ingest, review] = config.migrateMemorySchedules([old, custom])
  assert.equal(ingest.prompt, config.MEMORY_INGEST_PROMPT); assert.equal(ingest.cron, '0 2 * * *', 'user timing is kept')
  assert.equal(review, custom, 'an edited prompt is not overwritten')
  const current = config.migrateMemorySchedules([ingest])
  assert.equal(current[0], ingest); assert.equal(current.length, 2, 'the missing review job is added')
})
