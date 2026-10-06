import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isOwner } from '../profile-context'
import type { McpServerEntry } from '@shared/types'
import { codexBinary } from '../auth'
import { cfg, files } from '../config'
import { CodexRpc } from './codex-rpc'
import { BillingViolation, stringifyOutput, systemPrompt, type Provider, type ProviderEvent, type ProviderStartOptions } from './types'

function toCodexMcp(servers: Record<string, McpServerEntry>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, s] of Object.entries(servers)) {
    const key = name.replace(/[^A-Za-z0-9_-]/g, '_')
    if (s.command) out[key] = { command: s.command, args: s.args ?? [], ...(s.env ? { env: s.env } : {}) }
    else if (s.url) out[key] = { url: s.url, ...(s.headers ? { http_headers: s.headers } : {}) }
  }
  return out
}

function itemToEvents(item: Record<string, any>, completed: boolean): ProviderEvent[] {
  switch (item.type) {
    case 'agentMessage': return completed && item.text?.trim() ? [{ type: 'text', text: item.text }] : []
    case 'reasoning': return completed ? [{ type: 'thinking', text: [...(item.summary ?? []), ...(item.content ?? [])].join('\n') }] : []
    case 'commandExecution': return completed
      ? [{ type: 'tool_result', id: item.id, output: (item.aggregatedOutput ?? '').slice(-20_000), isError: item.status === 'failed' || (item.exitCode ?? 0) !== 0 }]
      : [{ type: 'tool_call', id: item.id, name: 'shell', input: { command: item.command } }]
    case 'fileChange': return completed ? [
      { type: 'tool_call', id: item.id, name: 'apply_patch', input: { changes: item.changes } },
      { type: 'tool_result', id: item.id, output: stringifyOutput(item.changes).slice(0, 20_000), isError: item.status === 'failed' }
    ] : []
    case 'mcpToolCall': return completed
      ? [{ type: 'tool_result', id: item.id, output: (item.error?.message ?? stringifyOutput(item.result?.content ?? '')).slice(0, 20_000), isError: item.status === 'failed' }]
      : [{ type: 'tool_call', id: item.id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments }]
    case 'webSearch': return completed ? [] : [{ type: 'tool_call', id: item.id, name: 'web_search', input: { query: item.query } }]
    default: return []
  }
}

