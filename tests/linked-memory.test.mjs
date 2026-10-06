import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { loadModule } from './load-module.mjs'

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'jarvis-linked-memory-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const memories = join(home, 'memories'); mkdirSync(memories)
  writeFileSync(join(memories, 'USER.md'), 'Prefers concise replies; stated 2026-09-20.')
  const config = { memory: { memoriesDir: memories, contextRoots: [], soulFile: join(home, 'SOUL.md'), limits: {}, inject: [{ file: 'PROFILE.md', maxChars: 1200 }, { file: 'NOW.md', maxChars: 1600 }, { file: 'TASKS.md', maxChars: 800 }], durableMaxChars: 3600 } }
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, conversation_key TEXT, trigger TEXT, created_at INTEGER); CREATE TABLE events (id INTEGER PRIMARY KEY, run_id TEXT, ts INTEGER, type TEXT, data TEXT)')
  const kv = new Map()
  const mocks = { './rsi-metrics': { recordRsiMetric() {} }, './config': { cfg: () => config }, './paths': { paths: { home }, expandHome: x => x }, './profile-context': { profileId: () => 'owner' }, './profiles': { getProfile() {} }, './skills': { skillsIndex() {} }, './db': { getDb: () => db, kvGet: key => kv.get(key), kvSet: (key, value) => kv.set(key, value), listRuns: () => [] } }
  const store = await loadModule('src/main/context-store.ts', mocks)
  const context = await loadModule('src/main/context.ts', mocks)
  const root = join(memories, 'Context')
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  return { home, root, memories, config, db, store, context, git, kv, mocks }
}

test('private memory initializes linked folders, compact one-pagers, imported user source and local Git without overwriting notes', async t => {
  const f = await fixture(t)
  f.store.initializeContextStore()
  for (const path of ['SCHEMA.md', 'PROFILE.md', 'NOW.md', 'TASKS.md', 'index.md', 'knowledge/facts/user-profile.md']) assert.ok(readFileSync(join(f.root, path), 'utf8'))
  assert.match(readFileSync(join(f.root, 'knowledge/facts/user-profile.md'), 'utf8'), /native:USER.md|concise replies/)
  const before = f.git('rev-parse', 'HEAD')
  f.store.initializeContextStore()
  assert.equal(f.git('rev-parse', 'HEAD'), before, 'initialization is idempotent')
  assert.equal(readFileSync(join(f.memories, 'USER.md'), 'utf8'), 'Prefers concise replies; stated 2026-09-20.')
})

test('record corrections preserve Git history; alias search, link hops, dates and paged reads stay available', async t => {
  const f = await fixture(t); f.store.initializeContextStore()
  const input = { id: 'dining', type: 'preference', aliases: ['food', 'lunch'], body: '2026-09-20 | Likes pasta | source: event:1 | confidence: high\nRelated: [[user-profile]]\n' + 'details '.repeat(150), sources: ['event:1'] }
  f.store.writeContextRecord(input); f.store.commitContext('Save dining preference')
  f.context.invalidateContext()
  const hit = f.context.contextSearch('lunch')[0]
  assert.equal(hit.id, 'dining'); assert.deepEqual(hit.sources, ['event:1']); assert.equal(hit.status, 'current')
  const first = f.context.contextRead('dining', 0, 500)
  assert.equal(first.content.length, 500); assert.equal(first.nextOffset, 500)
  assert.match(first.content, /^2026-09-20 \| Likes pasta/, 'content is the body; frontmatter comes back as fields')
  assert.equal(first.type, 'preference')
  assert.equal(first.links[0].id, 'user-profile'); assert.ok(first.links[0].path); assert.equal(first.links[0].type, 'profile')
  assert.ok(f.context.contextRead('user-profile').backlinks.some(r => r.id === 'dining'))
  f.store.writeContextRecord({ ...input, body: '2026-10-02 | No longer likes pasta; previous statement historical | source: event:2 | confidence: high', sources: ['event:2'] })
  f.store.commitContext('Correct dining preference')
  const history = f.store.contextHistory('dining')
  assert.match(history.history, /Correct dining preference/); assert.match(history.history, /Save dining preference/)
  assert.match(f.store.contextHistory('dining', 5, f.git('rev-parse', 'HEAD~1')).content, /Likes pasta/)
})

