import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { z } from 'zod'
import { loadModule } from './load-module.mjs'

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'jarvis-tool-rag-')); t.after(() => rmSync(home, { recursive: true, force: true }))
  let owner = true, kind = 'task', calls = 0
  const bus = new EventEmitter()
  const operation = (description, input = z.object({})) => ({ description, input, agent: true })
  const catalog = await loadModule('src/main/harness-tools.ts', {
    './profile-context': { isOwner: () => owner, profileId: () => owner ? 'owner' : 'member' },
    './profile-policy': { memberCanInvoke: name => !name.startsWith('terminal_') }, './paths': { paths: { home } },
    './runs': { runKind: () => kind }, './bus': { bus },
    './memory': { writeAtomic: writeFileSync },
    './ops': { invoke: async () => { calls++; return { text: 'large result '.repeat(4000) } }, ops: {
      schedules_upsert: operation('Create or update scheduled jobs', z.object({ runAt: z.string(), prompt: z.string() })),
      meetings_search: operation('Search meeting notes and transcripts', z.object({ query: z.string() })),
      terminal_open: operation('Open an interactive terminal shell', z.object({ command: z.string() })),
      context_read: operation('Read linked memory records', z.object({ ref: z.string() })),
      hidden: { ...operation('Internal'), agent: false }
    } }
  })
  return { home, catalog, bus, calls: () => calls, owner: v => owner = v, kind: v => kind = v }
}

test('local numeric tool retrieval returns directly usable schemas and ranks natural-language aliases', async t => {
  const f = await fixture(t)
  const search = query => JSON.parse(f.catalog.describeOps(undefined, undefined, query)).matches
  assert.equal(search('remind me tomorrow')[0].op, 'schedules_upsert')
  assert.equal(search('meeting notes')[0].op, 'meetings_search')
  assert.equal(search('terminal_open')[0].op, 'terminal_open')
  const hit = search('remind me tomorrow')[0]
  assert.ok(hit.similarity > 0 && hit.similarity <= 1)
  assert.equal(hit.args.properties.runAt.type, 'string')
  assert.match(hit.path, /schedules\/schedules_upsert.md$/)
  assert.deepEqual(search('zzzz_nonexistent'), [])
  f.owner(false); assert.ok(!search('shell').some(r => r.op === 'terminal_open'))
  f.owner(true); f.kind('repair'); assert.equal(search('shell')[0].op, 'terminal_open', 'RSI can discover all normal agent operations')
  f.kind('memory'); assert.ok(search('memory').every(r => r.op === 'context_read'))
})

test('generated tool files match the searchable registry and hide inaccessible operations', async t => {
  const f = await fixture(t)
  f.owner(false); f.catalog.initializeToolLibrary()
  const index = readFileSync(join(f.home, 'tools/index.md'), 'utf8')
  assert.match(index, /schedules\/schedules_upsert.md/)
  assert.doesNotMatch(index, /terminal_open|hidden/)
  const doc = readFileSync(join(f.home, 'tools/schedules/schedules_upsert.md'), 'utf8')
  assert.match(doc, /remind|reminder/); assert.match(doc, /"runAt"/)
})

test('large tool results remain pageable without repeating side effects and cannot cross runs or profiles', async t => {
  const f = await fixture(t)
  let page = JSON.parse(await f.catalog.runHarnessTool('harness_call', { op: 'meetings_search' }, 'run-a'))
  const id = page.resultId; let text = page.content
  while (page.nextOffset !== null) { page = JSON.parse(await f.catalog.runHarnessTool('harness_call', { op: 'meetings_search', resultId: id, offset: page.nextOffset }, 'run-a')); text += page.content }
  assert.equal(JSON.parse(text).text.length, 'large result '.repeat(4000).length); assert.equal(f.calls(), 1)
  await assert.rejects(f.catalog.runHarnessTool('harness_call', { op: 'meetings_search', resultId: id }, 'run-b'), /unavailable/)
  f.owner(false); await assert.rejects(f.catalog.runHarnessTool('harness_call', { op: 'meetings_search', resultId: id }, 'run-a'), /unavailable/)
  f.owner(true); f.bus.emit('run:finished', { id: 'run-a' })
  await assert.rejects(f.catalog.runHarnessTool('harness_call', { op: 'meetings_search', resultId: id }, 'run-a'), /unavailable/)
})
