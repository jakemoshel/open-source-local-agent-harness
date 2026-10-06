import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadModule } from './load-module.mjs'

async function memory() {
  const home = mkdtempSync(join(tmpdir(), 'jarvis-improve-'))
  let profile = 'owner'
  const bus = new EventEmitter()
  const api = await loadModule('src/main/improvement.ts', {
    './bus': { bus },
    './memory': { writeAtomic: (path, text) => writeFileSync(path, text) },
    './paths': { paths: { get memories() { return join(home, profile, 'memories') } } },
    './profile-context': {
      OWNER_ID: 'owner', isOwner: () => profile === 'owner',
      withProfile: (id, fn) => { const prev = profile; profile = id; try { return fn() } finally { profile = prev } }
    }
  })
  return { api, home, bus, as: (p) => { profile = p }, done: () => rmSync(home, { recursive: true, force: true }) }
}

const fault = (patch = {}) => ({ fingerprint: 'abc123def456', source: 'reflection', cls: 'code', name: 'Defect', message: 'skills_patch drops frontmatter', sample: 'evidence ``` here', count: 1, windowCount: 1, windowStart: 0, firstSeen: 0, lastSeen: 0, status: 'open', attempts: 0, nextAttemptAt: 0, repairRunId: null, commit: null, note: null, ...patch })

test('harness and skill lessons live in separate folders; harness memory is shared and owner-only', async () => {
  const m = await memory()
  try {
    m.api.noteLesson('harness', 'gateways_send retries', 'BlueBubbles needs the chat guid, not the handle.', new Date('2026-10-02T00:00:00Z'))
    m.api.noteLesson('skills', 'deploy skill', 'Added the staging flag after a wrong-target deploy.')
    assert.match(readFileSync(join(m.home, 'owner/memories/self-improvement/harness/LESSONS.md'), 'utf8'), /## 2026-10-02 · gateways_send retries\nBlueBubbles/)
    assert.match(m.api.readImprovement('skills'), /staging flag/)
    assert.doesNotMatch(m.api.readImprovement('skills'), /BlueBubbles/)
    assert.deepEqual(m.api.listImprovement('harness'), ['LESSONS.md'])

    m.as('sam')
    assert.throws(() => m.api.noteLesson('harness', 'x lesson', 'y'), /only available/)
    assert.throws(() => m.api.readImprovement('harness'), /only available/)
    assert.equal(m.api.readImprovement('skills'), '')
    m.api.noteLesson('skills', 'sam skill', 'their own lesson')
    assert.ok(existsSync(join(m.home, 'sam/memories/self-improvement/skills/LESSONS.md')))
  } finally { m.done() }
})

test('file names cannot escape the self-improvement folder', async () => {
  const m = await memory()
  try {
    for (const file of ['../../SOUL.md', 'faults/../../x.md', '/etc/passwd', 'notes.txt', 'a/b/c.md'])
      assert.throws(() => m.api.readImprovement('harness', file), /Invalid/, file)
    assert.equal(m.api.readImprovement('harness', 'faults/abc.md'), '')
  } finally { m.done() }
})

test('lessons stay bounded and keep the newest entries', async () => {
  const m = await memory()
  try {
    for (let i = 0; i < 40; i++) m.api.noteLesson('skills', `lesson ${i}`, 'x'.repeat(400))
    const text = m.api.readImprovement('skills')
    assert.ok(text.length <= m.api.LESSONS_LIMIT)
    assert.match(text, /^# Skill lessons/)
    assert.match(text, /lesson 39/)
    assert.doesNotMatch(text, /lesson 0\n/)
  } finally { m.done() }
})

test('fault pages are written for reported defects and on every status change', async () => {
  const m = await memory()
  try {
    m.api.startImprovementMemory()
    m.bus.emit('fault:recorded', fault({ source: 'crash', fingerprint: 'machine00001' }))
    assert.deepEqual(m.api.listImprovement('harness'), [])
    m.bus.emit('fault:recorded', fault())
    m.bus.emit('fault:updated', fault({ fingerprint: 'machine00001', source: 'crash', status: 'ignored', note: 'accepted' }))
    assert.deepEqual(m.api.listImprovement('harness'), ['faults/abc123def456.md', 'faults/machine00001.md'])
    const page = m.api.readImprovement('harness', 'faults/machine00001.md')
    assert.match(page, /status: ignored/)
    assert.match(page, /## Latest note\naccepted/)
    // Evidence cannot close the code fence it is quoted in.
    assert.equal(m.api.readImprovement('harness', 'faults/abc123def456.md').match(/```/g).length, 2)
  } finally { m.done() }
})