test('completed workstreams move to the historical folder and commits leave unrelated staged files alone', async t => {
  const f = await fixture(t); f.store.initializeContextStore()
  const input = { id: 'launch', type: 'workstream', aliases: ['project'], body: 'Launch the site.', sources: ['event:1'] }
  f.store.writeContextRecord(input); f.store.commitContext('Start launch')
  writeFileSync(join(f.root, 'unrelated.txt'), 'user work'); f.git('add', 'unrelated.txt')
  const result = f.store.writeContextRecord({ ...input, status: 'historical', body: 'Launch completed on 2026-10-02.' })
  assert.match(result.path, /workstreams\/completed\/launch.md$/)
  f.store.commitContext('Complete launch')
  assert.equal(f.git('diff', '--cached', '--name-only'), 'unrelated.txt')
  assert.equal(f.git('ls-files', 'workstreams/active/launch.md'), '')
  assert.equal(f.git('ls-files', 'workstreams/completed/launch.md'), 'workstreams/completed/launch.md')
})

test('expired/historical facts require explicit history search; forgetting clears retrieval and derived snapshots', async t => {
  const f = await fixture(t); f.store.initializeContextStore()
  f.store.writeContextRecord({ id: 'exams', type: 'workstream', aliases: ['school'], body: 'Exams this weekend.', sources: ['event:1'], expires: '2020-01-01' })
  f.store.commitContext('Exams'); f.context.invalidateContext()
  assert.deepEqual(f.context.contextSearch('school'), [])
  assert.equal(f.context.contextSearch('school', 5, true)[0].status, 'historical')
  f.store.writeContextSnapshot('NOW.md', 'Exams this weekend [[exams]].', ['exams'])
  const result = f.store.forgetContextRecord('exams')
  assert.match(result.note, /Git history/)
  f.context.invalidateContext()
  assert.deepEqual(f.context.contextSearch('school', 5, true), [])
  assert.throws(() => f.context.contextRead('exams'), /forgotten/)
  assert.throws(() => f.store.contextHistory('exams'), /forgotten/)
  assert.doesNotMatch(readFileSync(join(f.root, 'NOW.md'), 'utf8'), /Exams this weekend/)
  assert.throws(() => f.store.writeContextRecord({ id: 'exams', type: 'workstream', aliases: [], body: 'old memory', sources: ['event:1'] }), /forgotten/)
})

test('memory updates reject traversal, reserved snapshots and symlink escapes', async t => {
  const f = await fixture(t); f.store.initializeContextStore()
  const input = { id: '../escape', type: 'preference', aliases: [], body: 'no', sources: ['event:1'] }
  assert.throws(() => f.store.writeContextRecord(input), /Invalid/)
  assert.throws(() => f.store.writeContextRecord({ ...input, id: 'profile', type: 'profile' }), /snapshot|reserved/i)
  rmSync(join(f.root, 'knowledge/preferences'), { recursive: true }); symlinkSync(f.home, join(f.root, 'knowledge/preferences'))
  assert.throws(() => f.store.writeContextRecord({ ...input, id: 'escape' }), /symlink escapes/)
})

test('transcript paging includes late follow-ups, splits large messages losslessly, and freezes out new events', async t => {
  const f = await fixture(t)
  const now = Date.now()
  f.db.prepare('INSERT INTO runs VALUES (?,?,?,?)').run('old-run', 'chat', 'imessage', now - 10 * 86400000)
  f.db.prepare('INSERT INTO runs VALUES (?,?,?,?)').run('maintenance', null, 'schedule', now)
  const insert = (id, run, text, type = 'user') => f.db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(id, run, now, type, JSON.stringify({ text }))
  insert(1, 'old-run', 'A'.repeat(15000)); insert(2, 'maintenance', 'DO_NOT_INGEST_SELF'); insert(3, 'old-run', 'Late follow-up')
  let page = f.context.transcriptPage(26, 1000), all = page.content, pages = 1
  assert.ok(page.nextCursor); insert(4, 'old-run', 'NEW_AFTER_WINDOW')
  while (page.nextCursor) { page = f.context.transcriptPage(26, 1000, page.nextCursor); all += page.content; pages++; assert.ok(pages < 30) }
  assert.equal((all.match(/A/g) || []).length, 15000)
  assert.match(all, /Late follow-up/); assert.doesNotMatch(all, /DO_NOT_INGEST_SELF|NEW_AFTER_WINDOW/)
  assert.equal(page.throughEventId, 3)
  const fresh = f.context.transcriptPage(26, 1000, undefined, page.throughEventId)
  assert.match(fresh.content, /NEW_AFTER_WINDOW/)
})

