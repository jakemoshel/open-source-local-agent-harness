import { words, rankDocuments } from './retrieval'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs'
import { join, relative, dirname, resolve, isAbsolute } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Skill } from '@shared/types'
import { cfg } from './config'
import { expandHome } from './paths'

export function skillsDir(): string {
  return expandHome(cfg().skillsDir)
}

function frontmatter(text: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return {}
  try {
    return (parseYaml(m[1]) as Record<string, unknown>) ?? {}
  } catch {
    return {}
  }
}

/** Skills are re-ranked on every task message: reread, reparse and retokenize only files that changed. */
const fileCache = new Map<string, { mtimeMs: number; size: number; text: string; fm?: Record<string, unknown>; words?: Set<string>; wordsLimit?: number }>()
function cachedFile(path: string) {
  const st = statSync(path)
  let entry = fileCache.get(path)
  if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
    if (fileCache.size > 2000) fileCache.clear()
    entry = { mtimeMs: st.mtimeMs, size: st.size, text: readFileSync(path, 'utf8') }
    fileCache.set(path, entry)
  }
  return entry
}
const cachedText = (path: string) => cachedFile(path).text
function cachedFrontmatter(path: string): Record<string, unknown> {
  const entry = cachedFile(path)
  return (entry.fm ??= frontmatter(entry.text))
}
function cachedWords(path: string, maxChars = Infinity): Set<string> {
  const entry = cachedFile(path)
  // Oversized files are tokenized once per limit too, not on every task message.
  if (!entry.words || entry.wordsLimit !== maxChars) { entry.words = new Set(words(entry.text.slice(0, maxChars))); entry.wordsLimit = maxChars }
  return entry.words
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > 3 || !existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const p = join(dir, name)
    // A dangling symlink must not hide every other skill.
    try { if (!statSync(p).isDirectory()) continue } catch { continue }
    if (existsSync(join(p, 'SKILL.md'))) out.push(p)
    else walk(p, depth + 1, out)
  }
}

