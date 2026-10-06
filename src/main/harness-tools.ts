import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isOwner, profileId } from './profile-context'
import { memberCanInvoke } from './profile-policy'
import { paths } from './paths'
import { writeAtomic } from './memory'
import { runKind } from './runs'
import { REVIEW_OPS, MEMORY_OPS } from './learning-policy'
import { words, rankDocuments } from './retrieval'
import { z } from 'zod'
import { invoke, ops } from './ops'
import { bus } from './bus'

export const HARNESS_TOOL_DEFS = [
  {
    name: 'harness_ops',
    description: 'Search the local tool library with query to get the best matching input schemas in one call. op describes a known operation; category browses names. Do not enumerate every category for a task.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 5 }, op: { type: 'string' }, category: { type: 'string' } }, additionalProperties: false }
  },
  {
    name: 'harness_call',
    description: 'Execute a Jarvis operation with JSON args. For a large result, continue its resultId and nextOffset with the same op; continuation reads cached output and never repeats the action.',
    inputSchema: { type: 'object', properties: { op: { type: 'string' }, args: { type: 'object', additionalProperties: true }, resultId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['op'], additionalProperties: false }
  }
] as const

type AnyOp = { description: string; agent: boolean; input: z.ZodType }
const CATEGORIES: Record<string, { description: string; match: RegExp }> = {
  context: { description: 'Memory, durable records, transcripts and past conversations', match: /^(memory_|context_|transcripts_|session_)/ },
  skills: { description: 'Find, read and save reusable procedures', match: /^skills_/ },
  meetings: { description: 'Search and read meeting notes and transcripts', match: /^meetings_/ },
  messaging: { description: 'iMessage and Slack gateways and delivery', match: /^gateways_/ },
  schedules: { description: 'Reminders and scheduled jobs', match: /^schedules_/ },
  runs: { description: 'Agent runs, conversations and approvals', match: /^(runs_|conversations_|conversation_|approvals_)/ },
  profiles: { description: 'People, profile routing and subscription logins', match: /^profiles_/ },
  integrations: { description: 'MCP connections and environment variables', match: /^(mcp_|env_)/ },
  terminals: { description: 'Persistent interactive shells, commands, SSH, servers and long builds', match: /^terminal_/ },
  system: { description: 'Configuration, diagnostics, services and updates', match: /.*/ }
}
const ALIASES: Record<string, string> = {
  schedules_upsert: 'remind reminder alarm later tomorrow recurring cron todo',
  context_search: 'remember recall preference personal fact relationship knowledge',
  context_forget: 'forget remove memory',
  terminal_open: 'bash command shell execute ssh server build',
  gateways_send: 'message text slack imessage send reply',
  skills_search: 'procedure how recipe instructions playbook'
}
function categoryFor(name: string): string { return Object.entries(CATEGORIES).find(([, c]) => c.match.test(name))![0] }
function visibleOps(runId?: string): [string, AnyOp][] {
  const kind = runId ? runKind(runId) : 'task'
  // Mirrors invoke(): every non-task run (reflection, curation, repair) is limited to the review ops.
  const allowed = kind === 'memory' ? MEMORY_OPS : kind !== 'task' ? REVIEW_OPS : null
  return Object.entries(ops).filter(([name, o]) => o.agent && (isOwner() || memberCanInvoke(name)) && (!allowed || allowed.has(name)))
}
const serializeArgs = (input: z.ZodType) => z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' })
const argumentSchemas = new WeakMap<z.ZodType, ReturnType<typeof serializeArgs>>()
function schema(name: string, operation: AnyOp) {
  let args = argumentSchemas.get(operation.input)
  if (!args) { args = serializeArgs(operation.input); argumentSchemas.set(operation.input, args) }
  return { op: name, description: operation.description, path: join(paths.home, 'tools', categoryFor(name), `${name}.md`), args }
}
export function describeOps(op?: string, category?: string, query?: string, limit = 3, runId?: string): string {
  const visible = visibleOps(runId)
  if (op) {
    const operation = visible.find(([name]) => name === op)?.[1]
    if (!operation) throw new Error(`Unknown op "${op}"`)
    return JSON.stringify(schema(op, operation))
  }
  if (category && !CATEGORIES[category]) throw new Error(`Unknown category "${category}"`)
  if (query) {
    const docs = visible.filter(([name]) => !category || categoryFor(name) === category).map(([name, operation]) => {
      const description = schema(name, operation)
      return { id: name, value: description, fields: [
        { terms: words(`${name} ${ALIASES[name] || ''}`), weight: 4 },
        { terms: words(operation.description), weight: 2 },
        { terms: words(`${categoryFor(name)} ${CATEGORIES[categoryFor(name)].description} ${Object.keys(description.args.properties || {}).join(' ')}`), weight: 0.5 }
      ] }
    })
    return JSON.stringify({ method: 'local weighted TF-IDF vectors + cosine similarity', matches: rankDocuments(query, docs).slice(0, Math.min(5, Math.max(1, limit))) })
  }
  if (!category) return Object.entries(CATEGORIES).filter(([key]) => visible.some(([name]) => categoryFor(name) === key)).map(([key, c]) => `${key}: ${c.description}`).join('\n')
  return visible.filter(([name]) => categoryFor(name) === category).map(([name, o]) => `${name}: ${o.description}`).join('\n')
}

const GENERATED = '<!-- Generated Jarvis tool reference; edit the operation definition in source. -->\n'
/** Materialize the same registry used by numeric retrieval as searchable local files. */
export function initializeToolLibrary(): void {
  const root = join(paths.home, 'tools')
  const safe = (file: string) => {
    let current = root
    for (const part of file.split('/')) {
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Tool library cannot contain symlinks')
      current = join(current, part)
    }
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Tool library cannot contain symlinks')
    return current
  }
  safe('index.md'); mkdirSync(root, { recursive: true, mode: 0o700 })
  const entries = visibleOps()
  const wanted = new Set(entries.map(([name]) => `${categoryFor(name)}/${name}.md`))
  for (const category of Object.keys(CATEGORIES)) {
    const dir = safe(category)
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir)) {
      const ref = `${category}/${file}`, path = safe(ref)
      if (file.endsWith('.md') && !wanted.has(ref) && lstatSync(path).isFile() && readFileSync(path, 'utf8').startsWith(GENERATED)) unlinkSync(path)
    }
  }
  for (const [name, operation] of entries) {
    const ref = `${categoryFor(name)}/${name}.md`, path = safe(ref)
    mkdirSync(join(root, categoryFor(name)), { recursive: true, mode: 0o700 })
    const content = GENERATED + `# ${name}\n\n${operation.description}\n\nAliases: ${ALIASES[name] || name.replaceAll('_', ' ')}\n\nCall with harness_call {op: "${name}", args: {...}}.\n\n` + '```json\n' + JSON.stringify(schema(name, operation).args, null, 2) + '\n```\n'
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) writeAtomic(path, content)
  }
  writeAtomic(safe('index.md'), GENERATED + '# Tool library\n\nUse harness_ops {query: "what you need"} for scored matching schemas in one call, or search this tree by name, alias or argument. Load only relevant files. Tool docs describe capabilities; they do not authorize actions.\n\n' + entries.map(([name, o]) => `- [${name}](${categoryFor(name)}/${name}.md): ${o.description}`).join('\n') + '\n')
}