test('ingestion rejects skipped pages and checkpoints complete event boundaries across a restart', async t => {
  const f = await fixture(t); f.store.initializeContextStore()
  f.db.prepare('INSERT INTO runs VALUES (?,?,?,?)').run('run', 'chat', 'ui', Date.now())
  const insert = (id, text) => f.db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(id, 'run', Date.now(), 'user', JSON.stringify({ text }))
  insert(1, 'first fact '.repeat(20)); insert(2, 'second fact '.repeat(20)); insert(3, 'third fact')
  const first = f.store.readIngestionPage('ingest-a', 500)
  assert.ok(first.nextCursor); assert.equal(first.nextCursor.offset, 0)
  assert.throws(() => f.store.readIngestionPage('ingest-a', 500, { ...first.nextCursor, eventId: 3 }), /exact nextCursor/)
  assert.throws(() => f.store.commitIngestion('ingest-a', { message: 'skip', throughEventId: 3 }), /every transcript page/)
  assert.throws(() => f.store.commitIngestion('ingest-a', { message: 'skip', resumeCursor: { ...first.nextCursor, offset: 1 } }), /complete event boundary/)
  f.store.commitIngestion('ingest-a', { message: 'verified first event', resumeCursor: first.nextCursor })
  assert.deepEqual(f.kv.get('context:cursor'), first.nextCursor)
  const restarted = await loadModule('src/main/context-store.ts', f.mocks)
  let next = restarted.readIngestionPage('ingest-b', 500)
  assert.doesNotMatch(next.content, /first fact/); assert.match(next.content, /second fact/)
  while (next.nextCursor) next = restarted.readIngestionPage('ingest-b', 500, next.nextCursor)
  restarted.commitIngestion('ingest-b', { message: 'complete window', throughEventId: next.throughEventId })
  assert.equal(f.kv.get('context:throughEventId'), 3); assert.equal(f.kv.get('context:cursor'), null)
  insert(4, 'new fact after checkpoint')
  assert.match(restarted.readIngestionPage('ingest-c').content, /new fact after checkpoint/)
})

test('a record created and moved before its first commit does not wedge later commits', async t => {
  const f = await fixture(t); f.store.initializeContextStore()
  const input = { id: 'sprint', type: 'workstream', aliases: [], body: 'Ship it.', sources: ['event:1'] }
  f.store.writeContextRecord(input)
  f.store.writeContextRecord({ ...input, status: 'historical', body: 'Shipped.' })
  assert.equal(f.store.commitContext('Sprint done').committed, true)
  assert.equal(f.git('ls-files', 'workstreams/completed/sprint.md'), 'workstreams/completed/sprint.md')
  f.store.writeContextRecord({ id: 'next', type: 'fact', aliases: [], body: 'Later fact.', sources: ['event:2'] })
  assert.equal(f.store.commitContext('Later').committed, true)
  assert.equal(f.store.commitContext('Nothing left').committed, false)
})

test('search snippets centre on a matched term and backlinks follow alias and filename links', async t => {
  const f = await fixture(t); f.store.initializeContextStore()
  f.store.writeContextRecord({ id: 'acme', type: 'organization', aliases: ['acme corp'], body: 'Customer.', sources: ['event:1'] })
  f.store.writeContextRecord({ id: 'deal', type: 'fact', aliases: [], body: 'filler '.repeat(200) + 'Signed with Acme on Friday. See [[acme corp]].', sources: ['event:2'] })
  f.context.invalidateContext()
  const hit = f.context.contextSearch('zebra signed').find(h => h.id === 'deal')
  assert.match(hit.snippet, /Signed with Acme/)
  assert.deepEqual(f.context.contextRead('acme').backlinks.map(b => b.id), ['deal'])
})

test('a malformed transcript event does not break the page', async t => {
  const f = await fixture(t)
  f.db.prepare('INSERT INTO runs VALUES (?,?,?,?)').run('run', 'chat', 'ui', Date.now())
  f.db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(1, 'run', Date.now(), 'user', '{broken')
  f.db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(2, 'run', Date.now(), 'user', JSON.stringify({ text: 'still readable' }))
  const page = f.context.transcriptPage(26, 1000)
  assert.match(page.content, /unreadable event/); assert.match(page.content, /still readable/)
})

