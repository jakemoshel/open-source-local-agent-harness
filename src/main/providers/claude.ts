import { isOwner } from '../profile-context'
import { createSdkMcpServer, query, tool, type HookCallback, type McpServerConfig, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { AsyncQueue } from './steering'
import { z } from 'zod'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import type { ClaudeEffort, McpServerEntry } from '@shared/types'
import { claudeBinary } from '../auth'
import { cfg, files } from '../config'
import { HARNESS_TOOL_DEFS, runHarnessTool } from '../harness-tools'
import { BillingViolation, stringifyOutput, systemPrompt, type Provider, type ProviderEvent, type ProviderStartOptions } from './types'

const CLAUDE_EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max'])

const SUBSCRIPTION_KEY_SOURCES = new Set(['none', 'oauth'])
/** After a turn ends with a follow-up still unaccounted for, wait this long for the next turn to start before finishing. */
const FOLLOW_UP_IDLE_MS = Number(process.env.JARVIS_FOLLOW_UP_IDLE_MS ?? 45_000)
const IDLE = Symbol('idle')

function raceIdle<T>(p: Promise<T>, ms: number): Promise<T | typeof IDLE> {
  let t: NodeJS.Timeout | undefined
  return Promise.race([p, new Promise<typeof IDLE>((r) => (t = setTimeout(() => r(IDLE), ms)))]).finally(() => clearTimeout(t))
}

function toSdkMcp(servers: Record<string, McpServerEntry>): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  for (const [name, s] of Object.entries(servers)) {
    if (s.url && (s.type === 'http' || s.type === 'sse' || !s.command)) {
      out[name] = { type: s.type === 'sse' ? 'sse' : 'http', url: s.url, headers: s.headers }
    } else if (s.command) {
      out[name] = { type: 'stdio', command: s.command, args: s.args ?? [], env: s.env }
    }
  }
  return out
}

function isHome(dir: string): boolean {
  try {
    return realpathSync(dir) === realpathSync(homedir())
  } catch {
    return false
  }
}

