import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import {
  CallToolRequestSchema, CompleteRequestSchema, GetPromptRequestSchema, isInitializeRequest, ListPromptsRequestSchema,
  ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListToolsRequestSchema, PromptListChangedNotificationSchema,
  ReadResourceRequestSchema, ResourceListChangedNotificationSchema, ToolListChangedNotificationSchema, type ServerCapabilities
} from '@modelcontextprotocol/sdk/types.js'
import type { McpServerEntry } from '@shared/types'

/**
 * Stdio MCP servers run once inside Jarvis instead of once per agent process. Each run's CLI connects to
 * http://127.0.0.1/mcp/<name>; every connection gets its own MCP session, and all of them forward to the one
 * long-lived server process. A run no longer pays that server's startup (often an `npx` resolve) before its
 * first token. Localhost only, behind a bearer token that lives as long as the app.
 */

/** Tool calls may legitimately run long (a big search, a slow API); the CLI's own timeout still applies. */
const CALL_TIMEOUT_MS = 30 * 60_000
/** A server nobody has called for this long is stopped; the next call starts it again. */
const IDLE_MS = Number(process.env.JARVIS_MCP_SHARE_IDLE_MS ?? 60 * 60_000)
const MAX_BODY = 10 * 1024 * 1024

interface Session { transport: StreamableHTTPServerTransport; server: Server; seen: number }
/** CLIs rarely close their MCP session on exit; a session unused this long belongs to a finished run. */
const SESSION_TTL_MS = 12 * 3600_000

class Upstream {
  private client: Client | null = null
  private connecting: Promise<Client> | null = null
  private starting: Client | null = null
  private generation = 0
  private idle?: NodeJS.Timeout
  private stderrTail = ''
  readonly sessions = new Map<string, Session>()

  constructor(readonly name: string, private entry: McpServerEntry, private env: Record<string, string>, private cwd: string) {}

  get running(): boolean { return !!this.client }

  ensure(): Promise<Client> {
    this.touch()
    if (this.client) return Promise.resolve(this.client)
    return (this.connecting ??= this.connect().finally(() => { this.connecting = null }))
  }

  private async connect(): Promise<Client> {
    const generation = this.generation
    this.stderrTail = ''
    const transport = new StdioClientTransport({
      command: this.entry.command!, args: this.entry.args ?? [], env: { ...this.env, ...this.entry.env }, cwd: this.cwd, stderr: 'pipe'
    })
    transport.stderr?.on('data', (chunk: Buffer) => { this.stderrTail = (this.stderrTail + chunk.toString()).slice(-1000) })
    const client = new Client({ name: 'mac-mini-jarvis', version: '0.1.0' }, { capabilities: {} })
    this.starting = client
    client.onclose = () => { if (this.client === client) this.client = null }
    const forward = (send: (s: Server) => Promise<void>) => () => {
      for (const { server } of this.sessions.values()) void send(server).catch(() => undefined)
    }
    client.setNotificationHandler(ToolListChangedNotificationSchema, forward((s) => s.sendToolListChanged()))
    client.setNotificationHandler(ResourceListChangedNotificationSchema, forward((s) => s.sendResourceListChanged()))
    client.setNotificationHandler(PromptListChangedNotificationSchema, forward((s) => s.sendPromptListChanged()))
    try {
      await client.connect(transport, { timeout: 60_000 })
      // The SDK dispatches notifications in a microtask but handles responses immediately.
      // Preserve a microtask boundary between stdio messages so a response in the same
      // chunk cannot delete a progress handler before the preceding notification runs.
      const receive = transport.onmessage!
      let incoming = Promise.resolve()
      transport.onmessage = (message) => {
        incoming = incoming.then(() => receive(message)).catch(err => client.onerror?.(err))
      }
      if (generation !== this.generation) {
        await client.close()
        throw new Error('Server stopped during startup')
      }
    } catch (err) {
      void client.close().catch(() => undefined)
      const tail = this.stderrTail.trim().split('\n').slice(-3).join(' | ')
      throw new Error(`MCP server "${this.name}" did not start: ${(err as Error).message}${tail ? ` (${tail.slice(-400)})` : ''}`)
    } finally {
      if (this.starting === client) this.starting = null
    }
    this.client = client
    return client
  }