test('memory_edit add is idempotent and remove/replace leave no empty entries', async t => {
  const f = await fixture(t)
  const memory = await loadModule('src/main/memory.ts', { ...f.mocks, './context': { compactionRecap: () => '', injectedSnapshot: () => [], memoryMap: () => '' } })
  memory.editMemory('MEMORY.md', 'add', 'one'); memory.editMemory('MEMORY.md', 'add', 'two'); memory.editMemory('MEMORY.md', 'add', 'three')
  assert.equal(memory.editMemory('MEMORY.md', 'add', ' two '), 'one\n§\ntwo\n§\nthree')
  assert.equal(memory.editMemory('MEMORY.md', 'remove', '', 'two'), 'one\n§\nthree')
  assert.equal(memory.editMemory('MEMORY.md', 'replace', '', 'one'), 'three')
  assert.equal(readFileSync(join(f.memories, 'MEMORY.md'), 'utf8'), 'three')
  assert.equal(memory.searchMemoryFiles('thrée three')[0].file, 'MEMORY.md')
})

test('records stay one subject: oversized bodies are rejected with a split instruction; recaps get more room', async t => {
  const f = await fixture(t); f.store.initializeContextStore()
  assert.throws(() => f.store.writeContextRecord({ id: 'everything', type: 'person', aliases: [], body: 'x'.repeat(1501), sources: ['event:1'] }), /holds at most 1500.*Split it into narrower records/)
  assert.ok(f.store.writeContextRecord({ id: 'week', type: 'recap', aliases: [], body: 'x'.repeat(3900), sources: ['event:1'] }))
  assert.ok(f.store.writeContextRecord({ id: 'travel', type: 'topic', aliases: [], body: '- [[flights]]: airline preferences', sources: ['event:1'] }).path.endsWith('knowledge/topics/travel.md'))
})

test('a retyped record moves to its new folder in the managed tree', async t => {
  const f = await fixture(t); f.store.initializeContextStore()
  f.store.writeContextRecord({ id: 'sam', type: 'fact', aliases: [], body: 'Sam is a friend.', sources: ['event:1'] })
  const moved = f.store.writeContextRecord({ id: 'sam', type: 'person', aliases: [], body: 'Friend.', sources: ['event:1'] })
  assert.match(moved.path, /entities\/people\/sam\.md$/)
  assert.equal(f.context.records().filter(r => r.id === 'sam').length, 1)
  assert.equal(f.store.commitContext('Retype').committed, true)
})

test('the index is rebuilt once at commit, not on every write', async t => {
  const f = await fixture(t); f.store.initializeContextStore()
  f.store.writeContextRecord({ id: 'acme', type: 'organization', aliases: [], body: 'Customer.', sources: ['event:1'] })
  assert.doesNotMatch(readFileSync(join(f.root, 'index.md'), 'utf8'), /\[\[acme\]\]/)
  f.store.commitContext('Add acme')
  assert.match(readFileSync(join(f.root, 'index.md'), 'utf8'), /\[\[acme\]\]/)
  assert.equal(f.git('status', '--porcelain'), '')
})

test('a large USER.md imports as small linked records under a user-profile hub', async t => {
  const f = await fixture(t)
  const sections = Array.from({ length: 6 }, (_, i) => `## Topic ${i}\n` + `Line about topic ${i}. `.repeat(30))
  writeFileSync(join(f.memories, 'USER.md'), sections.join('\n\n') + '\n§\nPrefers concise replies.')
  f.store.initializeContextStore()
  const hub = f.context.contextRead('user-profile')
  assert.ok(hub.links.length >= 7, `hub links: ${hub.links.length}`)
  for (const link of hub.links) {
    const r = f.context.contextRead(link.id)
    assert.ok(r.totalChars <= 1500, `${link.id} is ${r.totalChars} chars`)
    assert.ok(r.links.some(l => l.id === 'user-profile'), 'entries link back to the hub')
  }
  assert.ok(f.context.contextSearch('topic 3').some(h => h.id.startsWith('user-topic-3')))
  assert.equal(f.git('status', '--porcelain'), '')
})