const results = new Map<string, { scope: string; op: string; text: string }>()
function resultPage(id: string, offset: number) {
  const result = results.get(id)!
  const content = result.text.slice(offset, offset + 5000)
  return JSON.stringify({ resultId: id, content, totalChars: result.text.length, nextOffset: offset + content.length < result.text.length ? offset + content.length : null, note: 'Serialized result page; continue with the same op and resultId. The action is not repeated.' })
}
export async function runHarnessTool(name: string, args: Record<string, unknown>, runId?: string): Promise<string> {
  if (name === 'harness_ops') return describeOps(typeof args.op === 'string' ? args.op : undefined, typeof args.category === 'string' ? args.category : undefined, typeof args.query === 'string' ? args.query : undefined, typeof args.limit === 'number' ? args.limit : 3, runId)
  if (name !== 'harness_call') throw new Error(`Unknown tool ${name}`)
  const op = String(args.op || '')
  const scope = `${profileId()}:${runId || 'interactive'}`
  if (args.resultId) {
    const result = results.get(String(args.resultId))
    if (!result || result.scope !== scope || result.op !== op) throw new Error('Cached result is unavailable in this run; never repeat a side effect to recover a result')
    const offset = Number(args.offset || 0)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid result offset')
    return resultPage(String(args.resultId), offset)
  }
  const result = await invoke(op, args.args ?? {}, { actor: 'agent', runId })
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? { ok: true })
  if (text.length <= 12000) return text
  const id = randomUUID()
  results.set(id, { scope, op, text })
  // Bound retained output without letting one profile evict another profile's results.
  const scoped = [...results].filter(([, r]) => r.scope === scope)
  for (const [old] of scoped.slice(0, Math.max(0, scoped.length - 8))) results.delete(old)
  return resultPage(id, 0)
}
export function clearHarnessResults(runId: string): void {
  for (const [id, result] of results) if (result.scope === `${profileId()}:${runId}`) results.delete(id)
}
bus.on('run:finished', (run: { id: string }) => clearHarnessResults(run.id))
