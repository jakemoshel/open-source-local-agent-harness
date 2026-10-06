import { query, type McpServerConfig, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerEntry } from '@shared/types'
import { claudeBinary } from './auth'
import { agentEnv } from './env'
import { AsyncQueue } from './providers/steering'

export interface GranolaClient {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>
  hasTool(tool: string): Promise<boolean>
  close(): void
}

/** CLI owns OAuth; no prompt is ever enqueued, so there is no model request.
 * mcp_call is a CLI control protocol command, currently exposed by SDK.request
 * at runtime rather than Query's public type. Keep this compatibility seam here.
 */
export async function openGranola(name: string, entry: McpServerEntry, signal: AbortSignal): Promise<GranolaClient> {
  const binary = claudeBinary()
  if (!binary) throw new Error('Direct Granola sync requires Claude Code for its existing MCP OAuth login')
  const server: McpServerConfig = entry.url
    ? { type: entry.type === 'sse' ? 'sse' : 'http', url: entry.url, headers: entry.headers }
    : { type: 'stdio', command: entry.command!, args: entry.args ?? [], env: entry.env }
  const input = new AsyncQueue<SDKUserMessage>()
  const abort = new AbortController()
  const onAbort = () => abort.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) abort.abort()
  const q = query({ prompt: input, options: {
    pathToClaudeCodeExecutable: binary, env: { ...agentEnv(), ENABLE_CLAUDEAI_MCP_SERVERS: 'false', MAX_MCP_OUTPUT_TOKENS: '1000000' },
    settingSources: [], strictMcpConfig: true, mcpServers: { [name]: server },
    systemPrompt: '', abortController: abort, persistSession: false
  } })
  const close = () => { signal.removeEventListener('abort', onAbort); abort.abort(); q.close(); input.end() }
  try {
    await q.initializationResult()
    const control = q as unknown as { request(r: Record<string, unknown>, options?: { signal: AbortSignal }): Promise<{ response: unknown }> }
    if (typeof control.request !== 'function') throw new Error('Claude Code SDK does not support direct MCP calls; update Claude Code and Jarvis')
    const wireName = name.replace(/[^a-zA-Z0-9_-]/g, '_')
    return {
      async call(tool, args) {
        if (!['list_meetings', 'get_meetings', 'get_meeting_transcript'].includes(tool)) throw new Error('Unsupported Granola sync tool')
        signal.throwIfAborted()
        const reply = await control.request({ subtype: 'mcp_call', tool: `mcp__${wireName}__${tool}`, arguments: args }, { signal: abort.signal })
        return reply.response
      },
      async hasTool(tool) {
        const servers = await q.mcpServerStatus()
        const status = servers.find(s => s.name === name)
        if (status?.status !== 'connected') throw new Error(`Granola connection is ${status?.status ?? 'unavailable'}; reconnect in Claude Code /mcp`)
        return !!status.tools?.some(t => t.name === tool || t.name === `mcp__${wireName}__${tool}`)
      },
      close
    }
  } catch (error) { close(); throw error }
}