function harnessServer(runId: string): McpServerConfig {
  const exec = (name: string) => async (args: Record<string, unknown>) => {
    try {
      return { content: [{ type: 'text' as const, text: await runHarnessTool(name, args, runId) }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true }
    }
  }
  return createSdkMcpServer({
    name: 'harness',
    version: '0.1.0',
    tools: [
      tool(HARNESS_TOOL_DEFS[0].name, HARNESS_TOOL_DEFS[0].description, { op: z.string().optional(), category: z.string().optional(), query: z.string().optional(), limit: z.number().int().min(1).max(5).optional() }, exec(HARNESS_TOOL_DEFS[0].name)),
      tool(HARNESS_TOOL_DEFS[1].name, HARNESS_TOOL_DEFS[1].description, { op: z.string(), args: z.looseObject({}).optional(), resultId: z.string().optional(), offset: z.number().int().min(0).optional() }, exec(HARNESS_TOOL_DEFS[1].name))
    ]
  })
}

/** One short-lived Claude Code process, closed when the job ends. `next` keeps a read raced against the follow-up idle timer. */
interface Session {
  sessionId: string
  q: Query
  it: AsyncIterator<SDKMessage>
  input: AsyncQueue<SDKUserMessage>
  abort: AbortController
  next: Promise<IteratorResult<SDKMessage>> | null
}

const pull = (s: Session) => (s.next ??= s.it.next())

export const claudeProvider: Provider = {
  id: 'claude',
  async *run(opts: ProviderStartOptions): AsyncGenerator<ProviderEvent> {
    const c = cfg().providers.claude
    const settingSources: Options['settingSources'] = isOwner() && c.loadProjectSettings && !isHome(opts.cwd) ? ['project', 'local'] : []
    const sdkMcp = toSdkMcp(opts.mcpServers)
    const prompt = systemPrompt(opts.context, opts.cwd, cfg().timezone)
    const model = opts.model || undefined
    // Codex-only levels (minimal, ultra) fall back to the configured Claude effort.
    const effort = (opts.effort && CLAUDE_EFFORTS.has(opts.effort) ? opts.effort as ClaudeEffort : undefined) ?? c.effort
    const approvalTimeout = files.safeguards.value.approvalTimeoutSec + 60

    const abort = new AbortController()
    const preToolUse: HookCallback = async (input, _id, { signal }) => {
      if (input.hook_event_name !== 'PreToolUse') return {}
      const decision = await opts.gate(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, signal)
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision.allow ? 'allow' : 'deny',
          permissionDecisionReason: decision.allow ? 'Allowed by Mac Mini Jarvis safeguards' : decision.message
        }
      }
    }
    const options: Options = {
      cwd: opts.cwd,
      model,
      effort,
      resume: opts.resume ?? undefined,
      forkSession: opts.fork && opts.resume ? true : undefined,
      abortController: abort,
      env: opts.env,
      pathToClaudeCodeExecutable: claudeBinary() ?? undefined,
      // Jarvis's own prompt only: the claude_code preset added ~15k tokens of coding-agent instructions to every run.
      systemPrompt: prompt,
      settingSources,
      mcpServers: { ...sdkMcp, harness: harnessServer(opts.runId) },
      strictMcpConfig: true,
      ...(opts.outputSchema ? { outputFormat: { type: 'json_schema' as const, schema: opts.outputSchema } } : {}),
      ...(opts.harnessOnly ? { tools: [] } : {}),
      ...(!isOwner() ? { disallowedTools: ['Bash', 'Agent', 'Task', 'NotebookEdit'] } : {}),
      includePartialMessages: true,
      permissionMode: 'default',
      hooks: { PreToolUse: [{ hooks: [preToolUse], timeout: approvalTimeout }] },
      canUseTool: async () => ({ behavior: 'allow' })
    }
    const input = new AsyncQueue<SDKUserMessage>()
    const q = query({ prompt: input, options })
    const s: Session = { sessionId: opts.resume && !opts.fork ? opts.resume : '', q, it: q[Symbol.asyncIterator](), input, abort, next: null }
    const onAbort = () => s.abort.abort()
    opts.signal.addEventListener('abort', onAbort, { once: true })
    if (opts.signal.aborted) onAbort()
    try {
      yield* turn(s)
    } finally {
      void opts.steering.close()
      opts.signal.removeEventListener('abort', onAbort)
      s.input.end()
      s.q.close()
    }

    async function* turn(s: Session): AsyncGenerator<ProviderEvent> {
      const pending = new Set<string>()
      const enqueue = (text: string) => {
        const uuid = randomUUID()
        pending.add(uuid)
        s.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: s.sessionId, uuid, priority: 'now' })
      }
      enqueue(opts.prompt)
      opts.steering.register(async (text) => {
        if (s.abort.signal.aborted) throw new Error('Run was cancelled')
        enqueue(text)
      })
      // A result that arrived while a follow-up was still unaccounted for; released if no further turn starts.
      let held: ProviderEvent | null = null
      let assistantError: string | undefined
      /** Prompt size of the latest top-level model call: what the next turn has to carry. */
      let contextTokens: number | undefined
      let announced = false
      const announce = function* (data: Record<string, unknown>): Generator<ProviderEvent> {
        if (announced) return
        announced = true
        yield { type: 'session', sessionId: s.sessionId }
        yield { type: 'system', data }
      }
      for (;;) {
        const step: IteratorResult<SDKMessage> | typeof IDLE = held ? await raceIdle(pull(s), FOLLOW_UP_IDLE_MS) : await pull(s)
        if (step === IDLE) break
        s.next = null
        if (step.done) break
        const msg: SDKMessage = step.value
        // Anything after a held result means the SDK started another turn for the follow-up.
        if (held && msg.type !== 'result') held = null
        if (msg.type === 'system' && msg.subtype === 'init') {
          if (!SUBSCRIPTION_KEY_SOURCES.has(msg.apiKeySource)) {
            s.abort.abort()
            throw new BillingViolation(`Claude Code is using "${msg.apiKeySource}" credentials, which bill the API. Only a Claude subscription login is allowed.`)
          }
          s.sessionId = msg.session_id
          yield* announce({ model: msg.model, tools: msg.tools.length, mcpTools: msg.tools.filter((t) => t.startsWith('mcp__')), mcp: msg.mcp_servers, cwd: msg.cwd, version: msg.claude_code_version, auth: msg.apiKeySource })
          continue
        }
        switch (msg.type) {
          case 'stream_event': {
            const ev = msg.event
            if (msg.parent_tool_use_id === null && ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') yield { type: 'delta', text: ev.delta.text }
            break
          }
          case 'assistant': {
            const u = msg.parent_tool_use_id === null ? msg.message.usage : undefined
            if (u) contextTokens = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
            if (msg.error) assistantError = [msg.error, ...msg.message.content.filter((b) => b.type === 'text').map((b) => b.text)].join(': ')
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text.trim()) yield { type: 'text', text: block.text }
              else if (block.type === 'thinking' && block.thinking) yield { type: 'thinking', text: block.thinking }
              else if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
                yield { type: 'tool_call', id: block.id, name: block.name, input: block.input }
              }
            }
            break
          }
          case 'user': {
            const content = msg.message.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (typeof block === 'object' && block.type === 'tool_result') {
                  yield { type: 'tool_result', id: block.tool_use_id, output: stringifyOutput(block.content).slice(0, 20_000), isError: !!block.is_error }
                }
              }
            }
            break
          }
          case 'result': {
            if (msg.session_id) s.sessionId = msg.session_id
            const consumed = msg.user_message_uuids ?? (msg.user_message_uuid ? [msg.user_message_uuid] : [])
            if (consumed.length) for (const id of consumed) pending.delete(id)
            else pending.delete(pending.values().next().value!)
            const usage = msg.usage
            yield {
              type: 'usage',
              usage: {
                inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
                outputTokens: usage.output_tokens,
                cachedInputTokens: usage.cache_read_input_tokens ?? 0,
                ...(contextTokens ? { contextTokens } : {}),
                turns: msg.num_turns
              }
            }
            const ok = msg.subtype === 'success' && !msg.is_error
            const result: ProviderEvent = msg.subtype === 'success'
              ? { type: 'result', text: opts.outputSchema && msg.structured_output !== undefined ? JSON.stringify(msg.structured_output) : msg.result, isError: msg.is_error, error: msg.is_error ? [assistantError, msg.result].filter(Boolean).join(': ') : undefined }
              : { type: 'result', text: '', isError: true, error: [msg.subtype, ...(msg.errors ?? []), assistantError].filter(Boolean).join(': ') }
            // A steering message can be consumed in this turn or in the following turn.
            // Keep the input stream alive until every accepted prompt has a result.
            if (ok && pending.size) {
              held = result
              break
            }
            await opts.steering.close()
            yield result
            return
          }
        }
      }
      // The stream ended, or no further turn started for a follow-up the SDK folded into the last one.
      await opts.steering.close()
      if (held) yield held
    }
  }
}
