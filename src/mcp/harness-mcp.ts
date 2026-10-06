import { createConnection, type Socket } from 'node:net'
import { createInterface } from 'node:readline'

const SOCKET = process.env.JARVIS_SOCKET ?? ''
const RUN_ID = process.env.JARVIS_RUN_ID
const PROTOCOL = '2025-06-18'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }
const pending = new Map<number, Pending>()
let nextId = 1
let sock: Socket | null = null
/** Concurrent first calls share one connection: a second socket's close would reject the first one's pending calls. */
let connecting: Promise<Socket> | null = null

function connect(): Promise<Socket> {
  if (sock && !sock.destroyed) return Promise.resolve(sock)
  connecting ??= open().finally(() => { connecting = null })
  return connecting
}

function open(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = createConnection(SOCKET)
    let buf = ''
    s.setEncoding('utf8')
    s.on('connect', () => {
      sock = s
      resolve(s)
    })
    s.on('error', (err) => {
      for (const p of pending.values()) p.reject(err)
      pending.clear()
      sock = null
      reject(new Error(`Mac Mini Jarvis is not running (${err.message})`))
    })
    s.on('close', () => {
      sock = null
      for (const p of pending.values()) p.reject(new Error('Jarvis disconnected before replying'))
      pending.clear()
    })
    s.on('data', (chunk) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let msg: { id: number; result?: unknown; error?: string }
        try { msg = JSON.parse(line) } catch { continue }
        const p = pending.get(msg.id)
        if (!p) continue
        pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error))
        else p.resolve(msg.result)
      }
    })
  })
}

async function call(op: string, args?: unknown, tool?: string): Promise<unknown> {
  const s = await connect()
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    s.write(JSON.stringify({ id, op, tool, args, runId: RUN_ID, token: process.env.JARVIS_RUN_TOKEN }) + '\n')
  })
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

async function onRequest(req: { id?: number | string; method: string; params?: Record<string, unknown> }): Promise<void> {
  const reply = (result: unknown): void => {
    if (req.id !== undefined) send({ jsonrpc: '2.0', id: req.id, result })
  }
  const fail = (code: number, message: string): void => {
    if (req.id !== undefined) send({ jsonrpc: '2.0', id: req.id, error: { code, message } })
  }
  switch (req.method) {
    case 'initialize':
      return reply({
        protocolVersion: (req.params?.protocolVersion as string) ?? PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'harness', version: '0.1.0' },
        instructions: 'Inspect and change Mac Mini Jarvis itself. harness_ops lists operations; harness_call runs one.'
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      try {
        return reply({ tools: await call('__tools') })
      } catch (err) {
        return fail(-32603, (err as Error).message)
      }
    case 'tools/call': {
      const name = String(req.params?.name ?? '')
      try {
        const result = await call('__call', req.params?.arguments ?? {}, name)
        return reply({ content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] })
      } catch (err) {
        return reply({ content: [{ type: 'text', text: (err as Error).message }], isError: true })
      }
    }
    default:
      if (req.id !== undefined) fail(-32601, `Method not found: ${req.method}`)
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  try {
    void onRequest(JSON.parse(line))
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  }
})
rl.on('close', () => process.exit(0))
