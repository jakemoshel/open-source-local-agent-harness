import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import Database from 'better-sqlite3'
import { parse as parseEnv } from 'dotenv'
import { parse as parseYaml } from 'yaml'
import type { MigrationItem, MigrationPlan, McpServerEntry, Schedule } from '@shared/types'
import { cfg, configSchema, deepMerge, files } from '../config'
import { audit, getDb } from '../db'
import { billingReason, readEnvFile, writeEnvFile } from '../env'
import { memoriesDir, soulPath } from '../memory'
import { paths } from '../paths'
import { skillsDir } from '../skills'
import { bus } from '../bus'

export function detectHermes(): { path: string; realPath: string; markers: string[] }[] {
  const candidates = [process.env.HERMES_HOME, join(homedir(), '.hermes')].filter(Boolean) as string[]
  const seen = new Set<string>()
  const out: { path: string; realPath: string; markers: string[] }[] = []
  for (const p of candidates) {
    if (!existsSync(p)) continue
    const real = realpathSync(p)
    if (seen.has(real)) continue
    seen.add(real)
    const markers = ['config.yaml', 'state.db', 'SOUL.md', 'memories', 'skills', '.env', 'cron'].filter((m) => existsSync(join(real, m)))
    if (markers.length) out.push({ path: p, realPath: real, markers })
  }
  return out
}

function readYaml(p: string): Record<string, unknown> {
  if (!existsSync(p)) return {}
  try {
    return (parseYaml(readFileSync(p, 'utf8')) as Record<string, unknown>) ?? {}
  } catch {
    return {}
  }
}

