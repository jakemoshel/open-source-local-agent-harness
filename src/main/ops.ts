import { getProfile, listProfiles, saveProfile, asProfile, requireAdmin } from './profiles'
import { isOwner, OWNER_ID, withProfile } from './profile-context'
import { ownerPhone, ownerSlack, setOwnerIds } from './gateways/sender-auth'
import { initializeProfile, refreshProfile } from './profile-runtime'
import { assertMemberInput } from './profile-policy'
import { cancelAllLogins, cancelLogin, loginInstructions, loginResultText, loginStatus, normalizeLoginCode, startLogin, submitLoginCode } from './provider-login'
import { assessmentSchema } from '@shared/rsi'
import { assessScope } from './rsi'
import { rsiStatistics } from './rsi-metrics'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import type { OpInfo, ProviderLogin, Run, Safeguards } from '@shared/types'
import { authStatus } from './auth'
import { installMissingClis } from './cli-install'
import { bus } from './bus'
import { cfg, configSchema, deepMerge, DIRECT_OPS, ensureGranolaArchiveSchedule, files, hasGranolaConnection, mcpEntrySchema, safeguardsSchema, scheduleSchema, validTimezone } from './config'
import { audit, deleteConversation, listConversations, getRun, listApprovals, listAudit, listEvents, listRuns, runStats, searchTranscripts, kvGet } from './db'
import { listEnv, mask, readEnvFile, writeEnvFile, billingReason } from './env'
import { deliver, gatewayStatuses, restartGateway } from './gateways'
import { interpretChat } from './gateways/commands'
import { editMemory, listMemoryFiles, soul, soulPath, writeAtomic, writeMemoryFile, readMemoryFile, searchMemoryFiles, startupMemoryFiles, buildContext } from './memory'
import { archiveMeeting, listMeetings, allMeetingsRoot, readMeeting, readMeetingBounded, meetingText, searchMeetings, meetingDigestContext } from './meetings'
import { applyMigration, detectHermes, planMigration } from './migrate/hermes'
import { paths } from './paths'
import { activeRunIds, cancelRun, instantReply, resolveApproval, sendMessage, startRun, steerRun, waitForRun, runKind } from './runs'
import { chatModel, parseModelCommand } from './model-commands'
import { fireSchedule, lastFired, scheduleError, upcoming } from './scheduler'
import { listSkills, readSkill, saveSkill, searchSkills, patchSkill, readSkillPage, writeSkillReference } from './skills'
import { recordSkill, skillStats, skillPageSeen, evaluateSkills } from './skill-usage'
import { concurrencyTracker } from './concurrency-tracker'
import { REVIEW_OPS, MEMORY_OPS } from './learning-policy'
import { curate } from './learning'
import { listFaults, recordFault, updateFault } from './faults'
import { listImprovement, noteLesson, readImprovement } from './improvement'
import { listModels, planModelChange } from './models'
import { contextList, contextRead, contextSearch, injectedSnapshot, markExplicitReset, roots, transcriptPage } from './context'
import { PERIODS, RECORD_TYPES, writeContextRecord, writeContextSnapshot, commitIngestion, readIngestionPage, contextHistory, forgetContextRecord } from './context-store'
import { hermesCutover, listServices, memoryBackup, permissionStatus, restartApp, scheduleSelfRestart, serviceAction, SETTINGS_PANES } from './system'
import { shell } from 'electron'
import { applyUpdate, checkForUpdates, getUpdateStatus } from './updater'
import { UsageError } from './errors'

type Actor = 'user' | 'agent'
interface OpContext {
  actor: Actor
  runId?: string
  admin?: boolean
  signal?: AbortSignal
}

interface Op<S extends z.ZodType> {
  description: string
  agent: boolean
  input: S
  handler: (args: z.infer<S>, ctx: OpContext) => unknown | Promise<unknown>
}

function op<S extends z.ZodType>(o: Op<S>): Op<S> {
  return o
}

const none = z.object({})
const contextWrites = new Set(['context_upsert', 'context_snapshot', 'context_commit'])
const transcriptCursor = z.object({ eventId: z.number().int().min(0), offset: z.number().int().min(0), throughEventId: z.number().int().min(0), since: z.number().min(0) })
const ONLY_OWNER_CONNECTIONS = 'Connections are only available to the owner’s agent'
const provider = z.enum(['claude', 'codex'])
const effort = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const gatewayName = z.enum(['slack', 'imessage'])

function skillPage(name: string, offset: number, maxChars: number, reload: boolean, ctx: OpContext, file?: string) {
  const page = readSkillPage(name, offset, maxChars, file)
  const result = ctx.actor === 'agent' ? { ...page, skill: { name: page.skill.name, description: page.skill.description.slice(0, 240), pinned: page.skill.pinned } } : page
  if (ctx.actor === 'agent' && ctx.runId) {
    const run = getRun(ctx.runId)
    const session = run?.sessionId ? `${run.provider}:${run.sessionId}` : ctx.runId
    const seen = skillPageSeen(session, name, page.file, offset, maxChars, page.content, reload)
    if (!file && runKind(ctx.runId) === 'task') recordSkill(name, ctx.runId, 'loaded')
    if (seen) return { ...result, content: undefined, alreadyLoaded: true, message: 'This unchanged page is already in this session. Use the earlier content, or reload:true if it was compacted away.' }
  }
  return result
}

/** A sub-run's answer as its parent sees it: long results are cut so one worker cannot flood the parent's context. */
const SUBRUN_RESULT_CHARS = 6000
const BATCH_RESULT_CHARS = 16_000
type Done = Awaited<ReturnType<typeof waitForRun>>
function brief(d: Done, max: number) {
  const text = d.result ?? ''
  const cut = text.length > max
  return { id: d.id, status: d.status, result: cut ? `${text.slice(0, max)}\n… [${text.length - max} more chars: runs_get {id: "${d.id}", events: false}]` : d.result, error: d.error?.slice(0, 2000) ?? null, ...(cut ? { truncated: true } : {}) }
}
function briefAll(done: Done[]) {
  const each = Math.max(1500, Math.min(SUBRUN_RESULT_CHARS, Math.floor(BATCH_RESULT_CHARS / Math.max(1, done.length))))
  return done.map((d) => brief(d, each))
}

/** Waits for every run, rejecting after timeoutMs; the timer is always cleared so finished waits leave nothing behind. */
async function waitAll(ids: string[], timeoutMs: number | undefined, label: string): Promise<Done[]> {
  const all = Promise.all(ids.map((id) => waitForRun(id)))
  if (!timeoutMs) return all
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([all, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs) })])
  } finally { clearTimeout(timer) }
}

function saveSafeguards(next: Safeguards, ctx: OpContext, summary: string): Safeguards {
  const before = files.safeguards.value
  files.safeguards.write(safeguardsSchema.parse(next) as Safeguards)
  audit(ctx.actor, 'safeguards', summary, before, files.safeguards.value)
  return files.safeguards.value
}

