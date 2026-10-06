import type { Effort, ModelOption, ProviderId } from '@shared/types'
import { familyTitle, followsLatest } from '@shared/model-family'
import { cfg } from './config'
import { kvGet, kvSet } from './db'
import { listModels, pickModel } from './models'

/** The agent and model a chat uses until it is switched again or set back to the default. Stored per profile. */
export interface ChatModel { provider: ProviderId; model?: string; effort?: Effort }

const EFFORTS: Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const PROVIDERS: Record<string, ProviderId> = { claude: 'claude', codex: 'codex' }
const NAMES: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex' }
const prefKey = (conversationKey: string) => `chat:model:${conversationKey}`

/** Never throws: an unreadable preference must not stop the message from reaching the agent. */
export function chatModel(conversationKey: string): ChatModel | null {
  try { return kvGet<ChatModel>(prefKey(conversationKey)) ?? null } catch { return null }
}

/** A new thread (NEW) keeps the chat's switch. */
export function copyChatModel(from: string, to: string): void {
  const pref = chatModel(from)
  if (pref) kvSet(prefKey(to), pref)
}

export type ModelCommand =
  | { kind: 'show' }
  | { kind: 'list' }
  | { kind: 'default' }
  | { kind: 'set'; provider: ProviderId; model?: string; effort?: Effort }

/**
 * Bare words count only in capitals, like STOP and NEW, so ordinary sentences ("claude is great") still reach the agent:
 *   CLAUDE · CODEX                    switch agent, using its default model
 *   CLAUDE OPUS · CODEX SOL [HIGH]    a model line (always its newest release), optionally with an effort
 *   MODEL · MODELS · DEFAULT          show this chat's choice · list choices · back to Settings
 * Slash forms accept any case and exact ids, which stay pinned: /model codex gpt-6.1-sol high, /claude opus, /models.
 */
export function parseModelCommand(text: string): ModelCommand | null {
  const t = text.trim().replace(/[.!]+$/, '')
  if (t === 'MODEL' || /^[/!]model$/i.test(t)) return { kind: 'show' }
  if (t === 'MODELS' || /^[/!]models$/i.test(t)) return { kind: 'list' }
  if (t === 'DEFAULT' || t === 'MODEL DEFAULT' || /^[/!]model\s+(?:default|reset)$/i.test(t)) return { kind: 'default' }
  const slash = /^[/!](?:model\s+)?(claude|codex)(?:\s+(\S+))?(?:\s+(\S+))?$/i.exec(t)
  const caps = /^(CLAUDE|CODEX)(?:\s+([A-Z][A-Z0-9.[\]-]*))?(?:\s+([A-Z]+))?$/.exec(t)
  const m = slash ?? caps
  if (!m) return null
  const provider = PROVIDERS[m[1].toLowerCase()]
  let model: string | undefined = m[2]?.toLowerCase()
  let effort: string | undefined = m[3]?.toLowerCase()
  // "CLAUDE HIGH": an effort word alone keeps the default model.
  if (model && !effort && EFFORTS.includes(model as Effort)) { effort = model; model = undefined }
  if (effort && !EFFORTS.includes(effort as Effort)) return null
  return { kind: 'set', provider, ...(model ? { model } : {}), ...(effort ? { effort: effort as Effort } : {}) }
}

/**
 * A switch in front of a message: "CLAUDE OPUS do a bug bash", "CODEX\n\nmake me a doc". Capitalized words after the agent
 * name count only while they name one of its model lines or an effort, so "CLAUDE OK, why?" keeps "OK," in the message.
 */