export const codexProvider: Provider = {
  id: 'codex',
  async *run(opts: ProviderStartOptions): AsyncGenerator<ProviderEvent> {
    const bin = codexBinary()
    if (!bin) throw new Error('Codex CLI not found')
    opts.signal.throwIfAborted()
    const rpc = new CodexRpc(bin, opts.env, opts.cwd)
    const sg = files.safeguards.value.codex
    const sandbox = opts.harnessOnly ? 'read-only' : isOwner() ? sg.sandboxMode : 'workspace-write'
    /**
     * With no sandbox (the owner's danger-full-access), Codex asks before commands and edits ("untrusted") and the answer comes
     * from the same safeguards gate as every Claude Code tool call: sudo, rm -rf and force-push rules apply, and edits take file
     * leases. In a sandboxed mode an approval would mean leaving the sandbox, which a safeguard rule must never grant, so those
     * runs keep "never" and the sandbox stays the boundary.
     */
    const approvals = sandbox === 'danger-full-access'
    const decide = (allowed: boolean) => ({ decision: opts.signal.aborted ? 'cancel' : allowed ? 'accept' : 'decline' })
    /**
     * Every path an edit writes, absolute: a relative path would slip past absolute path rules, and an update's move_path is
     * where the content actually lands. Recorded as the notification is read, so an approval that follows always finds them.
     */
    const edits = new Map<string, string[]>()
    const mcpCalls = new Map<string, { server: string; tool: string; input: Record<string, unknown>; threadId: string; turnId: string }>()
    const reportRequest = (method: string, reason: string) => rpc.events.push({ method: 'jarvis/serverRequest', params: { method, reason } })
    rpc.onNotification = (msg) => {
      const item = msg.params?.item
      if (msg.method === 'item/completed') {
        edits.delete(item?.id)
        mcpCalls.delete(item?.id)
        return
      }
      if (msg.method !== 'item/started') return
      if (item?.type === 'mcpToolCall') {
        mcpCalls.set(item.id, { server: item.server, tool: item.tool, input: item.arguments ?? {}, threadId: msg.params.threadId, turnId: msg.params.turnId })
        return
      }
      if (item?.type !== 'fileChange') return
      const changes: { path?: string; kind?: { move_path?: string | null } }[] = item.changes ?? []
      edits.set(item.id, [...new Set(changes.flatMap((ch) => [ch.path, ch.kind?.move_path]).filter((x): x is string => !!x).map((x) => resolve(opts.cwd, x)))])
    }
    // MCP approvals are empty forms tagged by Codex. Ordinary forms and URL flows need user input,
    // and must never be mistaken for permission to execute a tool. Never persist a Codex approval.
    rpc.onRequest = async (method, p) => {
      if (method === 'mcpServer/elicitation/request') {
        const reply = (allow: boolean) => ({ action: opts.signal.aborted ? 'cancel' : allow ? 'accept' : 'decline', content: null, _meta: null })
        if (opts.signal.aborted) return reply(false)
        try {
          const schema = p.requestedSchema
          const meta = p._meta
          const input = meta?.tool_params ?? {}
          if (p.mode !== 'form' || meta?.codex_approval_kind !== 'mcp_tool_call' || meta.codex_requires_user_input ||
              schema?.type !== 'object' || !schema.properties || Object.keys(schema.properties).length || schema.required?.length ||
              !input || typeof input !== 'object' || Array.isArray(input)) {
            reportRequest(method, 'Declined elicitation requiring unsupported user input')
            return reply(false)
          }
          // 0.160 does not include the tool name in approval metadata. Correlate the item/started
          // notification and exact arguments; ambiguous calls fail closed rather than gate the wrong tool.
          const calls = [...mcpCalls.values()].filter(c => c.server === p.serverName && c.threadId === p.threadId &&
            (!p.turnId || c.turnId === p.turnId) && isDeepStrictEqual(c.input, input))
          const tools = new Set(calls.map(c => c.tool))
          if (tools.size !== 1) {
            reportRequest(method, 'Declined MCP approval without an unambiguous active tool call')
            return reply(false)
          }
          const tool = calls[0].tool
          // The harness control socket authenticates the run and gates each operation itself.
          if (p.serverName === 'harness' && opts.mcpServers.harness) return reply(true)
          return reply((await opts.gate(`mcp__${p.serverName}__${tool}`, input, opts.signal)).allow)
        } catch {
          reportRequest(method, 'Declined MCP approval after a safeguards error')
          return reply(false)
        }
      }
      if (method === 'item/permissions/requestApproval') {
        reportRequest(method, 'Declined additional sandbox permissions')
        return { permissions: {}, scope: 'turn' }
      }
      if (method === 'item/tool/requestUserInput') {
        reportRequest(method, 'User input requests are not supported by Jarvis')
        return { answers: {} }
      }
      if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') {
        reportRequest(method, 'Server request is not supported by Jarvis')
        return undefined
      }
      if (!approvals) return decide(false)
      try {
        if (method === 'item/commandExecution/requestApproval') {
          const command = typeof p.command === 'string' ? p.command.trim() : ''
          if ((p.kind ?? 'command') !== 'command' || !command || p.networkApprovalContext || p.proposedNetworkPolicyAmendments?.length) return decide(false)
          return decide((await opts.gate('Bash', { command, cwd: resolve(opts.cwd, typeof p.cwd === 'string' ? p.cwd : '.') }, opts.signal)).allow)
        }
        const paths = edits.get(p.itemId) ?? []
        if (!paths.length || p.grantRoot) return decide(false)
        for (const file_path of paths) if (!(await opts.gate('Edit', { file_path }, opts.signal)).allow) return decide(false)
        return decide(true)
      } catch {
        return decide(false)
      }
    }
    let threadId: string | null = null
    let turnId: string | null = null
    const onAbort = () => {
      void opts.steering.close()
      if (threadId && turnId) {
        const kill = setTimeout(() => rpc.close(), 3000)
        kill.unref()
        void rpc.request('turn/interrupt', { threadId, turnId }).catch(() => undefined).finally(() => { clearTimeout(kill); rpc.close() })
      } else rpc.close()
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })
    try {
      await rpc.request('initialize', { clientInfo: { name: 'mac_mini_jarvis', title: 'Mac Mini Jarvis', version: '0.1.0' } })
      rpc.notify('initialized', {})
      const auth = await rpc.request('account/read', { refreshToken: false })
      if (auth.account?.type !== 'chatgpt') throw new BillingViolation('Codex app-server requires a ChatGPT subscription login')
      const limits = await rpc.request('account/rateLimits/read', {}).catch(() => null)
      if (limits) yield { type: 'system', data: { rateLimits: limits } }
      const c = cfg().providers.codex
      const model = opts.model || undefined
      const thread = await rpc.request(opts.resume ? (opts.fork ? 'thread/fork' : 'thread/resume') : 'thread/start', {
        ...(opts.resume ? { threadId: opts.resume } : {}),
        // Replaces Codex's built-in coding-agent instructions with Jarvis's own prompt.
        baseInstructions: systemPrompt(opts.context, opts.cwd, cfg().timezone),
        model, modelProvider: 'openai', cwd: opts.cwd, approvalPolicy: approvals ? 'untrusted' : 'never', sandbox,
        config: { mcp_servers: toCodexMcp(opts.mcpServers), 'sandbox_workspace_write.network_access': opts.harnessOnly ? false : sg.networkAccess, ...(!isOwner() || opts.harnessOnly ? { 'features.shell_tool': false, 'features.unified_exec': false, 'features.apps': false, web_search: opts.harnessOnly ? 'disabled' : 'live' } : {}) }
      })
      threadId = thread.thread.id
      yield { type: 'session', sessionId: threadId! }
      yield { type: 'system', data: { provider: 'codex', model: model ?? 'default', sandbox, approvals: approvals ? 'safeguards' : 'none (sandboxed)', steering: true } }
      const turn = await rpc.request('turn/start', {
        threadId, input: [{ type: 'text', text: opts.prompt }], effort: opts.effort ?? c.reasoningEffort, ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {})
      })
      turnId = turn.turn.id
      opts.steering.register(async (message) => {
        opts.signal.throwIfAborted()
        await rpc.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text: message }] })
      })
      let last = ''
      let base: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | undefined
      for await (const ev of rpc.events) {
        const p = ev.params
        // Child-agent notifications share this connection; only render the requested thread/turn.
        if (p.threadId && p.threadId !== threadId) continue
        if (p.turnId && p.turnId !== turnId) continue
        switch (ev.method) {
          case 'item/agentMessage/delta': yield { type: 'delta', text: p.delta }; break
          case 'item/started': yield* itemToEvents(p.item, false); break
          case 'item/completed':
            if (p.item.type === 'agentMessage') last = p.item.text
            yield* itemToEvents(p.item, true)
            break
          case 'thread/tokenUsage/updated': {
            // `total` spans the whole (possibly resumed) thread and `last` is one call: report this run's share, plus the context size.
            const { total, last: call } = p.tokenUsage
            base ??= { inputTokens: total.inputTokens - call.inputTokens, outputTokens: total.outputTokens - call.outputTokens, cachedInputTokens: total.cachedInputTokens - call.cachedInputTokens }
            yield { type: 'usage', usage: { inputTokens: total.inputTokens - base.inputTokens, outputTokens: total.outputTokens - base.outputTokens, cachedInputTokens: total.cachedInputTokens - base.cachedInputTokens, contextTokens: call.inputTokens } }
            break
          }
          case 'jarvis/serverRequest': yield { type: 'system', data: { codexServerRequest: p.method, message: p.reason } }; break
          case 'account/rateLimits/updated': yield { type: 'system', data: { rateLimits: p } }; break
          case 'error': yield { type: 'system', data: { error: p.error, willRetry: p.willRetry } }; break
          case 'turn/completed':
            if (p.turn.id !== turnId) break
            await opts.steering.close()
            yield { type: 'result', text: last, isError: p.turn.status !== 'completed' && !opts.signal.aborted, error: p.turn.error?.message ?? (p.turn.status === 'interrupted' ? 'Turn interrupted' : undefined) }
            return
        }
      }
      if (!opts.signal.aborted) throw new Error('Codex app-server stopped before the turn completed')
    } finally {
      void opts.steering.close()
      opts.signal.removeEventListener('abort', onAbort)
      rpc.close()
    }
  }
}