export const ops = {

  profiles_list: op({
    description: 'List profiles. The owner sees everyone; members see only their own profile.', agent: true, input: none,
    handler: () => listProfiles()
  }),
  profiles_current: op({
    description: 'Current profile and role.', agent: true, input: none, handler: () => getProfile()
  }),
  profiles_create: op({
    description: 'Owner only: create a member with separate memory, conversations, schedules and provider logins. Assign their phone/email or Slack member ID. No invitation is sent until profiles_invite.',
    agent: true,
    input: z.object({ id: z.string(), name: z.string(), handles: z.array(z.string()).default([]), slackUsers: z.array(z.string()).default([]) }),
    handler: (a, ctx) => {
      requireAdmin()
      if (listProfiles().some((p) => p.id === a.id)) throw new UsageError('Profile already exists; use profiles_update')
      const p = saveProfile({ ...a, role: 'member', enabled: true })
      initializeProfile(p.id)
      audit(ctx.actor, 'profiles', `Created profile ${p.name}`, undefined, p)
      return p
    }
  }),
  profiles_update: op({
    description: 'Owner only: change a member name, contact routing or enabled status.', agent: true,
    input: z.object({ id: z.string(), name: z.string().optional(), handles: z.array(z.string()).optional(), slackUsers: z.array(z.string()).optional(), enabled: z.boolean().optional() }),
    handler: (a, ctx) => {
      requireAdmin()
      const before = getProfile(a.id)
      const p = saveProfile({ ...before, ...a })
      refreshProfile(p.id)
      if (!p.enabled) withProfile(p.id, () => {
        cancelAllLogins(p.id)
        for (const status of ['queued', 'running', 'awaiting_approval'] as const) for (const r of listRuns({ status, limit: -1 })) cancelRun(r.id)
      })
      audit(ctx.actor, 'profiles', `Updated profile ${p.name}`, before, p)
      return p
    }
  }),
  profiles_call: op({
    description: 'Owner only: manage a member profile by invoking an operation in that profile. Use for memory, runs, schedules, env and config. Connections stay in the owner’s profile only.', agent: true,
    input: z.object({ id: z.string(), op: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
    handler: async ({ id, op: name, args }, ctx): Promise<unknown> => {
      requireAdmin()
      if (name.startsWith('profiles_') && !['profiles_login', 'profiles_login_code', 'profiles_login_status', 'profiles_login_cancel', 'profiles_current'].includes(name)) throw new UsageError('Profile management must run in the owner’s profile')
      initializeProfile(id)
      const result = await asProfile(id, () => invoke(name, args, { ...ctx, admin: true }))
      audit(ctx.actor, 'profiles', `Admin invoked ${name} for ${id}`)
      return result
    }
  }),
  profiles_login: op({
    description: 'Start a subscription sign-in for the current profile that the person finishes in their own browser, on any device. Reuses a sign-in that is already waiting. Share the returned instructions verbatim. For Claude, the person sends the code from the approval page back as its own message; never ask for passwords or tokens. notify also sends the instructions, and later the result, to this profile’s own contact on that gateway.',
    agent: true,
    input: z.object({ provider: provider.default('claude'), notify: gatewayName.optional() }),
    handler: async ({ provider: selected, notify }, ctx) => {
      const p = getProfile()
      const target = notify && (notify === 'imessage' ? p.handles[0] : p.slackUsers[0])
      if (notify && !target) throw new UsageError(`${p.name} has no ${notify === 'imessage' ? 'iMessage' : 'Slack'} contact`)
      const listen = notify && target ? { key: `notify:${notify}`, fn: (info: ProviderLogin) => void deliver(notify, target, loginResultText(info)).catch(() => undefined) } : undefined
      const info = await startLogin(selected, listen)
      const instructions = loginInstructions(info, ctx.admin === true)
      if (notify && target) await deliver(notify, target, instructions)
      audit(ctx.actor, 'profiles', `Started ${selected} sign-in for ${p.name}${notify ? ` (sent via ${notify})` : ''}`)
      return { ...info, instructions }
    }
  }),
  profiles_login_code: op({
    description: 'Finish a waiting Claude sign-in with the code from the approval page.', agent: false,
    input: z.object({ code: z.string().min(1).max(2000) }),
    handler: ({ code }) => submitLoginCode(code)
  }),
  profiles_login_status: op({
    description: 'State of the latest subscription sign-in for the current profile.', agent: true,
    input: z.object({ provider: provider.default('claude') }),
    handler: ({ provider: selected }) => loginStatus(selected)
  }),
  profiles_login_cancel: op({
    description: 'Cancel a waiting subscription sign-in for the current profile.', agent: true,
    input: z.object({ provider: provider.default('claude') }),
    handler: ({ provider: selected }) => cancelLogin(selected)
  }),
  profiles_invite: op({
    description: 'Owner only: send an invitation to a contact already assigned to this profile. Call only when the owner asks to invite that person.', agent: true,
    input: z.object({ id: z.string(), gateway: gatewayName }),
    handler: async ({ id, gateway }, ctx) => {
      requireAdmin()
      const p = getProfile(id)
      if (!p.enabled) throw new UsageError('Profile is disabled')
      const target = gateway === 'imessage' ? p.handles[0] : p.slackUsers[0]
      if (!target) throw new UsageError('Add a contact for this gateway first')
      await deliver(gateway, target, `Hi ${p.name} — you've been invited to Jarvis. You have your own conversations, memory and schedules. To use your own subscription, send /connect claude or /connect codex here and I'll send you a sign-in link you can open on your phone or laptop. The owner administers this shared assistant and can manage all profiles.`)
      audit(ctx.actor, 'profiles', `Invited ${p.name} via ${gateway}`)
      return { sent: true }
    }
  }),

  app_info: op({
    description: 'Harness paths, versions and currently active runs.',
    agent: true,
    input: none,
    handler: () => ({ home: paths.home, files: paths, activeRuns: activeRunIds(), node: process.versions.node, electron: process.versions.electron })
  }),

  owner_get: op({
    description: 'The phone number and Slack member ID allowed to message Jarvis.',
    agent: false,
    input: none,
    handler: () => ({ phone: ownerPhone(), slack: ownerSlack() })
  }),

  owner_set: op({
    description: 'Set the owner identities that iMessage and Slack accept. User-only: agents and messages can never widen access.',
    agent: false,
    input: z.object({ phone: z.string().optional(), slack: z.string().optional() }),
    handler: ({ phone, slack }, ctx) => {
      if (ctx.actor !== 'user') throw new UsageError('Only the owner can change who may message Jarvis')
      requireAdmin()
      const before = { phone: ownerPhone(), slack: ownerSlack() }
      const next = setOwnerIds({ phone: phone ?? before.phone ?? undefined, slack: slack ?? before.slack ?? undefined })
      // Route the owner's own messages to the owner profile.
      const p = getProfile(OWNER_ID)
      saveProfile({ ...p, handles: [...p.handles.filter((h) => h !== before.phone), ...(next.phone ? [next.phone] : [])], slackUsers: [...p.slackUsers.filter((u) => u !== before.slack), ...(next.slack ? [next.slack] : [])] })
      audit(ctx.actor, 'gateways', 'Updated owner identities', before, next)
      return next
    }
  }),

  runs_list: op({
    description: 'List recent runs, newest first. Filter by status, trigger or text.',
    agent: true,
    input: z.object({
      status: z.enum(['queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled']).optional(),
      trigger: z.string().optional(),
      q: z.string().optional(),
      conversationKey: z.string().optional(),
      parentRunId: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      before: z.number().optional()
    }),
    handler: (a) => listRuns(a)
  }),

  runs_get: op({
    description: 'Get one run with its event log.',
    agent: true,
    input: z.object({ id: z.string(), events: z.boolean().optional() }),
    handler: ({ id, events }) => {
      const run = getRun(id)
      if (!run) throw new UsageError('Run not found')
      return events === false ? run : { ...run, events: listEvents(id) }
    }
  }),

  conversations_list: op({
    description: 'Conversations (chat threads from the app, Slack, iMessage and persistent schedules), newest first.',
    agent: true,
    input: z.object({ limit: z.number().int().min(1).max(500).optional(), q: z.string().optional() }),
    handler: ({ limit, q }) => listConversations(limit, q)
  }),

  conversation_reset: op({
    description: 'Forget the agent session behind a conversation so the next message starts fresh.',
    agent: true,
    input: z.object({ key: z.string() }),
    handler: ({ key }) => {
      deleteConversation(key)
      markExplicitReset(key)
      return { reset: key }
    }
  }),

  runs_events_many: op({
    description: 'Events for several runs.',
    agent: false,
    input: z.object({ ids: z.array(z.string()).max(500) }),
    handler: ({ ids }) => Object.fromEntries(ids.map((id) => [id, listEvents(id)]))
  }),

  runs_events: op({
    description: 'Events for a run after a sequence number.',
    agent: false,
    input: z.object({ id: z.string(), afterSeq: z.number().optional() }),
    handler: ({ id, afterSeq }) => listEvents(id, afterSeq ?? 0)
  }),

  runs_start: op({
    description: 'Start a new agent run (optionally on the other provider). Use low effort for simple delegated subtasks. Set wait=true to block until it finishes and get its result.',
    agent: true,
    input: z.object({
      prompt: z.string().min(1),
      provider: provider.optional(),
      model: z.string().optional(),
      cwd: z.string().optional(),
      title: z.string().optional(),
      conversationKey: z.string().optional(),
      effort: effort.optional(),
      wait: z.boolean().optional(),
      scopedContext: z.boolean().optional()
    }),
    handler: async ({ wait, ...a }, ctx) => {
      const run = startRun({ ...a, trigger: ctx.actor === 'agent' ? 'agent' : 'ui', parentRunId: ctx.runId })
      if (!wait) return run
      return brief(await waitForRun(run.id), SUBRUN_RESULT_CHARS)
    }
  }),

  runs_batch: op({
    description: 'Dispatch multiple subagent runs in parallel (Jcode-style swarm execution). Set wait=true to block until all complete. Workers use a lean delegated context by default (scopedContext:false gives one full memory). Results are truncated to fit your context; read a full one with runs_get.',
    agent: true,
    input: z.object({
      tasks: z.array(z.object({
        prompt: z.string().min(1),
        cwd: z.string().optional(),
        effort: effort.optional(),
        model: z.string().optional(),
        provider: provider.optional(),
        title: z.string().optional(),
        scopedContext: z.boolean().optional()
      })).min(1).max(10),
      wait: z.boolean().default(false),
      timeoutMs: z.number().int().min(1000).max(600_000).optional()
    }),
    handler: async ({ tasks, wait, timeoutMs }, ctx) => {
      // Swarm workers get the lean delegated context unless a task asks for full memory.
      const runs = tasks.map((t) => startRun({
        ...t,
        scopedContext: t.scopedContext ?? true,
        trigger: ctx.actor === 'agent' ? 'agent' : 'ui',
        parentRunId: ctx.runId
      }))
      if (!wait) return { runs: runs.map((r) => ({ id: r.id, status: r.status, title: r.title })) }

      const completed = await waitAll(runs.map((r) => r.id), timeoutMs, 'Batch')
      return { runs: briefAll(completed) }
    }
  }),

  runs_wait_many: op({
    description: 'Wait for multiple run IDs concurrently until all finish or timeout expires.',
    agent: true,
    input: z.object({
      ids: z.array(z.string()).min(1).max(20),
      timeoutMs: z.number().int().min(1000).max(600_000).optional()
    }),
    handler: async ({ ids, timeoutMs }) => {
      const completed = await waitAll(ids, timeoutMs, 'Wait')
      return { runs: briefAll(completed) }
    }
  }),

  runs_active_files: op({
    description: 'List active file leases and concurrent file conflicts across running agents.',
    agent: true,
    input: none,
    handler: () => ({
      activeFiles: concurrencyTracker.getActiveFiles(),
      conflicts: concurrencyTracker.getConflicts()
    })
  }),

  runs_cancel: op({
    description: 'Cancel a queued or running run.',
    agent: true,
    input: z.object({ id: z.string() }),
    handler: ({ id }) => ({ cancelled: cancelRun(id) })
  }),

  runs_steer: op({
    description: 'Send additional instructions into an active run without cancelling it or starting another run.',
    agent: true,
    input: z.object({ id: z.string(), text: z.string().trim().min(1) }),
    handler: ({ id, text }) => steerRun(id, text)
  }),

  chat_send: op({
    description: 'Send a chat message; steer an existing task in this conversation or start a new one. Every chat command works as on iMessage: NEW, STOP, UPDATE, TERMINAL / $ <cmd>, /connect and sign-in codes, and model switches (CLAUDE OPUS, CODEX SOL, MODEL, MODELS, DEFAULT), alone or in front of a message. conversationKey in the result names the new chat NEW opened.',
    agent: false,
    input: z.object({ prompt: z.string().trim().min(1), conversationKey: z.string(), provider: provider.optional(), model: z.string().optional(), effort: effort.optional(), cwd: z.string().optional() }),
    handler: async (a) => {
      // A command's answer becomes a turn in this thread, like a reply over iMessage; late results (a finished sign-in) too.
      let posted: Run | null = null
      let key = a.conversationKey
      const post = (text: string) => {
        const pref = chatModel(key)
        // A sign-in code is a credential: it must not be saved as the turn's prompt or title.
        const prompt = normalizeLoginCode(a.prompt) ? 'Claude sign-in code' : a.prompt
        return (posted = instantReply({ ...a, conversationKey: key, prompt, trigger: 'ui', provider: pref?.provider ?? a.provider, model: pref?.model ?? a.model }, text))
      }
      const turn = await interpretChat({ key, text: a.prompt, trigger: 'ui', reply: async (text) => { post(text) } })
      key = turn.key ?? key
      const opened = turn.key ? { conversationKey: turn.key } : {}
      const pref = chatModel(key)
      const command = parseModelCommand(a.prompt)
      // The window's pickers follow a switch, so later messages carry it explicitly.
      const picked = command?.kind === 'default' ? { chatModel: { provider: cfg().defaultProvider } } : (command || ('switched' in turn && turn.switched)) && pref ? { chatModel: pref } : {}
      if ('reply' in turn) {
        if (turn.notice) return { run: null, steered: false, notice: turn.reply, ...opened }
        // UPDATE answers early through `post` and may have nothing more to add.
        return { run: turn.reply ? post(turn.reply) : posted, steered: false, ...picked, ...opened }
      }
      // The pickers already carry earlier switches; only a switch typed in front of this message must override them.
      const model = turn.switched && pref ? { provider: pref.provider, model: pref.model, effort: pref.effort } : {}
      const sent = await sendMessage({ ...a, ...model, conversationKey: key, prompt: turn.prompt, trigger: 'ui' })
      return { ...sent, notice: turn.notices.join('\n') || undefined, ...picked, ...opened }
    }
  }),

  models_list: op({
    description: 'Models the signed-in subscription offers for a provider, with the efforts each supports. live=false means the CLI could not be asked and a built-in list is shown.',
    agent: true,
    input: z.object({ provider: provider.default('claude'), refresh: z.boolean().optional() }),
    handler: ({ provider: selected, refresh }) => listModels(selected, refresh)
  }),

  models_set: op({
    description: 'Change the default model and/or thinking effort, and optionally which provider is the default. Same as the Settings page dropdowns. Call models_list first for valid ids and efforts. model/effort: a value sets it, null resets to the CLI/model default, omit to leave unchanged. Applies to new runs; a running chat keeps its model.',
    agent: true,
    input: z.object({
      provider: provider.optional().describe('Provider to configure; defaults to the current default provider'),
      model: z.string().trim().min(1).nullable().optional(),
      effort: effort.nullable().optional(),
      makeDefault: z.boolean().optional().describe('Also make this the default provider')
    }),
    handler: async ({ provider: chosen, model, effort: level, makeDefault }, ctx) => {
      const before = cfg()
      const target = chosen ?? before.defaultProvider
      if (model === undefined && level === undefined && !makeDefault) throw new UsageError('Nothing to change: pass model, effort or makeDefault.')
      const { models, live } = await listModels(target)
      const plan = planModelChange(target, before.providers[target] as Record<string, unknown>, { model, effort: level }, models, live)
      const next = configSchema.parse({
        ...before,
        defaultProvider: makeDefault ? target : before.defaultProvider,
        providers: { ...before.providers, [target]: { ...before.providers[target], model: plan.model, [plan.effortKey]: plan.effort } }
      })
      files.config.write(next as never)
      audit(ctx.actor, 'config', `Default ${target} model → ${plan.model ?? 'CLI default'}${plan.effort ? ` · ${plan.effort}` : ''}`, before.providers[target], cfg().providers[target])
      return { provider: target, defaultProvider: cfg().defaultProvider, model: plan.model ?? null, effort: plan.effort ?? null, notes: plan.notes }
    }
  }),

  runs_stats: op({
    description: 'Run counts and token totals per day.',
    agent: true,
    input: z.object({ days: z.number().int().min(1).max(365).default(14) }),
    handler: ({ days }) => runStats(Date.now() - days * 86_400_000)
  }),

  approvals_list: op({
    description: 'List tool-call approvals.',
    agent: true,
    input: z.object({ status: z.enum(['pending', 'approved', 'denied', 'expired']).optional() }),
    handler: ({ status }) => listApprovals(status)
  }),

  approvals_resolve: op({
    description: 'Approve or deny a pending tool call. always=true also allows this kind of action from now on.',
    agent: false,
    input: z.object({ id: z.string(), approve: z.boolean(), always: z.boolean().optional() }),
    handler: ({ id, approve, always }) => {
      const a = resolveApproval(id, approve, always)
      if (!a) throw new UsageError('Approval is no longer pending')
      return a
    }
  }),

  schedules_list: op({
    description: 'List scheduled jobs with their next fire times.',
    agent: true,
    input: none,
    handler: () => files.schedules.value.schedules.map((s) => ({ ...s, next: s.enabled ? upcoming(s) : [], lastFiredAt: lastFired(s.id), cronError: scheduleError(s) }))
  }),

  schedules_upsert: op({
    description: 'Create or update a scheduled job; on update, pass only the fields to change. Recurring: cron has 5 or 6 fields, evaluated in timezone (IANA, default the harness timezone). One-off (reminders, "check back in 2 hours"): set runAt to an ISO 8601 time with offset instead of cron; it fires once (even if Jarvis was asleep or restarting, within 12 hours) and then disables itself. Set deliver to message the user the result. Set op (+opArgs) instead of prompt to run a harness op directly without a model. provider/model/effort pick the agent, model and thinking level for this schedule (call models_list for valid ids and each model\'s efforts). Pass null for provider, model, effort, timezone, cwd, deliver or runAt to reset it to the default. Omit id to create.',
    agent: true,
    input: scheduleSchema.partial().extend({
      // Zod applies defaults even inside partial schemas; updates must not inject them.
      cron: scheduleSchema.shape.cron.removeDefault().optional(), prompt: scheduleSchema.shape.prompt.removeDefault().optional(),
      enabled: scheduleSchema.shape.enabled.removeDefault().optional(),
      provider: provider.nullable().optional(), model: z.string().trim().min(1).nullable().optional(), effort: effort.nullable().optional(),
      timezone: z.string().nullable().optional(), cwd: z.string().nullable().optional(), deliver: scheduleSchema.shape.deliver.nullable(), runAt: z.string().nullable().optional()
    }),
    handler: async (input, ctx) => {
      const s = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as typeof input
      const cleared = Object.keys(s).filter((k) => s[k as keyof typeof s] === null)
      const list = files.schedules.value.schedules
      const id = s.id ?? randomUUID().slice(0, 8)
      const prev = list.find((x) => x.id === id)
      const merged: Record<string, unknown> = { ...prev, ...s, id }
      for (const k of cleared) delete merged[k]
      // A model from the other provider would fail at run time; drop it when the agent changes.
      if (s.provider !== undefined && prev?.provider !== merged.provider && s.model === undefined) { delete merged.model; if (s.effort === undefined) delete merged.effort }
      const next = scheduleSchema.parse(merged)
      const err = scheduleError(next)
      if (err) throw new UsageError(next.runAt ? err : `Invalid cron: ${err}`)
      if (s.runAt && Date.parse(s.runAt) < Date.now() - 60_000) throw new UsageError(`runAt ${s.runAt} is in the past`)
      if (next.timezone && !validTimezone(next.timezone)) throw new UsageError(`Unknown timezone "${next.timezone}" — use an IANA name like America/New_York`)
      if (next.op && !DIRECT_OPS.has(next.op)) throw new UsageError(`op jobs may only run: ${[...DIRECT_OPS].join(', ')}. Use a prompt instead.`)
      if (next.effort && !next.op) {
        const { models, live } = await listModels(next.provider ?? cfg().defaultProvider)
        const model = next.model ? models.find((m) => m.id === next.model) : undefined
        const supported = model ? model.efforts : [...new Set(models.flatMap((m) => m.efforts))]
        if (live && supported.length && !supported.includes(next.effort)) throw new UsageError(`${next.model ?? 'The default model'} does not support effort "${next.effort}". Supported: ${supported.join(', ')}`)
      }
      files.schedules.write({ schedules: prev ? list.map((x) => (x.id === id ? next : x)) : [...list, next] })
      audit(ctx.actor, 'schedules', `${prev ? 'Updated' : 'Created'} schedule "${next.name}"`, prev ?? null, next)
      return next
    }
  }),

  schedules_delete: op({
    description: 'Delete a scheduled job.',
    agent: true,
    input: z.object({ id: z.string() }),
    handler: ({ id }, ctx) => {
      const list = files.schedules.value.schedules
      const prev = list.find((x) => x.id === id)
      if (!prev) throw new UsageError('Schedule not found')
      files.schedules.write({ schedules: list.filter((x) => x.id !== id) })
      audit(ctx.actor, 'schedules', `Deleted schedule "${prev.name}"`, prev, null)
      return { deleted: id }
    }
  }),

  schedules_run_now: op({
    description: 'Fire a scheduled job immediately.',
    agent: true,
    input: z.object({ id: z.string() }),
    handler: async ({ id }) => {
      const s = files.schedules.value.schedules.find((x) => x.id === id)
      if (!s) throw new UsageError('Schedule not found')
      return { runId: await fireSchedule(s) }
    }
  }),

  gateways_status: op({
    description: 'Status of the Slack and iMessage gateways.',
    agent: true,
    input: none,
    handler: () => gatewayStatuses().map((g) => ({ ...g, config: cfg().gateways[g.name] }))
  }),

  gateways_configure: op({
    description: 'Change a gateway config (enabled, allowedUsers/allowedHandles, provider, cwd, replyInThread, pollMs, Slack meetingChannels: channel IDs whose posts, including bot posts like Granola notes, are archived straight into meetings memory without a model run).',
    agent: true,
    input: z.object({ name: gatewayName, patch: z.record(z.string(), z.unknown()) }),
    handler: ({ name, patch }, ctx) => {
      const before = cfg().gateways[name]
      const next = configSchema.parse(deepMerge(cfg(), { gateways: { [name]: patch } }))
      files.config.write(next as never)
      audit(ctx.actor, 'gateways', `Configured ${name}`, before, cfg().gateways[name])
      return cfg().gateways[name]
    }
  }),

  gateways_restart: op({
    description: 'Restart a gateway.',
    agent: true,
    input: z.object({ name: gatewayName }),
    handler: ({ name }) => restartGateway(name)
  }),

  gateways_send: op({
    description: 'Send a message through a gateway. Slack target: "CHANNEL" or "CHANNEL:THREAD_TS". iMessage target: chat GUID, phone or email.',
    agent: true,
    input: z.object({ gateway: gatewayName, target: z.string(), text: z.string() }),
    handler: async ({ gateway, target, text }) => {
      await deliver(gateway, target, text)
      return { sent: true }
    }
  }),

  safeguards_get: op({
    description: 'Current safeguard policy: ordered rules (first match wins), default action, approval timeout and Codex sandbox settings.',
    agent: true,
    input: none,
    handler: () => files.safeguards.value
  }),

  safeguards_update: op({
    description:
      'Change safeguards when the user asks. Rules: {id, tool (glob, e.g. "Bash", "mcp__*"), match (glob or "re:<regex>" against the command/path/url), action allow|ask|deny, note}. upsertRules replaces rules with the same id, else appends (or inserts at position).',
    agent: true,
    input: z.object({
      defaultAction: z.enum(['allow', 'ask', 'deny']).optional(),
      approvalTimeoutSec: z.number().int().min(10).optional(),
      upsertRules: z
        .array(z.object({ id: z.string(), tool: z.string(), match: z.string().optional(), action: z.enum(['allow', 'ask', 'deny']), note: z.string().optional(), position: z.number().int().optional() }))
        .optional(),
      removeRuleIds: z.array(z.string()).optional(),
      codex: z.object({ sandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(), networkAccess: z.boolean().optional() }).optional(),
      reason: z.string().optional()
    }),
    handler: (a, ctx) => {
      const cur = structuredClone(files.safeguards.value)
      let rules = cur.rules.filter((r) => !a.removeRuleIds?.includes(r.id))
      for (const { position, ...r } of a.upsertRules ?? []) {
        const i = rules.findIndex((x) => x.id === r.id)
        if (i >= 0) rules[i] = r
        else if (position !== undefined) rules.splice(position, 0, r)
        else rules.push(r)
      }
      rules = rules.filter(Boolean)
      const next: Safeguards = {
        ...cur,
        rules,
        defaultAction: a.defaultAction ?? cur.defaultAction,
        approvalTimeoutSec: a.approvalTimeoutSec ?? cur.approvalTimeoutSec,
        codex: { ...cur.codex, ...a.codex }
      }
      return saveSafeguards(next, ctx, a.reason ?? 'Updated safeguards')
    }
  }),

  safeguards_set: op({
    description: 'Replace the whole safeguards document.',
    agent: false,
    input: z.object({ safeguards: safeguardsSchema }),
    handler: ({ safeguards }, ctx) => saveSafeguards(safeguards as Safeguards, ctx, 'Replaced safeguards')
  }),

  safeguards_revert: op({
    description: 'Restore safeguards to the state before an audit entry.',
    agent: false,
    input: z.object({ auditId: z.number() }),
    handler: ({ auditId }, ctx) => {
      const entry = listAudit('safeguards', 500).find((e) => e.id === auditId)
      if (!entry?.before) throw new UsageError('Nothing to revert to')
      return saveSafeguards(entry.before as Safeguards, ctx, `Reverted change #${auditId}`)
    }
  }),

  mcp_list: op({
    description: 'Configured MCP servers (the built-in `harness` server is always attached).',
    agent: true,
    input: none,
    handler: () => isOwner() ? files.mcp.value.mcpServers : {}
  }),

  mcp_upsert: op({
    description: 'Add or update an MCP server. stdio: {command, args, env}; remote: {type:"http"|"sse", url, headers}. providers limits it to claude/codex.',
    agent: true,
    input: z.object({ name: z.string().regex(/^[A-Za-z0-9_-]+$/), server: mcpEntrySchema }),
    handler: ({ name, server }, ctx) => {
      if (name === 'harness') throw new UsageError('"harness" is reserved')
      if (!isOwner()) throw new UsageError(ONLY_OWNER_CONNECTIONS)
      const cur = files.mcp.value.mcpServers
      files.mcp.write({ mcpServers: { ...cur, [name]: server } })
      ensureGranolaArchiveSchedule()
      audit(ctx.actor, 'mcp', `${cur[name] ? 'Updated' : 'Added'} MCP server "${name}"`, cur[name] ?? null, server)
      return server
    }
  }),

  mcp_delete: op({
    description: 'Remove an MCP server.',
    agent: true,
    input: z.object({ name: z.string() }),
    handler: ({ name }, ctx) => {
      if (!isOwner()) throw new UsageError(ONLY_OWNER_CONNECTIONS)
      const cur = { ...files.mcp.value.mcpServers }
      const prev = cur[name]
      delete cur[name]
      files.mcp.write({ mcpServers: cur })
      ensureGranolaArchiveSchedule()
      audit(ctx.actor, 'mcp', `Removed MCP server "${name}"`, prev ?? null, null)
      return { deleted: name }
    }
  }),

  env_list: op({
    description: 'Variables in the harness .env that agents receive. Values are masked for the agent. Pay-per-token API keys are listed but never passed to agents.',
    agent: true,
    input: none,
    handler: (_a, ctx) => listEnv().map((e) => (ctx.actor === 'agent' ? { ...e, value: e.masked } : e))
  }),

  env_set: op({
    description: 'Set a variable in the harness .env.',
    agent: true,
    input: z.object({ key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: z.string() }),
    handler: ({ key, value }, ctx) => {
      const vars = readEnvFile()
      const existed = key in vars
      vars[key] = value
      writeEnvFile(vars)
      audit(ctx.actor, 'env', `${existed ? 'Updated' : 'Added'} ${key}`, existed ? { key } : null, { key, value: mask(value) })
      bus.emit('config:changed', 'env')
      const reason = billingReason(key)
      return { key, masked: mask(value), blocked: !!reason, note: reason ? `Stored, but never passed to agents: ${reason}` : undefined }
    }
  }),

  env_delete: op({
    description: 'Remove a variable from the harness .env.',
    agent: true,
    input: z.object({ key: z.string() }),
    handler: ({ key }, ctx) => {
      const vars = readEnvFile()
      delete vars[key]
      writeEnvFile(vars)
      audit(ctx.actor, 'env', `Removed ${key}`, { key }, null)
      bus.emit('config:changed', 'env')
      return { deleted: key }
    }
  }),

  config_get: op({
    description: 'Harness config: providers/models, default cwd, memory, skills dir, gateways, UI.',
    agent: true,
    input: none,
    handler: () => cfg()
  }),

  config_update: op({
    description: 'Deep-merge a patch into the harness config.',
    agent: true,
    input: z.object({ patch: z.record(z.string(), z.unknown()) }),
    handler: ({ patch }, ctx) => {
      const before = cfg()
      const next = configSchema.parse(deepMerge(before, patch))
      if (!validTimezone(next.timezone)) throw new UsageError(`Unknown timezone "${next.timezone}"`)
      files.config.write(next as never)
      audit(ctx.actor, 'config', 'Updated config', before, cfg())
      return cfg()
    }
  }),

  memory_list: op({
    description: 'List native memory metadata. Use memory_read for contents; only configured startup files are automatically injected.',
    agent: true,
    input: none,
    handler: (_args, ctx) => ctx.actor === 'user'
      ? { soulPath: soulPath(), soul: soul(), files: listMemoryFiles() }
      : { soulPath: soulPath(), files: listMemoryFiles().map(({ content, ...file }) => ({ ...file, chars: content.length })) }
  }),

  memory_search: op({
    description: 'Search native memory notes and return short excerpts; use context_search for durable records and meetings_search for meetings.',
    agent: true,
    input: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(10).default(5) }),
    handler: ({ query, limit }) => searchMemoryFiles(query, limit)
  }),

  memory_read: op({
    description: 'Read one native memory file or SOUL.md, in bounded pages. Continue using nextOffset only when needed.',
    agent: true,
    input: z.object({ file: z.string(), offset: z.number().int().min(0).default(0), maxChars: z.number().int().min(100).max(6000).default(4000) }),
    handler: ({ file, offset, maxChars }) => readMemoryFile(file, offset, maxChars)
  }),

  memory_edit: op({
    description: 'Add, replace or remove compact operational notes in MEMORY.md. USER.md is legacy compatibility; personal facts belong in the linked context tree maintained by the background reconciler. Entries are separated by §; limits are enforced.',
    agent: true,
    input: z.object({ file: z.string().default('MEMORY.md'), action: z.enum(['add', 'replace', 'remove']), text: z.string().default(''), old_text: z.string().optional() }),
    handler: ({ file, action, text, old_text }, ctx) => {
      const next = editMemory(file, action, text, old_text)
      audit(ctx.actor, 'memory', `${action} in ${file}`, old_text ?? null, text || null)
      return { file, chars: next.length, limit: cfg().memory.limits[file] ?? null }
    }
  }),

  memory_write: op({
    description: 'Overwrite a native memory file.',
    agent: false,
    input: z.object({ file: z.string(), content: z.string() }),
    handler: ({ file, content }, ctx) => {
      writeMemoryFile(file, content)
      audit(ctx.actor, 'memory', `Edited ${file}`)
      return { ok: true }
    }
  }),

  meetings_list: op({
    description: 'List Granola meetings stored in the separate meetings archive under memory. Returns dates, titles, attendees and transcript availability.',
    agent: true,
    input: z.object({ limit: z.number().int().min(1).max(500).optional() }),
    handler: ({ limit }) => listMeetings(limit)
  }),

  meetings_status: op({
    description: 'Location, meeting count and automatic Granola sync status for the separate meeting archive.',
    agent: true,
    input: none,
    handler: () => ({ path: allMeetingsRoot(), count: listMeetings(10_000).length, syncEnabled: hasGranolaConnection() && files.schedules.value.schedules.some((s) => s.id === 'granola-archive' && s.enabled) })
  }),

  meetings_sync_now: op({
    description: 'Start a Granola archive sync through the connected Granola MCP server.',
    agent: false,
    input: none,
    handler: async () => {
      if (!isOwner()) throw new UsageError('Granola sync is configured by the owner')
      ensureGranolaArchiveSchedule()
      const schedule = files.schedules.value.schedules.find((s) => s.id === 'granola-archive')
      if (!hasGranolaConnection() || !schedule) throw new UsageError('Connect Granola in Settings → Integrations first')
      return { runId: await fireSchedule(schedule) }
    }
  }),

  meetings_sync_direct: op({
    description: 'Import Granola notes verbatim through the existing Claude MCP OAuth connection, without a model turn.',
    agent: true,
    input: none,
    handler: async (_args, ctx) => {
      const { syncGranola } = await import('./granola-sync')
      return syncGranola(ctx.signal ?? AbortSignal.timeout(30 * 60_000))
    }
  }),

  meetings_digest_context: op({
    description: 'Today’s local meeting notes, bounded to 10000 characters total and excluding transcripts.',
    agent: true,
    input: none,
    handler: () => ({ ...meetingDigestContext(Date.now(), 10000), granolaLastSync: kvGet<number>('granola:sync:last-success') })
  }),

  meetings_search: op({
    description: 'Search the Granola meeting archive by title, date, attendee, supplied summary and available transcript.',
    agent: true,
    input: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(100).optional() }),
    handler: ({ query, limit }) => searchMeetings(query, limit)
  }),

  meetings_read: op({
    description: 'Read one archived Granola meeting: metadata, the first 8,000 summary characters and the transcript size. Page longer summaries and transcripts with meetings_text.',
    agent: true,
    input: z.object({ id: z.string().min(1) }),
    handler: ({ id }, ctx) => ctx.actor === 'user' ? readMeeting(id) : readMeetingBounded(id)
  }),

  meetings_text: op({
    description: 'Read a bounded slice of a meeting summary or transcript. Use offset to continue through long source text.',
    agent: true,
    input: z.object({ id: z.string().min(1), section: z.enum(['summary', 'transcript']), offset: z.number().int().min(0).default(0), maxChars: z.number().int().min(100).max(8_000).default(8_000) }),
    handler: ({ id, section, offset, maxChars }) => meetingText(id, section, offset, maxChars)
  }),

  meetings_archive: op({
    description: 'Archive an exact Granola meeting record. Copy Granola enhanced notes into summary verbatim; include transcript only if Granola supplied one. Repeated imports update the same meeting without discarding an existing transcript.',
    agent: true,
    input: z.object({ id: z.string().min(1), title: z.string().min(1), date: z.string().min(1), attendees: z.array(z.string()).optional(), summary: z.string().min(1), transcript: z.string().nullable().optional() }),
    handler: (input, ctx) => {
      const saved = archiveMeeting(input)
      audit(ctx.actor, 'meetings', `Archived Granola meeting ${saved.title} (${saved.day})`, undefined, { id: saved.id, transcriptStatus: saved.transcriptStatus })
      return saved
    }
  }),

  soul_set: op({
    description: 'Overwrite SOUL.md (agent identity and startup instructions).',
    agent: false,
    input: z.object({ content: z.string() }),
    handler: ({ content }, ctx) => {
      const p = soulPath()
      const before = existsSync(p) ? readFileSync(p, 'utf8') : ''
      writeAtomic(p, content)
      audit(ctx.actor, 'soul', 'Edited SOUL.md', before.length, content.length)
      return { ok: true }
    }
  }),

  session_search: op({
    description: 'Full-text search over past run transcripts (including imported Hermes sessions). Returns snippets with run ids, source channel, triggerRef and conversationKey.',
    agent: true,
    input: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(100).optional() }),
    handler: ({ query, limit }) => searchTranscripts(query, limit)
  }),

  skills_list: op({
    description: 'Installed skills.',
    agent: true,
    input: none,
    handler: (_args, ctx) => ctx.actor === 'user' ? listSkills() : listSkills().map(s => ({ name: s.name, description: s.description.slice(0, 240), pinned: s.pinned }))
  }),

  skills_search: op({
    description: 'Find skills for a task by keywords. Returns the best matches with descriptions and paths; read one with skills_get.',
    agent: true,
    input: z.object({ query: z.string().min(1), category: z.string().optional(), limit: z.number().int().min(1).max(20).optional() }),
    handler: ({ query, category, limit }, ctx) => {
      const hits = searchSkills(query, limit, category)
      return ctx.actor === 'user' ? hits : hits.map(({ dir: _dir, path: _path, ...hit }) => hit)
    }
  }),

  skills_get: op({
    description: 'Load a core procedure (4,000 chars by default) and reference paths. Continue with nextOffset only as needed. Repeated unchanged pages are suppressed; reload:true reloads after compaction.',
    agent: true,
    input: z.object({ name: z.string(), offset: z.number().int().min(0).default(0), maxChars: z.number().int().min(100).max(6000).default(4000), reload: z.boolean().default(false) }),
    handler: ({ name, offset, maxChars, reload }, ctx) => {
      if (ctx.actor === 'agent') return skillPage(name, offset, maxChars, reload, ctx)
      const s = readSkill(name)
      if (!s) throw new UsageError('Skill not found')
      return s
    }
  }),

  skills_save: op({
    description: 'Create/update a short SKILL.md core with YAML name, description and optional aliases. New agent cores are at most 6,000 chars; detailed recipes go in references/ via skills_write_reference. category groups new skills.',
    agent: true,
    input: z.object({ name: z.string(), content: z.string(), category: z.string().default('general') }),
    handler: ({ name, content, category }, ctx) => {
      const before = readSkill(name)?.content ?? null
      const s = saveSkill(name, content, ctx.actor === 'agent', category)
      if (ctx.actor === 'agent' && ctx.runId && runKind(ctx.runId) === 'task') recordSkill(name, ctx.runId, 'saved')
      audit(ctx.actor, 'skills', `${before ? 'Updated' : 'Created'} skill "${name}"`, before, content)
      return s
    }
  }),

  skills_read_reference: op({
    description: 'Read one supporting Markdown recipe from a skill’s references/ directory, in bounded pages. Load only the reference needed for the task.',
    agent: true,
    input: z.object({ name: z.string(), file: z.string(), offset: z.number().int().min(0).default(0), maxChars: z.number().int().min(100).max(6000).default(4000), reload: z.boolean().default(false) }),
    handler: ({ name, file, offset, maxChars, reload }, ctx) => skillPage(name, offset, maxChars, reload, ctx, file)
  }),

  skills_write_reference: op({
    description: 'Save a topic-specific Markdown recipe under references/. Preserve a short core; extend an existing topic file rather than adding incident logs.',
    agent: true,
    input: z.object({ name: z.string(), file: z.string(), content: z.string().max(24000) }),
    handler: ({ name, file, content }, ctx) => {
      writeSkillReference(name, file, content, ctx.actor === 'agent')
      if (ctx.actor === 'agent' && ctx.runId && runKind(ctx.runId) === 'task') recordSkill(name, ctx.runId, 'saved')
      audit(ctx.actor, 'skills', `Updated ${name}/${file}`, null, { chars: content.length })
      return { name, file, chars: content.length }
    }
  }),

  skills_patch: op({
    description: 'Fix one exact passage in an existing skill. Reload first; old_text must match once. Pinned skills are protected from agent edits.',
    agent: true,
    input: z.object({ name: z.string(), old_text: z.string().min(1), new_text: z.string() }),
    handler: ({ name, old_text, new_text }, ctx) => {
      const before = readSkill(name)?.content ?? null
      const skill = patchSkill(name, old_text, new_text, ctx.actor === 'agent')
      if (ctx.actor === 'agent' && ctx.runId && runKind(ctx.runId) === 'task') recordSkill(name, ctx.runId, 'saved')
      audit(ctx.actor, 'skills', `Patched skill "${name}"`, before, readSkill(name)?.content)
      return skill
    }
  }),

  skills_stats: op({
    description: 'Skill suggestions, actual loads and outcomes of tasks that loaded them. A load is retrieval, not proof the procedure was followed.',
    agent: true, input: none, handler: () => skillStats()
  }),

  skills_evaluate: op({
    description: 'Hermes-style skill utility and health evaluation: inspect success rates, failure patterns, and identify skills needing review or patching.',
    agent: true,
    input: z.object({ sinceDays: z.number().int().min(1).max(365).optional() }),
    handler: ({ sinceDays }) => {
      const since = sinceDays ? Date.now() - sinceDays * 86_400_000 : 0
      return evaluateSkills(since)
    }
  }),

  context_search: op({
    description: 'Find durable memory records about a person, organization, preference, decision, fact or topic. Returns ranked ids with short snippets; open only the ones you need with context_read.',
    agent: true,
    input: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(50).optional(), includeHistorical: z.boolean().default(false) }),
    handler: ({ query, limit, includeHistorical }) => contextSearch(query, limit, includeHistorical)
  }),

  context_read: op({
    description: 'Open one memory record by id, alias, filename or path. Returns its body, dates and sources, plus typed [[links]] and backlinks; follow one only when it is relevant.',
    agent: true,
    input: z.object({ ref: z.string().min(1), offset: z.number().int().min(0).default(0), maxChars: z.number().int().min(100).max(6000).default(4000) }),
    handler: ({ ref, offset, maxChars }) => contextRead(ref, offset, maxChars)
  }),

  context_list: op({
    description: 'Page through memory records (ids, aliases, type, status, size), filtered by type, folder or oversized:true. For maintenance; to answer a question, use context_search.', agent: true,
    input: z.object({ type: z.enum(RECORD_TYPES).optional(), folder: z.string().max(200).optional(), oversized: z.boolean().optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(50) }),
    handler: (args) => contextList(args)
  }),
  context_upsert: op({
    description: 'Background reconciler: create or correct one canonical sourced record about a single subject (1,500 chars; recaps 4,000, conversations 3,000). Split broader material into linked records; topic records are hubs of [[links]]. Foreground durable memory is read-only.', agent: true,
    input: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,119}$/), type: z.enum(RECORD_TYPES), aliases: z.array(z.string().max(100)).max(30).default([]), body: z.string().min(1).max(4000), sources: z.array(z.string().max(200)).min(1).max(50), status: z.enum(['current', 'historical', 'disputed']).default('current'), expires: z.string().date().optional(), period: z.enum(PERIODS).optional() }),
    handler: (args, ctx) => { const result = writeContextRecord(args); audit(ctx.actor, 'memory', `Reconciled [[${args.id}]]`); return result }
  }),
  context_snapshot: op({
    description: 'Background reconciler: replace a compact PROFILE.md (identity/autonomy/style), NOW.md (current priorities), or TASKS.md (explicit commitments), with source links.', agent: true,
    input: z.object({ file: z.enum(['PROFILE.md', 'NOW.md', 'TASKS.md']), body: z.string().max(1600), sources: z.array(z.string().max(200)).max(50) }),
    handler: ({ file, body, sources }) => writeContextSnapshot(file, body, sources)
  }),
  context_commit: op({
    description: 'Commit reconciled memory files. throughEventId finishes a fully read transcript window. resumeCursor checkpoints verified partial work at the exact nextCursor event boundary (offset:0), so large histories resume next run.', agent: true,
    input: z.object({ message: z.string().min(1).max(200), throughEventId: z.number().int().min(0).optional(), resumeCursor: transcriptCursor.optional() }),
    handler: (args, ctx) => commitIngestion(ctx.runId, args)
  }),
  context_history: op({ description: 'List local Git revisions of a memory record, or page an old version by revision hash. Historical evidence may contain corrected claims.', agent: true, input: z.object({ ref: z.string().min(1), limit: z.number().int().min(1).max(10).default(5), revision: z.string().regex(/^[a-f0-9]{7,40}$/).optional(), offset: z.number().int().min(0).default(0), maxChars: z.number().int().min(100).max(6000).default(4000) }), handler: ({ ref, limit, revision, offset, maxChars }) => contextHistory(ref, limit, revision, offset, maxChars) }),
  context_forget: op({ description: 'Forget a current record and clear derived snapshots. Requires explicit user approval; old Git history and transcripts may retain it.', agent: true, input: z.object({ ref: z.string().min(1) }), handler: ({ ref }, ctx) => { const result = forgetContextRecord(ref); audit(ctx.actor, 'memory', `Forgot [[${result.id}]]`); return result } }),

  memory_snapshot: op({
    description: 'What gets injected into every new session: native memory plus the durable context snapshot, with sizes.',
    agent: true,
    input: none,
    handler: () => {
      const startupChars = buildContext().length
      return {
        roots: roots(),
        inject: [...startupMemoryFiles().map(f => ({ file: f.name, path: f.path, chars: f.content.length })), ...injectedSnapshot()].map(({ file, path, chars }) => ({ file, path, chars, approxTokens: Math.ceil(chars / 4) })),
        startupChars,
        approxStartupTokens: Math.ceil(startupChars / 4),
        note: 'Character-based estimates for Jarvis context only; provider tool schemas, project instructions, conversation history and user input are additional.'
      }
    }
  }),

  transcripts_since: op({
    description: 'Read sourced user/assistant transcript pages. Continue nextCursor until null; the stable event window includes late follow-ups. The reconciler resumes its committed checkpoint automatically.',
    agent: true,
    input: z.object({ hours: z.number().min(1).max(24 * 90).default(26), maxChars: z.number().int().min(500).max(6000).default(5000), cursor: transcriptCursor.optional() }),
    handler: ({ hours, maxChars, cursor }, ctx) => {
      return ctx.runId && runKind(ctx.runId) === 'memory' ? readIngestionPage(ctx.runId, maxChars, cursor) : transcriptPage(hours, maxChars, cursor)
    }
  }),

  memory_backup: op({
    description: 'Snapshot SOUL.md, memories, skills, harness config and the context roots into a dated .tgz (keeps the newest 30). Secrets (.env) are not included.',
    agent: true,
    input: none,
    handler: () => memoryBackup()
  }),

  services_list: op({
    description: 'macOS LaunchAgents related to the harness (Hermes gateway, BlueBubbles, Mac Mini Jarvis). all=true lists every user agent.',
    agent: true,
    input: z.object({ all: z.boolean().optional() }),
    handler: ({ all }) => listServices(!!all)
  }),

  services_restart: op({
    description: 'Restart a LaunchAgent by label (launchctl kickstart -k).',
    agent: true,
    input: z.object({ label: z.string() }),
    handler: async ({ label }, ctx) => {
      const s = await serviceAction(label, 'restart')
      audit(ctx.actor, 'system', `Restarted service ${label}`)
      return s
    }
  }),

  services_start: op({
    description: 'Load and start a LaunchAgent by label.',
    agent: true,
    input: z.object({ label: z.string() }),
    handler: async ({ label }, ctx) => {
      const s = await serviceAction(label, 'start')
      audit(ctx.actor, 'system', `Started service ${label}`)
      return s
    }
  }),

  services_stop: op({
    description: 'Unload a LaunchAgent by label until next login.',
    agent: true,
    input: z.object({ label: z.string() }),
    handler: async ({ label }, ctx) => {
      const s = await serviceAction(label, 'stop')
      audit(ctx.actor, 'system', `Stopped service ${label}`)
      return s
    }
  }),

  services_disable: op({
    description: 'Stop a LaunchAgent and keep it from starting at login.',
    agent: true,
    input: z.object({ label: z.string() }),
    handler: async ({ label }, ctx) => {
      const s = await serviceAction(label, 'disable')
      audit(ctx.actor, 'system', `Disabled service ${label}`)
      return s
    }
  }),

  services_enable: op({
    description: 'Re-enable and load a disabled LaunchAgent.',
    agent: true,
    input: z.object({ label: z.string() }),
    handler: async ({ label }, ctx) => {
      const s = await serviceAction(label, 'enable')
      audit(ctx.actor, 'system', `Enabled service ${label}`)
      return s
    }
  }),

  terminal_open: op({
    description: 'Open a persistent terminal (a real login shell with a TTY) that stays open across runs. Use it for long-running processes (servers, watchers, builds), interactive programs (ssh, REPLs, prompts) or anything you want to check on later. Optionally runs a first command. Returns the terminal id, a cursor and the first output.',
    agent: true,
    input: z.object({ name: z.string().max(40).optional(), cwd: z.string().optional(), command: z.string().optional(), waitMs: z.number().int().min(0).max(120_000).optional() }),
    handler: async (a, ctx) => {
      const { openTerminal } = await import('./terminal')
      const t = await openTerminal(a)
      audit(ctx.actor, 'terminal', `Opened terminal ${t.name}${a.command ? `: ${a.command.slice(0, 200)}` : ''}`)
      return t
    }
  }),

  terminal_send: op({
    description: 'Type into a terminal (by id or name) and return the new output. input is followed by Enter unless enter=false; keys sends special keys in order (ctrl-c, ctrl-d, ctrl-z, enter, tab, esc, up, down, left, right, backspace). Waits up to waitMs (default 2000, max 120000) or until the output matches the regex `until`, or stops early once output goes quiet.',
    agent: true,
    input: z.object({ id: z.string(), input: z.string().optional(), keys: z.array(z.string()).optional(), enter: z.boolean().optional(), waitMs: z.number().int().min(0).max(120_000).optional(), until: z.string().optional() }),
    handler: async ({ id, ...a }, ctx) => {
      const { sendToTerminal } = await import('./terminal')
      if (a.input) audit(ctx.actor, 'terminal', `Terminal ${id}: ${a.input.slice(0, 200)}`)
      return sendToTerminal(id, a)
    }
  }),

  terminal_read: op({
    description: 'Read a terminal\'s output. Pass since=<cursor from a previous call> to get only what is new; waitMs waits for new output. Output has escape codes removed unless raw=true.',
    agent: true,
    input: z.object({ id: z.string(), since: z.number().int().min(0).optional(), maxChars: z.number().int().min(100).max(100_000).optional(), waitMs: z.number().int().min(0).max(120_000).optional(), raw: z.boolean().optional() }),
    handler: async ({ id, ...a }) => (await import('./terminal')).readTerminal(id, a)
  }),

  terminal_list: op({
    description: 'List persistent terminals: id, name, cwd, whether still running, exit code and output cursor.',
    agent: true,
    input: none,
    handler: async () => (await import('./terminal')).listTerminals()
  }),

  terminal_close: op({
    description: 'Close a terminal (hangs up its shell and everything started in it). Closing an exited terminal removes it from the list.',
    agent: true,
    input: z.object({ id: z.string() }),
    handler: async ({ id }, ctx) => {
      const { closeTerminal } = await import('./terminal')
      const t = closeTerminal(id)
      audit(ctx.actor, 'terminal', `Closed terminal ${t.name}`)
      return t
    }
  }),

  app_restart: op({
    description: 'Quit and reopen a macOS app by name, e.g. "BlueBubbles".',
    agent: true,
    input: z.object({ name: z.string() }),
    handler: async ({ name }, ctx) => {
      const r = await restartApp(name)
      audit(ctx.actor, 'system', `Restarted app ${name}`)
      return r
    }
  }),

  harness_restart: op({
    description: 'Restart Mac Mini Jarvis itself (reloads gateways, schedules and code). Active runs, including this one, are stopped; the gateway reconnects in a few seconds.',
    agent: true,
    input: z.object({ reason: z.string().default('requested') }),
    handler: ({ reason }, ctx) => scheduleSelfRestart(reason, ctx.actor)
  }),

  doctor: op({
    description: 'Run Jarvis diagnostics: auth, gateways, startup service, power/auto-login resilience, database, disk, schedules, memory, MCP and updates. fix=true first retries failed gateways, reinstalls the LaunchAgent and runs missed schedules.',
    agent: true,
    input: z.object({ fix: z.boolean().optional() }),
    handler: async ({ fix }, ctx) => {
      const { runDoctor } = await import('./doctor')
      const report = await runDoctor({ fix })
      if (fix) audit(ctx.actor, 'system', `Doctor repair: ${report.summary}`)
      return report
    }
  }),

  update_status: op({
    description: 'Mac Mini Jarvis self-update status: installed commit, commits waiting on origin, and build progress.',
    agent: true,
    input: none,
    handler: () => getUpdateStatus()
  }),

  update_check: op({
    description: 'Fetch the source repo and report whether a newer Mac Mini Jarvis is available.',
    agent: true,
    input: none,
    handler: () => checkForUpdates()
  }),

  update_apply: op({
    description: 'Queue an independent, durable update job and return its job ID. Finish your reply normally; do not wait or poll for installation in this run. The worker builds while Jarvis stays available, then installs only after all runs and replies finish.',
    agent: true,
    input: none,
    handler: (_args, ctx) => applyUpdate({ actor: ctx.actor, callerRunId: ctx.runId })
  }),

  permissions_status: op({
    description: 'macOS permissions the harness (and therefore every agent, shell and terminal it launches) has: Full Disk Access, Accessibility (UI scripting), Screen Recording (screenshots), login-shell environment.',
    agent: true,
    input: none,
    handler: () => permissionStatus()
  }),

  open_settings_pane: op({
    description: 'Open a System Settings privacy pane.',
    agent: false,
    input: z.object({ pane: z.enum(['fullDiskAccess', 'automation', 'accessibility', 'screenRecording', 'loginItems']) }),
    handler: async ({ pane }) => {
      await shell.openExternal(SETTINGS_PANES[pane])
      return { opened: pane }
    }
  }),

  hermes_cutover: op({
    description: 'Stop and disable Hermes LaunchAgents, then enable imported gateways and schedules.',
    agent: false,
    input: none,
    handler: () => hermesCutover()
  }),

  learning_curate_now: op({
    description: 'Run the memory & skills curation pass now.',
    agent: false,
    input: none,
    handler: () => ({ runId: curate() })
  }),

  auth_status: op({
    description: 'Subscription login status for Claude Code and Codex. API-key billing is never allowed.',
    agent: true,
    input: z.object({ refresh: z.boolean().optional() }),
    handler: ({ refresh }) => authStatus(!!refresh)
  }),

  auth_install_missing: op({
    description: 'Install any missing Claude Code and Codex CLIs for this Mac.',
    agent: false,
    input: none,
    handler: async (_args, ctx) => {
      if (ctx.actor !== 'user' || !isOwner()) throw new UsageError('Only the owner can install CLIs from Settings')
      const installed = await installMissingClis()
      return { installed, auth: await authStatus(true) }
    }
  }),

  audit_list: op({
    description: 'Audit log of changes to safeguards, schedules, gateways, MCP, env, memory, skills and config.',
    agent: true,
    input: z.object({ kind: z.string().optional(), limit: z.number().int().optional() }),
    handler: ({ kind, limit }) => listAudit(kind, limit)
  }),

  rsi_statistics: op({
    description: 'Measured task, review, repair, build and retrieval outcomes grouped by installed commit. Compare samples, durations, tool errors and corrections to choose useful improvements.',
    agent: true, input: z.object({ days: z.number().int().positive().default(14) }),
    handler: ({ days }) => rsiStatistics(days)
  }),

  faults_list: op({
    description: 'Harness faults: crashes and errors in Jarvis itself, deduplicated by fingerprint, with class (code/env/unknown), counts and status.',
    agent: true,
    input: z.object({ status: z.enum(['open', 'repairing', 'shipped', 'failed', 'ignored']).optional(), cls: z.enum(['code', 'env', 'unknown']).optional(), limit: z.number().int().min(1).max(200).optional() }),
    handler: (args) => {
      if (!isOwner()) throw new UsageError('Harness faults are only available to the owner’s agent')
      return listFaults(args).map(({ sample, ...f }) => ({ ...f, sample: sample.slice(0, 800) }))
    }
  }),

  faults_set_status: op({
    description: 'Mark a harness fault ignored (not a bug, or accepted) or reopen it.',
    agent: true,
    input: z.object({ fingerprint: z.string().min(1), status: z.enum(['open', 'ignored']), note: z.string().max(500).optional() }),
    handler: ({ fingerprint, status, note }, ctx) => {
      if (!isOwner()) throw new UsageError('Harness faults are only available to the owner’s agent')
      // Reopening grants a fresh attempt budget; otherwise a fault that exhausted maxAttempts is open but never due.
      const fault = updateFault(fingerprint, { status, nextAttemptAt: 0, ...(status === 'open' ? { attempts: 0 } : {}), ...(note ? { note } : {}) })
      if (!fault) throw new UsageError(`No fault ${fingerprint}`)
      audit(ctx.actor, 'faults', `Marked fault ${fingerprint} ${status}`)
      return fault
    }
  }),

  harness_report_defect: op({
    description: 'Report a defect in Jarvis itself (a harness operation that crashed, returned wrong data or forced a workaround) to the fault ledger. Classify implementation size with assessment: files, components, estimatedMinutes, reason, validation and priority. Local one-off fixes are small; multi-component changes are large. Not for agent mistakes or outside outages.',
    agent: true,
    input: z.object({ title: z.string().min(8).max(200), details: z.string().min(1).max(4000), runId: z.string().optional(), assessment: assessmentSchema }),
    handler: ({ title, details, runId, assessment }, ctx) => {
      if (!isOwner()) throw new UsageError('Harness faults are only available to the owner’s agent')
      const fault = recordFault({ source: 'reflection', error: { name: 'Defect', message: title }, assessment: assessScope(assessment), context: `${details}${runId ? `\nEvidence run: ${runId}` : ''}${ctx.runId ? `\nReported by run: ${ctx.runId}` : ''}` })
      if (!fault) throw new Error('Could not record the defect')
      audit(ctx.actor, 'faults', `Reported harness defect ${fault.fingerprint}: ${title}`)
      return { fingerprint: fault.fingerprint, count: fault.count, status: fault.status }
    }
  }),

  improvement_list: op({
    description: 'List self-improvement memory files. Area "harness": lessons and fault pages about Jarvis’s own code; area "skills": lessons behind skill changes.',
    agent: true,
    input: z.object({ area: z.enum(['harness', 'skills']) }),
    handler: ({ area }) => listImprovement(area)
  }),

  improvement_read: op({
    description: 'Read a self-improvement memory file (default LESSONS.md; fault pages are faults/<fingerprint>.md).',
    agent: true,
    input: z.object({ area: z.enum(['harness', 'skills']), file: z.string().max(100).optional() }),
    handler: ({ area, file }) => readImprovement(area, file) || '(empty)'
  }),

  improvement_note: op({
    description: 'Append a dated lesson to self-improvement memory: area "skills" for why a skill or procedure changed, "harness" for how Jarvis itself behaves or broke. Keep it to one or two sentences.',
    agent: true,
    input: z.object({ area: z.enum(['harness', 'skills']), title: z.string().min(4).max(120), text: z.string().min(1).max(2000) }),
    handler: ({ area, title, text }, ctx) => {
      const result = noteLesson(area, title, text)
      audit(ctx.actor, 'memory', `Self-improvement lesson (${area}): ${title}`)
      return result
    }
  }),

  hermes_detect: op({
    description: 'Find Hermes installations on this Mac.',
    agent: false,
    input: none,
    handler: () => detectHermes()
  }),

  hermes_plan: op({
    description: 'Build a dry-run migration plan from a Hermes home.',
    agent: false,
    input: z.object({ home: z.string() }),
    handler: ({ home }) => planMigration(home)
  }),

  hermes_apply: op({
    description: 'Apply selected migration items.',
    agent: false,
    input: z.object({ home: z.string(), itemIds: z.array(z.string()) }),
    handler: ({ home, itemIds }, ctx) => applyMigration(home, itemIds, ctx.actor)
  })
} satisfies Record<string, Op<z.ZodType>>