function skillDirs(root: string): string[] {
  const out: string[] = []
  const walk = (d: string, depth: number) => {
    if (depth > 4 || !existsSync(d)) return
    for (const n of readdirSync(d)) {
      if (n.startsWith('.')) continue
      const p = join(d, n)
      if (!statSync(p).isDirectory()) continue
      if (existsSync(join(p, 'SKILL.md'))) out.push(p)
      else walk(p, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

function hermesMcp(config: Record<string, unknown>): Record<string, McpServerEntry> {
  const raw = (config.mcp_servers ?? config.mcpServers ?? (config.mcp as Record<string, unknown> | undefined)?.servers) as Record<string, Record<string, unknown>> | undefined
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, McpServerEntry> = {}
  for (const [name, s] of Object.entries(raw)) {
    if (!s || typeof s !== 'object') continue
    const entry: McpServerEntry = {}
    if (typeof s.command === 'string') entry.command = s.command
    if (Array.isArray(s.args)) entry.args = s.args.map(String)
    if (s.env && typeof s.env === 'object') entry.env = Object.fromEntries(Object.entries(s.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
    if (typeof s.url === 'string') {
      entry.url = s.url
      entry.type = s.transport === 'sse' || s.type === 'sse' ? 'sse' : 'http'
    }
    if (s.headers && typeof s.headers === 'object') entry.headers = Object.fromEntries(Object.entries(s.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
    if (s.enabled === false) entry.enabled = false
    if (entry.command || entry.url) out[name] = entry
  }
  return out
}

const BUILTIN_KEYWORDS: Record<string, RegExp> = {
  'context-cleanup': /context|clean|ingest|reconcil|memory/i,
  'context-review': /review|context|weekly|deep/i,
  'memory-backup': /backup|back up/i,
  'granola-digest': /granola|meeting|digest/i
}

function matchingBuiltin(cron: string, job: Record<string, unknown>, srcId: string): Schedule | undefined {
  const norm = (c: string) => c.trim().split(/\s+/).join(' ')
  const text = `${job.name ?? ''} ${job.title ?? ''} ${job.prompt ?? job.task ?? job.message ?? ''}`
  const list = files.schedules.value.schedules
  const prior = list.find((s) => s.importedFrom === srcId && s.id in BUILTIN_KEYWORDS)
  if (prior) return prior
  return list.find((s) => s.id in BUILTIN_KEYWORDS && !s.importedFrom && norm(s.cron) === norm(cron) && BUILTIN_KEYWORDS[s.id].test(text))
}

function toCron(schedule: unknown): string | null {
  if (!schedule) return null
  if (typeof schedule === 'object') {
    const s = schedule as Record<string, unknown>
    const expr = s.expr ?? s.cron ?? s.expression ?? s.value
    if (typeof expr === 'string') return toCron(expr)
    const minutes = Number(s.minutes ?? s.interval_minutes ?? (s.seconds ? Number(s.seconds) / 60 : NaN))
    if (minutes > 0) return minutes % 60 === 0 ? `0 */${minutes / 60} * * *` : `*/${Math.max(1, Math.round(minutes))} * * * *`
    return null
  }
  const str = String(schedule).trim()
  if (/^(\S+\s+){4,5}\S+$/.test(str)) return str
  const m = /^every\s+(\d+)\s*(m|min|minutes?|h|hr|hours?|d|days?)$/i.exec(str) ?? /^(\d+)\s*(m|h|d)$/i.exec(str)
  if (m) {
    const n = Number(m[1])
    const u = m[2][0].toLowerCase()
    if (u === 'm') return `*/${n} * * * *`
    if (u === 'h') return `0 */${n} * * *`
    if (u === 'd') return `0 9 */${n} * *`
  }
  return null
}

function hermesJobs(home: string): Record<string, unknown>[] {
  for (const p of [join(home, 'cron/jobs.json'), join(home, 'cron.json'), join(home, 'jobs.json')]) {
    if (!existsSync(p)) continue
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'))
      const list = Array.isArray(raw) ? raw : Array.isArray(raw.jobs) ? raw.jobs : Object.values(raw.jobs ?? raw)
      return (list as unknown[]).filter((j): j is Record<string, unknown> => !!j && typeof j === 'object')
    } catch {
      return []
    }
  }
  return []
}

type SessionSource = {
  sessionsTable: string | null
  messagesTable: string
  cols: { sid: string; role: string; content: string; ts: string | null }
  sessCols: { id: string; title: string | null; ts: string | null; source: string | null; model: string | null } | null
}

function introspectState(dbPath: string): { src: SessionSource | null; count: number; messages: number; note: string } {
  if (!existsSync(dbPath)) return { src: null, count: 0, messages: 0, note: 'No state.db' }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name)
    const colsOf = (t: string) => (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name)
    const pick = (cols: string[], ...names: string[]) => names.find((n) => cols.includes(n)) ?? null
    const messagesTable = tables.find((t) => /^messages?$/i.test(t)) ?? tables.find((t) => /message/i.test(t) && !/fts/i.test(t))
    if (!messagesTable) return { src: null, count: 0, messages: 0, note: `No messages table (tables: ${tables.join(', ')})` }
    const mc = colsOf(messagesTable)
    const sid = pick(mc, 'session_id', 'sessionId', 'conversation_id', 'thread_id')
    const role = pick(mc, 'role', 'author', 'sender')
    const content = pick(mc, 'content', 'text', 'body', 'message')
    if (!sid || !role || !content) return { src: null, count: 0, messages: 0, note: `Unrecognized ${messagesTable} columns: ${mc.join(', ')}` }
    const ts = pick(mc, 'timestamp', 'created_at', 'ts', 'time', 'createdAt')
    const sessionsTable = tables.find((t) => /^sessions?$/i.test(t)) ?? null
    let sessCols: SessionSource['sessCols'] = null
    if (sessionsTable) {
      const sc = colsOf(sessionsTable)
      const id = pick(sc, 'id', 'session_id')
      if (id)
        sessCols = {
          id,
          title: pick(sc, 'title', 'name', 'summary'),
          ts: pick(sc, 'started_at', 'created_at', 'start_time', 'timestamp'),
          source: pick(sc, 'source', 'platform', 'channel'),
          model: pick(sc, 'model')
        }
    }
    const count = (db.prepare(`SELECT COUNT(DISTINCT "${sid}") c FROM "${messagesTable}"`).get() as { c: number }).c
    const messages = (db.prepare(`SELECT COUNT(*) c FROM "${messagesTable}"`).get() as { c: number }).c
    return { src: { sessionsTable, messagesTable, cols: { sid, role, content, ts }, sessCols }, count, messages, note: '' }
  } finally {
    db.close()
  }
}

const tsMs = (v: unknown): number => {
  if (typeof v === 'number') return v < 1e12 ? Math.round(v * 1000) : v
  if (typeof v === 'string') {
    const n = Number(v)
    if (!Number.isNaN(n) && v.trim() !== '') return tsMs(n)
    const d = Date.parse(v)
    return Number.isNaN(d) ? Date.now() : d
  }
  return Date.now()
}

const textOf = (v: unknown): string => {
  if (typeof v !== 'string') return v == null ? '' : JSON.stringify(v)
  const t = v.trim()
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const parsed = JSON.parse(t)
      const blocks = Array.isArray(parsed) ? parsed : [parsed]
      const texts = blocks.map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).filter(Boolean)
      if (texts.length) return texts.join('\n')
    } catch {
      return v
    }
  }
  return v
}

function contextRootsNear(home: string): string[] {
  const parent = join(home, '..')
  const out: string[] = []
  if (existsSync(join(parent, 'Context'))) out.push(realpathSync(join(parent, 'Context')))
  const multi = join(parent, 'Contexts')
  if (existsSync(multi)) {
    for (const n of readdirSync(multi)) {
      const p = join(multi, n)
      if (!n.startsWith('.') && statSync(p).isDirectory()) out.push(realpathSync(p))
    }
  }
  return out
}

function orientationInstructions(roots: string[]): string {
  const main = roots[0]
  return [
    `PROFILE.md, NOW.md, TASKS.md and index.md from ${main} are already in your context as a dated snapshot; don't re-read them unless you need something newer.`,
    'Retrieve only what the task needs: search by stable ID, alias, filename and text, open the canonical record, and follow relevant [[links]] to dated sources or Git history.',
    `Person-specific records live in ${roots.slice(1).join(' and ') || 'the other context roots'}; keep each person's facts in their own tree.`,
    'Durable updates follow the repo SCHEMA.md (dated, sourced claims) and are committed to Git. Transcripts and recaps are not automatically facts.'
  ].join('\n')
}

export function planMigration(home: string): MigrationPlan {
  if (!existsSync(home)) throw new Error(`${home} does not exist`)
  home = realpathSync(home)
  const items: MigrationItem[] = []
  const warnings: string[] = []
  const add = (i: Omit<MigrationItem, 'selected'> & { selected?: boolean }) => items.push({ selected: i.action !== 'skip', ...i })

  const soul = join(home, 'SOUL.md')
  if (existsSync(soul)) {
    const conflict = existsSync(soulPath()) && readFileSync(soulPath(), 'utf8').trim() !== readFileSync(soul, 'utf8').trim() && readFileSync(soulPath(), 'utf8').trim() !== ''
    add({ id: 'soul', kind: 'soul', label: 'SOUL.md', source: soul, target: soulPath(), action: 'copy', conflict, note: conflict ? 'Existing SOUL.md will be backed up and replaced' : undefined })
  }

  const memDir = join(home, 'memories')
  if (existsSync(memDir)) {
    for (const f of readdirSync(memDir).filter((f) => f.endsWith('.md'))) {
      const target = join(memoriesDir(), f)
      const conflict = existsSync(target) && readFileSync(target, 'utf8').trim() !== '' && readFileSync(target, 'utf8') !== readFileSync(join(memDir, f), 'utf8')
      add({ id: `memory:${f}`, kind: 'memory', label: `memories/${f}`, source: join(memDir, f), target, action: 'copy', conflict })
    }
  }

  const skillsRoot = join(home, 'skills')
  for (const d of skillDirs(skillsRoot)) {
    const rel = relative(skillsRoot, d)
    const target = join(skillsDir(), rel)
    add({ id: `skill:${rel}`, kind: 'skill', label: rel, source: d, target, action: 'copy', conflict: existsSync(target) })
  }

  const envPath = join(home, '.env')
  const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {}
  const envKeys = Object.keys(env)
  if (envKeys.length) {
    const blocked = envKeys.filter((k) => billingReason(k))
    const existing = readEnvFile()
    const conflicts = envKeys.filter((k) => !billingReason(k) && k in existing && existing[k] !== env[k])
    add({
      id: 'env',
      kind: 'env',
      label: `.env — ${envKeys.length - blocked.length} variables`,
      source: envPath,
      target: paths.env,
      action: 'merge',
      conflict: conflicts.length > 0,
      note: [blocked.length ? `Skipping pay-per-token keys: ${blocked.join(', ')}` : '', conflicts.length ? `Overwrites: ${conflicts.join(', ')}` : ''].filter(Boolean).join(' · ') || undefined
    })
  }

  const config = readYaml(join(home, 'config.yaml'))
  const mcp = hermesMcp(config)
  for (const [name, server] of Object.entries(mcp)) {
    add({ id: `mcp:${name}`, kind: 'mcp', label: `MCP server: ${name}`, source: 'config.yaml → mcp_servers', target: paths.mcp, action: 'convert', conflict: name in files.mcp.value.mcpServers, note: server.command ? `${server.command} ${(server.args ?? []).join(' ')}` : server.url })
  }

  const listFrom = (...keys: string[]) =>
    keys
      .map((k) => env[k])
      .filter(Boolean)
      .flatMap((v) => v.split(/[,\s]+/))
      .filter(Boolean)

  if (env.SLACK_BOT_TOKEN || env.SLACK_APP_TOKEN) {
    const users = listFrom('SLACK_ALLOWED_USERS', 'SLACK_ALLOWED_USER_IDS')
    add({
      id: 'gateway:slack',
      kind: 'gateway',
      label: 'Slack gateway',
      source: '.env SLACK_*',
      target: 'config.json → gateways.slack',
      action: 'convert',
      conflict: false,
      note: `Allowlist: ${users.length ? users.join(', ') : 'none (all workspace users)'} · imported disabled; enable after stopping the Hermes gateway`
    })
  }
  const imKeys = envKeys.filter((k) => /IMESSAGE|BLUEBUBBLES/i.test(k))
  const imConfig = (config.imessage ?? (config.platforms as Record<string, unknown> | undefined)?.imessage) as Record<string, unknown> | undefined
  if (imKeys.length || imConfig) {
    const handles = [...listFrom(...imKeys.filter((k) => /ALLOWED/i.test(k))), ...((imConfig?.allowed_users as string[] | undefined) ?? [])]
    add({
      id: 'gateway:imessage',
      kind: 'gateway',
      label: 'iMessage gateway',
      source: imKeys.length ? `.env ${imKeys.join(', ')}` : 'config.yaml → imessage',
      target: 'config.json → gateways.imessage',
      action: 'convert',
      conflict: false,
      note: `Allowed senders: ${handles.length ? handles.join(', ') : 'none found — add them after import'} · ${env.BLUEBUBBLES_SERVER_URL || env.BLUEBUBBLES_PASSWORD ? 'via BlueBubbles' : 'via Messages.app (needs Full Disk Access)'} · imported disabled until cutover`
    })
  }

  for (const job of hermesJobs(home)) {
    const id = String(job.id ?? job.job_id ?? randomUUID().slice(0, 8))
    const cron = toCron(job.schedule ?? job.cron ?? job.interval)
    const prompt = String(job.prompt ?? job.task ?? job.message ?? '')
    const name = String(job.name ?? job.title ?? prompt.slice(0, 40) ?? id)
    const builtin = cron ? matchingBuiltin(cron, job, id) : undefined
    add({
      id: `schedule:${id}`,
      kind: 'schedule',
      label: `Schedule: ${name}`,
      source: 'cron/jobs.json',
      target: paths.schedules,
      action: cron && prompt ? 'convert' : 'skip',
      conflict: !!builtin || files.schedules.value.schedules.some((s) => s.id === `hermes-${id}`),
      note: cron && prompt ? (builtin ? (builtin.op ? `${cron} · matches built-in "${builtin.name}", which backs up Jarvis files directly — keeping the built-in` : `${cron} · replaces built-in "${builtin.name}" with your exact Hermes prompt`) : `${cron} · imported paused`) : `Could not convert schedule ${JSON.stringify(job.schedule ?? job.cron ?? null)}`
    })
  }

  const state = introspectState(join(home, 'state.db'))
  if (state.src) {
    const already = (getDb().prepare("SELECT COUNT(*) c FROM runs WHERE trigger = 'imported' AND trigger_ref LIKE 'hermes:%'").get() as { c: number }).c
    add({
      id: 'sessions',
      kind: 'sessions',
      label: `Session history — ${state.count} sessions, ${state.messages} messages`,
      source: join(home, 'state.db'),
      target: paths.db,
      action: 'convert',
      conflict: false,
      note: already ? `${already} already imported; only new sessions are added` : 'Searchable via session_search and the Runs page'
    })
  } else if (state.note && existsSync(join(home, 'state.db'))) {
    warnings.push(`state.db: ${state.note}`)
  }

  const known = new Set(['mcp_servers', 'mcpServers', 'mcp', 'imessage', 'platforms'])
  const unmapped = Object.keys(config).filter((k) => !known.has(k))
  if (unmapped.length) warnings.push(`config.yaml keys not migrated (models/providers are replaced by your Claude and Codex subscriptions): ${unmapped.join(', ')}`)
  const roots = contextRootsNear(home)
  if (roots.length) warnings.push(`Durable context stays where it is and is registered as context roots: ${roots.join(', ')}. Agents are told to orient from PROFILE.md, NOW.md, TASKS.md and index.md at session start.`)
  const untouched = ['System-Shims', 'backup-memory.py', 'VERIFY.command', 'WIPE-HERMES.command'].filter((f) => existsSync(join(home, '..', f)))
  if (untouched.length) warnings.push(`Left alone (never read or run): ${untouched.join(', ')}.`)

  return { hermesHome: home, version: typeof config._config_version === 'string' || typeof config._config_version === 'number' ? String(config._config_version) : null, items, warnings }
}

export async function applyMigration(home: string, itemIds: string[], actor: 'user' | 'agent'): Promise<{ applied: string[]; errors: { id: string; error: string }[]; backupDir: string }> {
  const plan = planMigration(home)
  home = plan.hermesHome
  const selected = plan.items.filter((i) => itemIds.includes(i.id) && i.action !== 'skip')
  const backupDir = join(paths.backups, `pre-hermes-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(backupDir, { recursive: true })
  for (const f of [paths.config, paths.safeguards, paths.schedules, paths.mcp, paths.env, paths.soul]) if (existsSync(f)) cpSync(f, join(backupDir, f.split('/').pop()!))
  if (existsSync(paths.memories)) cpSync(paths.memories, join(backupDir, 'memories'), { recursive: true })
  await getDb().backup(join(backupDir, 'harness.db'))

  const applied: string[] = []
  const errors: { id: string; error: string }[] = []
  const config = readYaml(join(home, 'config.yaml'))
  const env = existsSync(join(home, '.env')) ? parseEnv(readFileSync(join(home, '.env'), 'utf8')) : {}
  let nextConfig = cfg()

  for (const item of selected) {
    try {
      switch (item.kind) {
        case 'soul':
        case 'memory':
          mkdirSync(join(item.target, '..'), { recursive: true })
          cpSync(item.source, item.target)
          break
        case 'skill':
          cpSync(item.source, item.target, { recursive: true })
          break
        case 'env': {
          const merged = readEnvFile()
          for (const [k, v] of Object.entries(env)) if (!billingReason(k)) merged[k] = v
          writeEnvFile(merged)
          bus.emit('config:changed', 'env')
          break
        }
        case 'mcp': {
          const name = item.id.slice(4)
          const server = hermesMcp(config)[name]
          files.mcp.write({ mcpServers: { ...files.mcp.value.mcpServers, [name]: server } })
          break
        }
        case 'gateway': {
          const list = (...keys: string[]) =>
            keys
              .map((k) => env[k])
              .filter(Boolean)
              .flatMap((v) => v.split(/[,\s]+/))
              .filter(Boolean)
          if (item.id === 'gateway:slack') {
            nextConfig = configSchema.parse(deepMerge(nextConfig, { gateways: { slack: { enabled: false, allowedUsers: list('SLACK_ALLOWED_USERS', 'SLACK_ALLOWED_USER_IDS') } } })) as typeof nextConfig
          } else {
            const imConfig = (config.imessage ?? (config.platforms as Record<string, unknown> | undefined)?.imessage) as Record<string, unknown> | undefined
            const handles = [...list(...Object.keys(env).filter((k) => /(IMESSAGE|BLUEBUBBLES).*ALLOWED/i.test(k))), ...((imConfig?.allowed_users as string[] | undefined) ?? [])]
            const backend = env.BLUEBUBBLES_SERVER_URL || env.BLUEBUBBLES_PASSWORD ? 'bluebubbles' : 'messages'
            nextConfig = configSchema.parse(
              deepMerge(nextConfig, { gateways: { imessage: { enabled: false, backend, allowedHandles: Array.from(new Set([...nextConfig.gateways.imessage.allowedHandles, ...handles])) } } })
            ) as typeof nextConfig
          }
          break
        }
        case 'schedule': {
          const srcId = item.id.slice('schedule:'.length)
          const job = hermesJobs(home).find((j) => String(j.id ?? j.job_id) === srcId)
          if (!job) throw new Error('Job disappeared')
          const deliverRaw = job.deliver ?? job.delivery
          let deliver: Schedule['deliver']
          if (deliverRaw && typeof deliverRaw === 'object') {
            const d = deliverRaw as Record<string, unknown>
            const raw = String(d.platform ?? d.gateway ?? '').toLowerCase()
            const platform = raw === 'bluebubbles' ? 'imessage' : raw
            const target = String(d.chat_id ?? d.channel ?? d.target ?? '')
            if ((platform === 'slack' || platform === 'imessage') && target) deliver = { gateway: platform, target }
          }
          const cronExpr = toCron(job.schedule ?? job.cron ?? job.interval)!
          const builtin = matchingBuiltin(cronExpr, job, srcId)
          const pendingEnable = job.enabled !== false && job.paused !== true
          if (builtin) {
            files.schedules.write({
              schedules: files.schedules.value.schedules.map((x) =>
                x.id !== builtin.id
                  ? x
                  : builtin.op
                    ? { ...x, importedFrom: srcId, pendingEnable }
                    : { ...x, prompt: String(job.prompt ?? job.task ?? job.message), op: undefined, deliver: deliver ?? x.deliver, source: 'hermes', importedFrom: srcId, enabled: false, pendingEnable }
              )
            })
            break
          }
          const s: Schedule = {
            id: `hermes-${srcId}`,
            timezone: cfg().timezone,
            name: String(job.name ?? job.title ?? `Hermes job ${srcId}`),
            cron: toCron(job.schedule ?? job.cron ?? job.interval)!,
            prompt: String(job.prompt ?? job.task ?? job.message),
            enabled: false,
            pendingEnable: job.enabled !== false && job.paused !== true,
            importedFrom: srcId,
            deliver,
            source: 'hermes'
          }
          const listS = files.schedules.value.schedules.filter((x) => x.id !== s.id)
          files.schedules.write({ schedules: [...listS, s] })
          break
        }
        case 'sessions':
          importSessions(join(home, 'state.db'))
          break
      }
      applied.push(item.id)
    } catch (err) {
      errors.push({ id: item.id, error: (err as Error).message })
    }
  }

  const roots = contextRootsNear(home)
  if (roots.length) {
    const merged = Array.from(new Set([...nextConfig.memory.contextRoots, ...roots]))
    const startup = nextConfig.memory.startupInstructions.trim() || orientationInstructions(roots)
    nextConfig = { ...nextConfig, memory: { ...nextConfig.memory, contextRoots: merged, startupInstructions: startup } }
  }
  files.config.write(nextConfig)
  writeFileSync(join(backupDir, 'migration-report.json'), JSON.stringify({ home, applied, errors, at: new Date().toISOString() }, null, 2))
  audit(actor, 'migration', `Imported ${applied.length} item(s) from Hermes (${home})`, { backupDir }, { applied, errors })
  return { applied, errors, backupDir }
}

function importSessions(dbPath: string): number {
  const { src } = introspectState(dbPath)
  if (!src) return 0
  const hdb = new Database(dbPath, { readonly: true, fileMustExist: true })
  const db = getDb()
  const { sid, role, content, ts } = src.cols
  const exists = db.prepare("SELECT 1 FROM runs WHERE trigger = 'imported' AND trigger_ref = ?")
  const insertRun = db.prepare(
    `INSERT INTO runs (id,title,provider,model,status,trigger,trigger_ref,conversation_key,cwd,prompt,session_id,parent_run_id,result,error,usage,created_at,started_at,finished_at)
     VALUES (?,?,?,?,'succeeded','imported',?,NULL,?,?,NULL,NULL,?,NULL,NULL,?,?,?)`
  )
  const insertEvent = db.prepare('INSERT INTO events (run_id, seq, ts, type, data) VALUES (?,?,?,?,?)')
  const insertFts = db.prepare('INSERT INTO transcript_fts (run_id, role, ts, text) VALUES (?,?,?,?)')
  let imported = 0
  try {
    const sessionIds = (hdb.prepare(`SELECT DISTINCT "${sid}" s FROM "${src.messagesTable}"`).all() as { s: string | number }[]).map((r) => String(r.s))
    const meta = new Map<string, Record<string, unknown>>()
    if (src.sessionsTable && src.sessCols) {
      for (const row of hdb.prepare(`SELECT * FROM "${src.sessionsTable}"`).all() as Record<string, unknown>[]) meta.set(String(row[src.sessCols.id]), row)
    }
    const msgs = hdb.prepare(`SELECT "${role}" role, "${content}" content${ts ? `, "${ts}" ts` : ''} FROM "${src.messagesTable}" WHERE "${sid}" = ? ORDER BY ${ts ? `"${ts}", ` : ''}rowid`)
    const tx = db.transaction((ids: string[]) => {
      for (const id of ids) {
        const ref = `hermes:${id}`
        if (exists.get(ref)) continue
        const rows = msgs.all(id) as { role: string; content: unknown; ts?: unknown }[]
        if (!rows.length) continue
        const m = meta.get(id)
        const firstUser = rows.find((r) => r.role === 'user')
        const lastAssistant = [...rows].reverse().find((r) => r.role === 'assistant')
        const created = tsMs(m && src.sessCols?.ts ? m[src.sessCols.ts] : rows[0].ts)
        const finished = tsMs(rows[rows.length - 1].ts ?? created)
        const titleRaw = (m && src.sessCols?.title ? m[src.sessCols.title] : null) ?? textOf(firstUser?.content ?? '').split('\n')[0]
        const source = m && src.sessCols?.source ? String(m[src.sessCols.source] ?? '') : ''
        const title = `${source ? `[${source}] ` : ''}${String(titleRaw || 'Hermes session').slice(0, 90)}`
        const runId = randomUUID()
        insertRun.run(
          runId,
          title,
          'claude',
          m && src.sessCols?.model ? String(m[src.sessCols.model] ?? '') || null : null,
          ref,
          homedir(),
          textOf(firstUser?.content ?? ''),
          textOf(lastAssistant?.content ?? ''),
          created,
          created,
          finished
        )
        let seq = 0
        for (const r of rows) {
          const text = textOf(r.content)
          if (!text.trim()) continue
          const t = tsMs(r.ts ?? created)
          const type = r.role === 'user' ? 'user' : r.role === 'assistant' ? 'text' : r.role === 'tool' ? 'tool_result' : 'system'
          const data = type === 'tool_result' ? { id: '', output: text.slice(0, 20_000), isError: false } : type === 'system' ? { text: text.slice(0, 5000), role: r.role } : { text }
          insertEvent.run(runId, ++seq, t, type, JSON.stringify(data))
          if (type === 'user' || type === 'text') insertFts.run(runId, type === 'user' ? 'user' : 'assistant', t, text)
        }
        imported++
      }
    })
    tx(sessionIds)
  } finally {
    hdb.close()
  }
  bus.emit('run:update', null)
  return imported
}
