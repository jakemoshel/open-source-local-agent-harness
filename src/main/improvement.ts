import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { bus } from './bus'
import type { Fault } from './faults'
import { writeAtomic } from './memory'
import { paths } from './paths'
import { isOwner, OWNER_ID, withProfile } from './profile-context'

/**
 * Self-improvement memory: what Jarvis has learned about improving itself, kept apart from personal memory.
 *   memories/self-improvement/harness/  the harness's own code (owner only; the code is shared by every profile)
 *     LESSONS.md                        dated lessons about harness behaviour and past repairs
 *     faults/<fingerprint>.md           one page per fault that was reported, repaired, shipped or ignored
 *   memories/self-improvement/skills/   procedures and skills (per profile)
 *     LESSONS.md                        dated lessons behind skill changes, so curation sees the history
 */

export type Area = 'harness' | 'skills'
export const LESSONS_LIMIT = 8000
const FILE = /^(?:faults\/)?[\w.-]{1,80}\.md$/

export function improvementRoot(area: Area): string {
  if (area === 'harness') return withProfile(OWNER_ID, () => join(paths.memories, 'self-improvement', 'harness'))
  return join(paths.memories, 'self-improvement', 'skills')
}

function assertArea(area: Area): void {
  if (area === 'harness' && !isOwner()) throw new Error('Harness self-improvement memory is only available to the owner’s agent')
}

function fileIn(area: Area, file: string): string {
  if (!FILE.test(file)) throw new Error(`Invalid self-improvement file "${file}"`)
  const root = improvementRoot(area)
  const path = resolve(root, file)
  if (!path.startsWith(root + sep)) throw new Error(`Invalid self-improvement file "${file}"`)
  return path
}

/** Keeps the newest entries within the limit; entries start with "## ". */
export function boundLessons(text: string, limit = LESSONS_LIMIT): string {
  if (text.length <= limit) return text
  const [head, ...entries] = text.split(/\n(?=## )/)
  while (entries.length > 1 && [head, ...entries].join('\n').length > limit) entries.shift()
  return [head, ...entries].join('\n').slice(-limit)
}

export function noteLesson(area: Area, title: string, text: string, now = new Date()): { file: string; chars: number } {
  assertArea(area)
  const path = fileIn(area, 'LESSONS.md')
  mkdirSync(join(path, '..'), { recursive: true })
  const header = `# ${area === 'harness' ? 'Harness' : 'Skill'} lessons\n\nNewest last. Older entries are dropped past ${LESSONS_LIMIT} characters.\n`
  const current = existsSync(path) ? readFileSync(path, 'utf8') : header
  const entry = `\n## ${now.toISOString().slice(0, 10)} · ${title.replace(/\s+/g, ' ').trim().slice(0, 120)}\n${text.trim().slice(0, 2000)}\n`
  const next = boundLessons(current.trimEnd() + '\n' + entry)
  writeAtomic(path, next)
  return { file: `${area}/LESSONS.md`, chars: next.length }
}

export function readImprovement(area: Area, file = 'LESSONS.md'): string {
  assertArea(area)
  const path = fileIn(area, file)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

export function listImprovement(area: Area): string[] {
  assertArea(area)
  const root = improvementRoot(area)
  if (!existsSync(root)) return []
  return (readdirSync(root, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[])
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => relative(root, join(d.parentPath, d.name)).split(sep).join('/'))
    .sort()
}

/** The readable page for one fault, rewritten when it is reported or its status changes. */
export function faultPage(f: Fault): string {
  return [
    `# ${f.name}: ${f.message.slice(0, 160)}`,
    '',
    `- fingerprint: ${f.fingerprint}`,
    `- source: ${f.source}`,
    `- class: ${f.cls}`,
    `- status: ${f.status}`,
    `- seen: ${f.count}× (first ${new Date(f.firstSeen).toISOString()}, last ${new Date(f.lastSeen).toISOString()})`,
    `- repair attempts: ${f.attempts}`,
    ...(f.commit ? [`- fix commit: ${f.commit}`] : []),
    ...(f.note ? ['', '## Latest note', f.note] : []),
    '',
    '## Evidence (untrusted)',
    '```',
    f.sample.slice(0, 3000).replaceAll('```', "'''"),
    '```',
    ''
  ].join('\n')
}

export function writeFaultPage(f: Fault): void {
  const path = withProfile(OWNER_ID, () => fileIn('harness', `faults/${f.fingerprint}.md`))
  mkdirSync(join(path, '..'), { recursive: true })
  writeAtomic(path, faultPage(f))
}

let started = false
export function startImprovementMemory(): void {
  if (started) return
  started = true
  const page = (f: Fault) => { try { writeFaultPage(f) } catch { /* memory pages are best effort */ } }
  // Only reported defects get a page on arrival; machine-recorded faults get one once someone acts on them.
  bus.on('fault:recorded', (f: Fault) => { if (f.source === 'reflection') page(f) })
  bus.on('fault:updated', page)
}