test('an earlier monolithic profile import is split once on startup', async t => {
  const f = await fixture(t)
  mkdirSync(join(f.root, 'knowledge/facts'), { recursive: true })
  execFileSync('git', ['init', '--quiet'], { cwd: f.root })
  const body = Array.from({ length: 5 }, (_, i) => `Entry ${i}: ` + 'detail '.repeat(60)).join('\n§\n')
  writeFileSync(join(f.root, 'knowledge/facts/user-profile.md'), `---\nid: user-profile\ntype: profile\nsources: ['native:USER.md']\n---\n\n${body}\n`)
  f.store.initializeContextStore()
  const hub = f.context.contextRead('user-profile')
  assert.ok(hub.totalChars <= 1500); assert.equal(hub.links.length, 5)
  const head = f.git('rev-parse', 'HEAD')
  f.context.invalidateContext(); f.store.initializeContextStore()
  assert.equal(f.git('rev-parse', 'HEAD'), head, 'the split runs once')
})

test('context_list pages, filters by type and folder, and flags oversized records', async t => {
  const f = await fixture(t); f.store.initializeContextStore()
  for (let i = 0; i < 5; i++) f.store.writeContextRecord({ id: `p${i}`, type: 'person', aliases: [], body: `Person ${i}.`, sources: ['event:1'] })
  writeFileSync(join(f.root, 'knowledge/facts/legacy.md'), '---\nid: legacy\ntype: fact\n---\n' + 'y'.repeat(2000))
  f.context.invalidateContext()
  const page = f.context.contextList({ type: 'person', limit: 2 })
  assert.equal(page.total, 5); assert.equal(page.records.length, 2); assert.equal(page.nextOffset, 2)
  assert.equal(page.records[0].path, 'entities/people/p0.md')
  assert.equal(f.context.contextList({ folder: 'entities/people/' }).total, 5)
  assert.deepEqual(f.context.contextList({ oversized: true }).records.map(r => r.id), ['legacy'])
  assert.ok(!f.context.contextList({ limit: 200 }).records.some(r => ['index', 'SCHEMA'].includes(r.id)))
})

test('splitEntries keeps headings with their text and packs short lines', async t => {
  const f = await fixture(t)
  const parts = f.store.splitEntries('## Work\n\n' + 'Builds agents. '.repeat(20) + '\n\n' + Array.from({ length: 80 }, (_, i) => `- item ${i}`).join('\n'), 300)
  assert.ok(parts.every(p => p.length <= 300))
  assert.ok(parts[0].startsWith('## Work\n\nBuilds'), 'a heading is never its own record')
  assert.ok(parts.length < 20, `bullets are packed, got ${parts.length} parts`)
})

test('a misspelt name still finds its record; an unknown body word does not invent matches', async t => {
  const f = await fixture(t); f.store.initializeContextStore()
  f.store.writeContextRecord({ id: 'samantha-lee', type: 'person', aliases: ['Sam', 'my gf'], body: 'Partner.', sources: ['event:1'] })
  f.store.writeContextRecord({ id: 'dining', type: 'preference', aliases: ['food', 'restaurants'], body: 'Loves pasta.', sources: ['event:1'] })
  f.context.invalidateContext()
  assert.equal(f.context.contextSearch('samanthaa')[0]?.id, 'samantha-lee', 'one extra character')
  assert.equal(f.context.contextSearch('restuarants')[0]?.id, 'dining', 'a transposition in a long word')
  assert.equal(f.context.contextSearch('my gf')[0].id, 'samantha-lee')
  assert.equal(f.context.contextSearch('my gf')[0].named, true)
  assert.deepEqual(f.context.contextSearch('pazta'), [], 'body words are not fuzzed')
})

test('memory hints name records a message mentions by id or alias, folding plurals', async t => {
  const f = await fixture(t); f.store.initializeContextStore()
  f.store.writeContextRecord({ id: 'samantha-lee', type: 'person', aliases: ['Sam', 'my gf'], body: 'Partner.', sources: ['event:1'] })
  f.store.writeContextRecord({ id: 'dining', type: 'preference', aliases: ['restaurant', 'takeout'], body: 'Loves pasta.', sources: ['event:1'] })
  f.store.writeContextRecord({ id: 'week-1', type: 'recap', aliases: ['sam'], body: 'Recap.', sources: ['event:1'] })
  f.context.invalidateContext()
  assert.deepEqual(new Set(f.context.memoryHints('book restaurants for me and my gf').map(h => h.id)), new Set(['dining', 'samantha-lee']))
  assert.deepEqual(f.context.memoryHints('samsung phone'), [], 'whole words only')
  assert.ok(!f.context.memoryHints('ask sam').some(h => h.id === 'week-1'), 'recaps are not pointed at')
})