export async function splitModelPrefix(text: string): Promise<{ command: ModelCommand; prompt: string } | null> {
  const head = /^(CLAUDE|CODEX)(?:[:,]|\s)+(?=\S)/.exec(text.trim())
  if (!head) return null
  const provider = PROVIDERS[head[1].toLowerCase()]
  let rest = text.trim().slice(head[0].length)
  let model: string | undefined
  let effort: Effort | undefined
  let ids: Set<string> | undefined
  for (let word; !effort && (word = /^([A-Z][A-Z0-9.[\]-]*)(?:(?:[:,]|\s)+(?=\S)|[:,]?$)/.exec(rest));) {
    const w = word[1].toLowerCase()
    if (EFFORTS.includes(w as Effort)) effort = w as Effort
    else if (!model && (ids ??= new Set((await listModels(provider)).models.map((m) => m.id))).has(w)) model = w
    else break
    rest = rest.slice(word[0].length)
  }
  // Nothing left to run: that is a plain switch, which parseModelCommand answers.
  return rest ? { command: { kind: 'set', provider, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, prompt: rest } : null
}

/** "Opus · latest (now claude-opus-5-5)" or the pinned id. */
function describe(provider: ProviderId, ref: string | undefined, models: ModelOption[]): string {
  if (!ref) {
    const fallback = cfg().providers[provider].model
    return fallback ? `${describe(provider, fallback, models)} (the default from Settings)` : 'its default model'
  }
  if (!followsLatest(ref)) return `${ref} (pinned)`
  const now = pickModel(ref, models)
  return `${familyTitle(ref)}, always the newest${now !== ref ? ` (now ${now})` : ''}`
}

function choices(models: ModelOption[]): string {
  const lines = models.filter((m) => m.tracksLatest).map((m) => m.id.toUpperCase())
  return lines.length ? lines.join(', ') : 'none reported yet'
}

const HELP = 'Switch with CLAUDE or CODEX, optionally followed by a model line and an effort (CLAUDE OPUS, CODEX SOL HIGH). MODEL shows this chat\'s choice, DEFAULT goes back to Settings. A model line always uses its newest release; /model codex <exact-id> pins one.'

/** Applies a parsed command to one chat and returns the reply to send. Nothing here starts a model. */
export async function runModelCommand(conversationKey: string, cmd: ModelCommand): Promise<string> {
  return (await applyModelCommand(conversationKey, cmd)).text
}

/** Like runModelCommand, and says whether a switch was saved (a refused model or effort changes nothing). */
export async function applyModelCommand(conversationKey: string, cmd: ModelCommand): Promise<{ text: string; switched: boolean }> {
  if (cmd.kind !== 'set') return { text: await describeCommand(conversationKey, cmd), switched: cmd.kind === 'default' }
  const { models, live } = await listModels(cmd.provider)
  const option = cmd.model ? models.find((m) => m.id === cmd.model) : undefined
  // A pinned exact id may be newer than the list; a model line must exist, or it would never resolve.
  if (cmd.model && followsLatest(cmd.model) && live && !option) return { text: `${NAMES[cmd.provider]} has no "${cmd.model.toUpperCase()}" models on this account. Choices: ${choices(models)}.`, switched: false }
  const efforts = option?.efforts ?? models.find((m) => m.id === pickModel(cfg().providers[cmd.provider].model ?? '', models))?.efforts
  if (cmd.effort && efforts && efforts.length && !efforts.includes(cmd.effort)) return { text: `${option?.label ?? NAMES[cmd.provider]} does not support ${cmd.effort} effort. Supported: ${efforts.join(', ')}.`, switched: false }
  const pref: ChatModel = { provider: cmd.provider, ...(cmd.model ? { model: cmd.model } : {}), ...(cmd.effort ? { effort: cmd.effort } : {}) }
  kvSet(prefKey(conversationKey), pref)
  return { text: `Switched this chat to ${NAMES[cmd.provider]}, ${describe(cmd.provider, cmd.model, models)}${cmd.effort ? `, ${cmd.effort} effort` : ''}. It applies from your next message${cmd.provider !== cfg().defaultProvider || cmd.model ? ' and stays until you switch again or say DEFAULT' : ''}.`, switched: true }
}

async function describeCommand(conversationKey: string, cmd: Exclude<ModelCommand, { kind: 'set' }>): Promise<string> {
  if (cmd.kind === 'default') {
    kvSet(prefKey(conversationKey), null)
    return `This chat is back to the default (${NAMES[cfg().defaultProvider]}, ${describe(cfg().defaultProvider, undefined, (await listModels(cfg().defaultProvider)).models)}).`
  }
  if (cmd.kind === 'list') {
    const [claude, codex] = await Promise.all([listModels('claude'), listModels('codex')])
    return `Claude: ${choices(claude.models)}\nCodex: ${choices(codex.models)}\n\n${HELP}`
  }
  const pref = chatModel(conversationKey)
  const provider = pref?.provider ?? cfg().defaultProvider
  const { models } = await listModels(provider)
  return `This chat uses ${NAMES[provider]}, ${describe(provider, pref?.model, models)}${pref?.effort ? `, ${pref.effort} effort` : ''}${pref ? '' : ' (no switch set; the Settings default)'}.\n\n${HELP}`
}