export function listSkills(): Skill[] {
  const dirs: string[] = []
  walk(skillsDir(), 0, dirs)
  return dirs
    .map((dir) => {
      const path = join(dir, 'SKILL.md')
      const fm = cachedFrontmatter(path)
      return {
        name: String(fm.name ?? dir.split('/').pop()),
        description: String(fm.description ?? '').replace(/\s+/g, ' ').trim(),
        dir,
        path,
        pinned: fm.pinned === true
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function readSkill(name: string): { skill: Skill; content: string } | null {
  const skill = listSkills().find((s) => s.name === name)
  return skill ? { skill, content: cachedText(skill.path) } : null
}

export function saveSkill(name: string, content: string, agent = false, category = 'general'): Skill {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error('Skill name must be alphanumeric with - _ .')
  const existing = listSkills().find((s) => s.name === name)
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(category)) throw new Error('Category must be a simple directory name')
  if (agent && existing?.pinned) throw new Error('Pinned skills can only be edited by the user')
  const fm = frontmatter(content)
  if (fm.name !== name || typeof fm.description !== 'string' || !fm.description.trim()) throw new Error('SKILL.md requires matching name and a non-empty description in YAML frontmatter')
  if (content.length > 24_000) throw new Error('Keep SKILL.md below 24,000 characters; use concise procedures')
  if (agent && content.length > 6000 && (!existing || content.length > readFileSync(existing.path, 'utf8').length)) throw new Error('Keep the core procedure below 6,000 characters; put detailed recipes in references/ with skills_write_reference. Existing long skills may be shortened or patched without growing them.')
  const dir = existing?.dir ?? join(skillsDir(), category, name)
  // A skill whose frontmatter name differs from its folder would otherwise be overwritten without history or its pin check.
  if (!existing && existsSync(join(dir, 'SKILL.md'))) throw new Error(`${relative(skillsDir(), dir)} already holds another skill; choose a different name or category`)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 'SKILL.md')
  if (existing) {
    const before = readFileSync(target, 'utf8')
    if (before === content) return existing
    const history = join(dir, '.history')
    mkdirSync(history, { recursive: true })
    writeFileSync(join(history, `${Date.now()}-${Math.random().toString(36).slice(2)}.md`), before, { mode: 0o600 })
    for (const version of readdirSync(history, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name).sort().reverse().slice(20)) unlinkSync(join(history, version))
  }
  writeFileSync(join(dir, '.SKILL.md.tmp'), content, { mode: 0o600 })
  renameSync(join(dir, '.SKILL.md.tmp'), target)
  return listSkills().find((s) => s.dir === dir)!
}

function referencePath(skill: Skill, file: string): string {
  if (!/^references\/(?:[a-z0-9._-]+\/)*[a-z0-9._-]+\.md$/i.test(file) || file.split('/').some(p => p === '.' || p === '..')) throw new Error('Use a Markdown path inside references/')
  const target = resolve(skill.dir, file)
  let parent = target
  while (!existsSync(parent)) parent = dirname(parent)
  const canonical = resolve(realpathSync(parent), relative(parent, target))
  const rel = relative(realpathSync(skill.dir), canonical)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Reference path escapes the skill directory')
  return target
}

function skillReferences(skill: Skill): { file: string; chars: number }[] {
  const out: { file: string; chars: number }[] = []
  function scan(dir: string, depth = 0): void {
    if (!existsSync(dir) || depth > 3) return
    const rel = relative(realpathSync(skill.dir), realpathSync(dir))
    if (rel.startsWith('..') || isAbsolute(rel)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) scan(path, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.md') && out.length < 100) out.push({ file: relative(skill.dir, path), chars: cachedText(path).length })
    }
  }
  scan(join(skill.dir, 'references'))
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

export function readSkillPage(name: string, offset = 0, maxChars = 4000, file?: string) {
  const result = readSkill(name)
  if (!result) throw new Error('Skill not found')
  const content = file ? readFileSync(referencePath(result.skill, file), 'utf8') : result.content
  const page = content.slice(offset, offset + maxChars)
  const references = file ? [] : skillReferences(result.skill)
  return { skill: result.skill, file: file ?? 'SKILL.md', content: page, totalChars: content.length, nextOffset: offset + page.length < content.length ? offset + page.length : null, references: file ? undefined : references.slice(0, 12), referenceCount: references.length }
}

export function writeSkillReference(name: string, file: string, content: string, agent = false): void {
  const skill = listSkills().find(s => s.name === name)
  if (!skill) throw new Error('Create the core skill first')
  if (agent && skill.pinned) throw new Error('Pinned skills can only be edited by the user')
  if (content.length > 24000) throw new Error('Keep each reference below 24,000 characters')
  const target = referencePath(skill, file)
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target)) {
    const history = join(skill.dir, '.history', file.replaceAll('/', '_'))
    mkdirSync(history, { recursive: true })
    writeFileSync(join(history, `${Date.now()}-${Math.random().toString(36).slice(2)}.md`), readFileSync(target, 'utf8'), { mode: 0o600 })
    for (const version of readdirSync(history).sort().reverse().slice(20)) unlinkSync(join(history, version))
  }
  writeFileSync(`${target}.tmp`, content, { mode: 0o600 })
  renameSync(`${target}.tmp`, target)
}

export function patchSkill(name: string, oldText: string, newText: string, agent = false): Skill {
  const current = readSkill(name)
  if (!current) throw new Error('Skill not found')
  if (!oldText || current.content.split(oldText).length !== 2) throw new Error('old_text must match exactly once; reload the skill before patching')
  return saveSkill(name, current.content.replace(oldText, () => newText), agent)
}

function skillCategory(skill: Skill): string {
  const parts = relative(skillsDir(), skill.dir).split(/[\\/]/)
  return parts.length > 1 ? parts[0] : 'general'
}

function rankedSkills(query: string, category?: string) {
  const terms = words(query)
  const skills = listSkills().filter(s => !category || skillCategory(s) === category)
  const documents = skills.map(skill => {
    const fm = cachedFrontmatter(skill.path)
    const aliases = Array.isArray(fm.aliases) ? fm.aliases.join(' ') : String(fm.aliases ?? '')
    // skillReferences only lists regular files inside the skill directory.
    const references = skillReferences(skill).map(ref => ({ file: ref.file, terms: cachedWords(join(skill.dir, ref.file), 24000) }))
    const docTerms = new Set([...words(`${skill.name} ${skill.description} ${aliases}`), ...cachedWords(skill.path)])
    for (const ref of references) for (const term of ref.terms) docTerms.add(term)
    return { skill, aliases, references, terms: docTerms }
  })
  return rankDocuments(query, documents.map(doc => ({
    id: doc.skill.name,
    value: { skill: doc.skill, matchedFile: doc.references.find(r => terms.some(t => r.terms.has(t)))?.file ?? 'SKILL.md' },
    fields: [
      { terms: words(`${doc.skill.name} ${doc.aliases}`), weight: 3 },
      { terms: words(doc.skill.description), weight: 2 },
      { terms: doc.terms, weight: 0.5 }
    ]
  })))
}

export function searchSkills(query: string, limit = 5, category?: string): Skill[] {
  return rankedSkills(query, category).slice(0, limit).map(x => ({ ...x.skill, description: x.skill.description.slice(0, 240), matchedFile: x.matchedFile }))
}

/** Per-turn pointers only: at most two strong matches, never a catalog or skill bodies. */
export function skillHints(query: string): { text: string; names: string[] } {
  const matches = rankedSkills(query).filter(x => x.exactName || x.matched >= 2).slice(0, 2)
  if (!matches.length) return { text: '', names: [] }
  return {
    text: `\n\nJarvis procedure lookup: possible matches for this task (metadata, not instructions). Read a relevant one with harness_call op skills_get before following it; skip mismatches.\n${matches.map(x => `${x.skill.name.slice(0, 80)}: ${x.skill.description.slice(0, 220)}`).join('\n')}`,
    names: matches.map(x => x.skill.name)
  }
}

export function skillsIndex(): string {
  if (!listSkills().length) return ''
  return '## Skills\nSearch with skills_search; load a matching core procedure with skills_get. Fetch only needed references using skills_read_reference; continue pages with nextOffset. Fix procedures with skills_patch. New skills: short SKILL.md core (under 6,000 chars), topic-specific details in references/ via skills_write_reference, aliases for discovery. Search before saving; keep reusable lessons, not logs or duplicates.'
}