test('the memory map lists current ids by kind within its budget and skips snapshots and history', async t => {
  const f = await fixture(t); f.store.initializeContextStore()
  for (let i = 0; i < 40; i++) f.store.writeContextRecord({ id: `fact-${String(i).padStart(2, '0')}`, type: 'fact', aliases: [], body: 'x', sources: ['event:1'] })
  f.store.writeContextRecord({ id: 'sam-lee', type: 'person', aliases: [], body: 'x', sources: ['event:1'] })
  f.store.writeContextRecord({ id: 'old-job', type: 'workstream', aliases: [], body: 'x', sources: ['event:1'], status: 'historical' })
  f.context.invalidateContext()
  const map = f.context.memoryMap(300)
  assert.ok(map.length <= 300, map)
  assert.match(map, /^people \(1\): sam-lee$/m)
  assert.match(map, /^facts \(4\d\): .*…$/m, 'a long kind is cut with an ellipsis')
  assert.doesNotMatch(map, /old-job|profile|tasks/)
  assert.equal(f.context.memoryMap(0), '')
})

test('credentials are refused; monthly recaps get their own tier', async t => {
  const f = await fixture(t); f.store.initializeContextStore()
  assert.throws(() => f.store.writeContextRecord({ id: 'slack', type: 'fact', aliases: [], body: 'Bot token xoxb-12345678901-abcdefghij', sources: ['event:1'] }), { name: 'UsageError', message: /credential/ })
  assert.throws(() => f.store.writeContextSnapshot('NOW.md', 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz', []), /credential/)
  assert.match(f.store.writeContextRecord({ id: '2026-09', type: 'recap', aliases: [], body: 'September.', sources: ['event:1'], period: 'monthly' }).path, /timeline\/monthly\/2026-09\.md$/)
})

test('a rotated session leads its recap with the old session\'s own handover', async t => {
  const f = await fixture(t)
  f.mocks['./db'].listRuns = () => [{ id: 'r1', prompt: 'plan the launch', result: 'drafted', status: 'succeeded', createdAt: 1, finishedAt: Date.now() }]
  const context = await loadModule('src/main/context.ts', f.mocks)
  f.config.memory.recap = { enabled: true, maxTurns: 4, maxChars: 2400 }
  const recap = context.compactionRecap('chat', undefined, 1, 'Open loops: confirm venue.')
  assert.match(recap, /Its own handover[\s\S]*Open loops: confirm venue\.[\s\S]*Its last turns:\nUser: plan the launch/)
  assert.match(context.compactionRecap('chat'), /Its last turns, for continuity/)
})

test('the credential guard covers every stored field and glued keys, without flagging ordinary hyphenated words', async t => {
  const f = await fixture(t); f.store.initializeContextStore()
  const base = { id: 'ok', type: 'fact', aliases: [], body: 'Plain.', sources: ['event:1'] }
  for (const bad of [{ body: 'token_sk-ant-api03abcdefghijklmnop1234' }, { aliases: ['xoxb-1234567890-abcdef'] }, { sources: ['ghp_abcdefghijklmnopqrstuvwxyz0123456789'] }, { body: 'keyAKIAABCDEFGHIJKLMNOP' }, { body: '-----BEGIN RSA PRIVATE KEY-----\nMIIE' }])
    assert.throws(() => f.store.writeContextRecord({ ...base, ...bad }), /credential/, JSON.stringify(bad))
  assert.ok(f.store.writeContextRecord({ ...base, body: 'Owns the risk-management-framework-review and the desk-organization-project-plan.' }))
  assert.throws(() => f.store.writeContextSnapshot('NOW.md', 'ok', ['sk-proj-abcdefghij0123456789abcd']), /credential/)
})

test('a credential in USER.md is redacted on import and never blocks memory startup', async t => {
  const f = await fixture(t)
  writeFileSync(join(f.memories, 'USER.md'), 'Prefers short replies.\n§\nSlack bot token xoxb-1234567890-abcdefghij for the workspace.')
  f.store.initializeContextStore()
  // git grep exits 1 when nothing matches.
  assert.throws(() => f.git('grep', '-l', 'xoxb-', 'HEAD'), 'no committed file holds the token')
  assert.match(f.context.contextRead('user-profile').content, /\[\[user-/, 'the rest of the profile was imported')
  assert.ok(f.context.contextSearch('slack bot token').some(h => /credential removed/.test(h.snippet)))
})