  private touch(): void {
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.stop(), IDLE_MS)
    this.idle.unref()
  }

  /** Stops the server process; open sessions stay valid and start it again on their next request. */
  stop(): void {
    this.generation++
    clearTimeout(this.idle)
    const client = this.client
    this.client = null
    void client?.close().catch(() => undefined)
    void this.starting?.close().catch(() => undefined)
  }

  close(): void {
    this.stop()
    for (const { transport } of this.sessions.values()) void transport.close().catch(() => undefined)
    this.sessions.clear()
  }

  /** A per-connection MCP server that mirrors the shared server's capabilities and forwards every request. */
  async session(): Promise<Session> {
    const stale = Date.now() - SESSION_TTL_MS
    for (const [id, s] of this.sessions) if (s.seen < stale) { this.sessions.delete(id); void s.transport.close().catch(() => undefined) }
    const generation = this.generation
    const upstream = await this.ensure()
    if (generation !== this.generation) throw new Error('MCP server stopped during initialization')
    const caps = upstream.getServerCapabilities() ?? {}
    const capabilities: ServerCapabilities = {}
    for (const k of ['tools', 'resources', 'prompts', 'completions'] as const) if (caps[k]) capabilities[k] = caps[k] as never
    // Subscriptions cannot be shared safely across independent client sessions yet.
    if (capabilities.resources) capabilities.resources = { ...capabilities.resources, subscribe: false }
    const server = new Server(upstream.getServerVersion() ?? { name: this.name, version: '0' }, { capabilities, instructions: upstream.getInstructions() })
    const opts = (signal: AbortSignal): RequestOptions => ({ signal, timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true })
    const via = <T>(fn: (c: Client) => Promise<T>) => this.ensure().then(fn)
    if (caps.tools) {
      server.setRequestHandler(ListToolsRequestSchema, (req, x) => via((c) => c.listTools(req.params, opts(x.signal))))
      server.setRequestHandler(CallToolRequestSchema, async (req, x) => {
        let forwarding = Promise.resolve()
        const result = await via((c) => c.callTool(req.params, undefined, {
          ...opts(x.signal),
          ...(x._meta?.progressToken !== undefined ? {
            onprogress: (progress) => {
              forwarding = forwarding.then(() => x.sendNotification({ method: 'notifications/progress', params: { ...progress, progressToken: x._meta!.progressToken! } })).catch(() => undefined)
            }
          } : {})
        }))
        // A result must not close the request stream before its progress has been forwarded.
        await forwarding
        return result
      })
    }
    if (caps.resources) {
      server.setRequestHandler(ListResourcesRequestSchema, (req, x) => via((c) => c.listResources(req.params, opts(x.signal))))
      server.setRequestHandler(ListResourceTemplatesRequestSchema, (req, x) => via((c) => c.listResourceTemplates(req.params, opts(x.signal))))
      server.setRequestHandler(ReadResourceRequestSchema, (req, x) => via((c) => c.readResource(req.params, opts(x.signal))))
    }
    if (caps.prompts) {
      server.setRequestHandler(ListPromptsRequestSchema, (req, x) => via((c) => c.listPrompts(req.params, opts(x.signal))))
      server.setRequestHandler(GetPromptRequestSchema, (req, x) => via((c) => c.getPrompt(req.params, opts(x.signal))))
    }
    if (caps.completions) server.setRequestHandler(CompleteRequestSchema, (req, x) => via((c) => c.complete(req.params, opts(x.signal))))
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { this.sessions.set(id, session) }
    })
    transport.onclose = () => { if (transport.sessionId) this.sessions.delete(transport.sessionId) }
    const session: Session = { transport, server, seen: Date.now() }
    await server.connect(transport)
    return session
  }
}

const upstreams = new Map<string, Upstream>()
const token = randomBytes(32).toString('hex')
let http: HttpServer | null = null
let listening: Promise<string> | null = null
let generation = 0

function authorized(req: IncomingMessage): boolean {
  const got = Buffer.from(req.headers.authorization ?? '')
  const want = Buffer.from(`Bearer ${token}`)
  return got.length === want.length && timingSafeEqual(got, want)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('Request too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined) } catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

function fail(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return void res.end()
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const match = /^\/mcp\/([^/?]+)(?:\?.*)?$/.exec(req.url ?? '')
  const up = match ? upstreams.get(decodeURIComponent(match[1])) : undefined
  if (!authorized(req)) return fail(res, 401, 'Unauthorized')
  if (!up) return fail(res, 404, 'Unknown MCP server')
  const body = req.method === 'POST' ? await readBody(req) : undefined
  const sessionId = req.headers['mcp-session-id']
  let session = typeof sessionId === 'string' ? up.sessions.get(sessionId) : undefined
  if (!session) {
    if (sessionId) return fail(res, 404, 'Session not found')
    if (req.method !== 'POST' || !isInitializeRequest(body)) return fail(res, 400, 'Initialize first')
    session = await up.session()
  }
  session.seen = Date.now()
  await session.transport.handleRequest(req, res, body)
}

function listen(): Promise<string> {
  return (listening ??= new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      handle(req, res).catch((err) => fail(res, 502, err instanceof Error ? err.message : String(err)))
    })
    http = server
    server.once('error', (err) => {
      if (http === server) { http = null; listening = null }
      reject(err)
    })
    server.once('close', () => reject(new Error('MCP sharing stopped during startup')))
    server.listen(0, '127.0.0.1', () => {
      if (http !== server) {
        server.close()
        return reject(new Error('MCP sharing stopped during startup'))
      }
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    })
  }))
}

/** Whether a configured server runs shared: stdio ones only, unless the entry opts out with `shared: false`. */
export function shareable(entry: McpServerEntry): boolean {
  return !!entry.command && entry.type !== 'http' && entry.type !== 'sse' && entry.shared !== false
}

/** The localhost HTTP entry that replaces a stdio server in a run's MCP config. */
export async function sharedEntry(name: string, entry: McpServerEntry, env: Record<string, string>, cwd: string): Promise<McpServerEntry> {
  const started = generation
  const base = await listen()
  if (started !== generation) throw new Error('MCP sharing stopped during startup')
  const fingerprint = createHash('sha256').update(JSON.stringify([entry.command, entry.args, entry.env, env, cwd])).digest('hex')
  // Keep existing runs attached to their original configuration when another run changes it.
  const id = `${name}:${fingerprint}`
  if (!upstreams.has(id)) upstreams.set(id, new Upstream(name, entry, env, cwd))
  return { type: 'http', url: `${base}/mcp/${encodeURIComponent(id)}`, headers: { Authorization: `Bearer ${token}` }, providers: entry.providers }
}

export function mcpShareStatus(): { name: string; running: boolean; sessions: number }[] {
  return [...upstreams.values()].map((u) => ({ name: u.name, running: u.running, sessions: u.sessions.size }))
}

export function stopMcpShare(): void {
  generation++
  for (const up of upstreams.values()) up.close()
  upstreams.clear()
  http?.close()
  http?.closeAllConnections()
  http = null
  listening = null
}
