import { homedir } from 'node:os'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { ModelOption, ProviderId } from '@shared/types'
import { compareVersions, familyTitle, followsLatest, modelFamily, modelVersion } from '@shared/model-family'
import { kvGet, kvSet } from './db'
import { claudeBinary, codexBinary } from './auth'
import { agentEnv } from './env'
import { profileId } from './profile-context'
import { CodexRpc } from './providers/codex-rpc'

/**
 * Models each CLI offers the signed-in account, with the efforts each supports. Asked of the CLIs themselves so the
 * list follows the subscription (and each member's own plan) instead of going stale in code. Nothing is sent to a model.
 */
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const FALLBACK: Record<ProviderId, ModelOption[]> = {
  claude: [
    { id: 'opus', label: 'Opus', description: '', efforts: CLAUDE_EFFORTS, defaultEffort: null, recommended: true },
    { id: 'fable', label: 'Fable', description: '', efforts: CLAUDE_EFFORTS, defaultEffort: null, recommended: false },
    { id: 'sonnet', label: 'Sonnet', description: '', efforts: CLAUDE_EFFORTS, defaultEffort: null, recommended: false },
    { id: 'haiku', label: 'Haiku', description: '', efforts: [], defaultEffort: null, recommended: false }
  ],
  codex: []
}
const TTL_MS = 10 * 60_000
const FAILED_TTL_MS = 30_000
const TIMEOUT_MS = 20_000
const cache = new Map<string, { at: number; ttl: number; value: ModelOption[] }>()
const inFlight = new Map<string, Promise<ModelOption[]>>()
/** The last list a CLI actually reported, kept across restarts so resolving a family never waits on (or fails with) the CLI. */
const lastLive = new Map<string, { at: number; models: ModelOption[] }>()

/**
 * Adds one "latest" option per release line ahead of the exact versions, so a choice can follow new releases:
 * "sol" resolves to gpt-6.2-sol the day it appears. A CLI alias that already means "newest" (Claude's "opus") is that
 * option itself.
 */
export function withFamilies(models: ModelOption[]): ModelOption[] {
  const aliases = models.filter((m) => followsLatest(m.id)).map((m) => ({ ...m, tracksLatest: true }))
  const exact = models.filter((m) => !followsLatest(m.id))
  const lines = new Map<string, ModelOption[]>()
  for (const m of exact) {
    const family = modelFamily(m.id)
    if (followsLatest(family)) lines.set(family, [...(lines.get(family) ?? []), m])
  }
  const families: ModelOption[] = []
  for (const [family, line] of lines) {
    if (aliases.some((a) => a.id === family)) continue
    const newest = [...line].sort((a, b) => compareVersions(modelVersion(b.id), modelVersion(a.id)))[0]
    families.push({ ...newest, id: family, label: `${familyTitle(family)} · latest`, description: `Follows new ${familyTitle(family)} releases; now ${newest.label}.`, recommended: line.some((m) => m.recommended), tracksLatest: true, latest: newest.id })
  }
  return [...aliases, ...families, ...exact]
}

/**
 * The model to hand the CLI for a ref: a family resolves to its newest release, a CLI alias and an exact id pass through.
 * Uses the last reported list immediately and refreshes it in the background when stale, so a run never waits on the CLI
 * except the very first time.
 */
export async function resolveModel(provider: ProviderId, ref: string | null | undefined): Promise<string | undefined> {
  if (!ref || !followsLatest(ref)) return ref ?? undefined
  const key = `${profileId()}:${provider}`
  let known = lastLive.get(key)
  if (!known) {
    try { known = kvGet<{ at: number; models: ModelOption[] }>(`models:last:${provider}`) ?? undefined } catch { known = undefined }
    if (known) lastLive.set(key, known)
  }
  let models = known?.models
  if (!models) models = (await listModels(provider)).models
  else if (Date.now() - known!.at > TTL_MS) void listModels(provider).catch(() => undefined)
  return pickModel(ref, models)
}

export function pickModel(ref: string, models: ModelOption[]): string {
  if (!followsLatest(ref)) return ref
  const option = models.find((m) => m.id === ref)
  if (option) return option.latest ?? ref
  const newest = models.filter((m) => !followsLatest(m.id) && modelFamily(m.id) === ref).sort((a, b) => compareVersions(modelVersion(b.id), modelVersion(a.id)))[0]
  return newest?.id ?? ref
}

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([p, new Promise<T>((_, no) => { timer = setTimeout(() => no(new Error(`${what} timed out`)), TIMEOUT_MS) })]).finally(() => clearTimeout(timer))
}