export async function invoke(name: string, args: unknown, ctx: OpContext): Promise<unknown> {
  const o = (ops as Record<string, Op<z.ZodType>>)[name]
  if (!o) throw new Error(`Unknown op: ${name}`)
  if (ctx.actor === 'agent' && !o.agent) throw new Error(`${name} is not available to agents`)
  if (ctx.actor === 'agent' && ctx.runId && runKind(ctx.runId) !== 'task' && !(runKind(ctx.runId) === 'memory' ? MEMORY_OPS : REVIEW_OPS).has(name)) throw new Error('This operation is outside the background run’s allowed memory/skill operations')
  if (ctx.actor === 'agent' && contextWrites.has(name) && (!ctx.runId || runKind(ctx.runId) !== 'memory')) throw new Error('Durable memory is maintained by the background reconciler; answering runs cannot write it')
  const parsed = o.input.parse(args ?? {})
  if (!ctx.admin && !isOwner()) assertMemberInput(name, parsed as Record<string, unknown>)
  try {
    return await o.handler(parsed, ctx)
  } catch (err) {
    // Argument errors were rejected above, and a UsageError is the caller's mistake. Anything else a handler throws is a harness fault.
    if (!(err instanceof UsageError)) recordFault({ source: `op:${name}`, error: err, context: `actor ${ctx.actor}${ctx.runId ? `, run ${ctx.runId}` : ''}` })
    throw err
  }
}

export function opInfos(): OpInfo[] {
  return Object.entries(ops).map(([name, o]) => ({ name, description: o.description, agent: o.agent }))
}