async function claudeModels(): Promise<ModelOption[]> {
  const bin = claudeBinary()
  if (!bin) throw new Error('Claude Code CLI not installed')
  const abort = new AbortController()
  // An input stream that never yields: the session starts, answers the control request, and never prompts a model.
  async function* idle(): AsyncGenerator<never> { await new Promise((r) => abort.signal.addEventListener('abort', r, { once: true })) }
  const q = query({ prompt: idle(), options: { abortController: abort, pathToClaudeCodeExecutable: bin, env: agentEnv(), cwd: homedir(), settingSources: [], strictMcpConfig: true, mcpServers: {} } })
  try {
    const models = await withTimeout(q.supportedModels(), 'Claude model list')
    // "default" is the CLI's own pick; the dropdown's Default option already means that.
    return models.filter((m) => m.value !== 'default').map((m) => ({
      id: m.value, label: m.displayName || m.value, description: m.description ?? '',
      // No listed levels means the model has no effort setting (Haiku), unless it only says it supports effort.
      efforts: m.supportedEffortLevels ?? (m.supportsEffort ? CLAUDE_EFFORTS : []), defaultEffort: null, recommended: false
    }))
  } finally {
    abort.abort()
  }
}

interface CodexModel { model: string; displayName?: string; description?: string; hidden?: boolean; isDefault?: boolean; defaultReasoningEffort?: string; supportedReasoningEfforts?: { reasoningEffort: string }[] }

async function codexModels(): Promise<ModelOption[]> {
  const bin = codexBinary()
  if (!bin) throw new Error('Codex CLI not installed')
  const rpc = new CodexRpc(bin, agentEnv(), homedir())
  try {
    await withTimeout(rpc.request('initialize', { clientInfo: { name: 'mac_mini_jarvis', title: 'Mac Mini Jarvis', version: '0.1.0' } }), 'Codex start')
    rpc.notify('initialized', {})
    const out: CodexModel[] = []
    let cursor: string | null | undefined
    for (let page = 0; page < 10; page++) {
      const r = await withTimeout(rpc.request('model/list', cursor ? { cursor } : {}), 'Codex model list') as { data?: CodexModel[]; nextCursor?: string | null }
      out.push(...(r.data ?? []))
      cursor = r.nextCursor
      if (!cursor) break
    }
    return out.filter((m) => !m.hidden && m.model).map((m) => ({
      id: m.model, label: m.displayName || m.model, description: m.description ?? '',
      efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort ?? null, recommended: !!m.isDefault
    }))
  } finally {
    rpc.close()
  }
}

export async function listModels(provider: ProviderId, refresh = false): Promise<{ models: ModelOption[]; live: boolean; detail?: string }> {
  const key = `${profileId()}:${provider}`
  const hit = cache.get(key)
  if (!refresh && hit && Date.now() - hit.at < hit.ttl) return { models: hit.value, live: hit.ttl === TTL_MS }
  let running = inFlight.get(key)
  if (!running) {
    running = (provider === 'claude' ? claudeModels() : codexModels()).finally(() => inFlight.delete(key))
    inFlight.set(key, running)
  }
  try {
    const reported = await running
    if (!reported.length) throw new Error('No models reported')
    const models = withFamilies(reported)
    cache.set(key, { at: Date.now(), ttl: TTL_MS, value: models })
    const known = { at: Date.now(), models }
    lastLive.set(key, known)
    try { kvSet(`models:last:${provider}`, known) } catch { /* the database may not be open in a bare CLI check */ }
    return { models, live: true }
  } catch (err) {
    // A signed-out or busy CLI still leaves a usable picker (the last real list, else built-in aliases); retry soon.
    const fallback = lastLive.get(key)?.models ?? FALLBACK[provider]
    cache.set(key, { at: Date.now(), ttl: FAILED_TTL_MS, value: fallback })
    return { models: fallback, live: false, detail: (err as Error).message }
  }
}

/**
 * Resolve a requested default model/effort against the account's model list. A value sets, null clears, undefined keeps.
 * Unknown model ids are allowed (the GUI has Custom…) but noted; an effort the model cannot run is rejected.
 */
export function planModelChange(
  provider: ProviderId,
  current: Record<string, unknown>,
  ask: { model?: string | null; effort?: string | null },
  models: ModelOption[],
  live: boolean
): { model: string | undefined; effort: string | undefined; effortKey: string; notes: string[] } {
  const notes: string[] = []
  const effortKey = provider === 'claude' ? 'effort' : 'reasoningEffort'
  const model = ask.model === undefined ? (current.model as string | undefined) : (ask.model ?? undefined)
  const found = models.find((m) => m.id === model)
  if (ask.model && live && !found) notes.push(`"${ask.model}" is not in the ${provider} model list (${models.map((m) => m.id).join(', ')}); saved anyway as a custom id.`)
  if (ask.effort) {
    if (found && !found.efforts.includes(ask.effort)) throw new Error(`${found.label} does not support effort "${ask.effort}". Supported: ${found.efforts.join(', ') || 'none'}.`)
    if (!found && models.length && !models.some((m) => m.efforts.includes(ask.effort as string))) throw new Error(`No ${provider} model supports effort "${ask.effort}".`)
  }
  let effort = ask.effort === undefined ? (current[effortKey] as string | undefined) : (ask.effort ?? undefined)
  // Switching models can strand the saved effort; drop it rather than fail every run.
  if (ask.effort === undefined && effort && found && !found.efforts.includes(effort)) {
    notes.push(`Cleared effort "${effort}" (${found.label} does not support it).`)
    effort = undefined
  }
  return { model, effort, effortKey, notes }
}
