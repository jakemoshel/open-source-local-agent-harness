import { profileForSender } from '../profiles'
import { withProfile, OWNER_ID } from '../profile-context'
import { execFile } from 'node:child_process'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import { cfg } from '../config'
import { kvGet, kvSet } from '../db'
import { readEnvFile } from '../env'
import { handleInbound } from './commands'
import { authorizedChat, authorizedSender, normalizedPhone, ownerPhone } from './sender-auth'
import { chunk, DeliveryUncertain, plainText, withRetry, type Gateway } from './types'

const run = promisify(execFile)
const CHAT_DB = join(homedir(), 'Library/Messages/chat.db')
const MESSAGE_EVENTS = new Set(['new-message', 'message', 'updated-message'])

const SEND_SCRIPT = `on run argv
  tell application "Messages" to send (item 1 of argv) to chat id (item 2 of argv)
end run`

function decodeAttributedBody(buf: Buffer | null): string | null {
  if (!buf) return null
  const idx = buf.indexOf('NSString')
  if (idx < 0) return null
  let i = idx + 'NSString'.length + 5
  if (i >= buf.length) return null
  let len = buf[i]
  i += 1
  if (len === 0x81) {
    if (i + 2 > buf.length) return null
    len = buf.readUInt16LE(i)
    i += 2
  } else if (len === 0x82) {
    if (i + 3 > buf.length) return null
    len = buf.readUIntLE(i, 3)
    i += 3
  }
  if (i + len > buf.length) return null
  return buf.subarray(i, i + len).toString('utf8')
}

function sameSecret(a: string | null, b: string): boolean {
  if (a === null || !b) return false
  const h = (x: string) => createHash('sha256').update(x).digest()
  return timingSafeEqual(h(a), h(b))
}

const normalizeHandle = (h: string) => h.includes('@') ? h.trim().toLowerCase() : normalizedPhone(h) ?? h

/**
 * One name per 1:1 chat. BlueBubbles reports the same chat as `iMessage;-;`, `SMS;-;` or `any;-;`, with the
 * handle formatted differently, depending on the event and the service the text arrived over. Without this the
 * conversation splits: a follow-up starts a second session, and STOP or NEW misses the run it was meant for.
 */
export function canonicalChat(chatId: string, sender: string): string {
  const direct = /^(?:iMessage|SMS|RCS|any);-;(.+)$/.exec(chatId)
  if (direct) return `any;-;${normalizeHandle(direct[1])}`
  return chatId || `any;-;${normalizeHandle(sender)}`
}

function bbConfig(): { url: string; password: string } {
  const env = readEnvFile()
  return {
    url: (env.BLUEBUBBLES_SERVER_URL || env.BLUEBUBBLES_URL || 'http://localhost:1234').replace(/\/+$/, ''),
    password: env.BLUEBUBBLES_PASSWORD || ''
  }
}

async function bbApi<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  const { url, password } = bbConfig()
  const res = await fetch(`${url}${path}${path.includes('?') ? '&' : '?'}password=${encodeURIComponent(password)}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  })
  const json = (await res.json().catch(() => ({}))) as T & { message?: string }
  if (!res.ok) throw new Error(`BlueBubbles ${method} ${path} → ${res.status} ${json.message ?? ''}`.trim())
  return json
}

export function createIMessage(onChange: () => void): Gateway {
  let db: Database.Database | null = null
  let pollStmt: Database.Statement | null = null
  let timer: NodeJS.Timeout | null = null
  let server: Server | null = null
  let webhookUrl: string | null = null
  let busy = false
  let catchUpTimer: NodeJS.Timeout | null = null
  /** Generation of the running BlueBubbles connection and of the catch-up in flight (0 = none). */
  let generation = 0
  let catchingUp = 0
  const guidCache = new Map<string, string>()
  const CURSOR = 'imessage:bb:lastTs'
  const SEEN = 'imessage:bb:seen'
  const OUTBOX = 'imessage:outbox'
  /** Replies older than this are stale; a late "done" hours later is worse than nothing. */
  const OUTBOX_MAX_AGE = 6 * 3600_000
  let flushing = false
  const CATCH_UP_MAX_AGE = 6 * 3600_000
  /** A lost webhook delays a message by at most this; each tick is one small localhost query. */
  const CATCH_UP_MS = 15_000
  const WEBHOOK_CHECK_TICKS = 20
  const CATCH_UP_OVERLAP = 5 * 60_000
  /** Message GUIDs already answered, kept across restarts: a read receipt or edit for an old message must not answer it again. */
  let seen: Set<string> | null = null
  let catchUpFailures = 0
  let catchUpTicks = 0

  const backend = () => cfg().gateways.imessage.backend

  async function resolveGuid(target: string): Promise<string> {
    // Current Messages uses any for direct chats; stale service GUIDs cause unconfirmed sends.
    if (/^(?:iMessage|SMS|any);-;/.test(target)) return target.replace(/^[^;]+/, 'any')
    if (target.includes(';')) return target
    const cached = guidCache.get(target)
    if (cached) return cached
    try {
      const res = await bbApi<{ data?: { guid?: string; chatIdentifier?: string }[] }>('POST', '/api/v1/chat/query', { limit: 200, offset: 0 })
      const hit = res.data?.find((c) => c.chatIdentifier && normalizeHandle(c.chatIdentifier) === normalizeHandle(target))
      if (hit?.guid) {
        const guid = hit.guid.replace(/^(?:iMessage|SMS);-;/, 'any;-;')
        guidCache.set(target, guid)
        return guid
      }
    } catch {
      return `any;-;${target}`
    }
    // BlueBubbles can't confirm sends to a guessed `iMessage;-;` guid on current macOS: the text goes out but the
    // request hangs until timeout. `any;-;` matches how Messages now names 1:1 chats.
    return `any;-;${target}`
  }

  async function sendText(target: string, text: string): Promise<void> {
    text = plainText(text)
    if (backend() === 'bluebubbles') {
      const chatGuid = await resolveGuid(target)
      let sent = 0
      for (const part of chunk(text.trim(), 4000)) {
        try {
          await bbApi('POST', '/api/v1/message/text', { chatGuid, tempGuid: `temp-${randomUUID()}`, message: part })
        } catch (err) {
          const name = (err as Error)?.name
          // A connection that was never made sent nothing, so a retry (e.g. while BlueBubbles restarts) is safe.
          const code = ((err as Error & { cause?: { code?: string } })?.cause)?.code ?? ''
          const neverConnected = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT)$/.test(code)
          // A timeout means BlueBubbles accepted the send but never confirmed it; after the first bubble a retry
          // would repeat what already went out. Either way, resending duplicates texts.
          if (sent > 0 || name === 'TimeoutError' || name === 'AbortError' || (name === 'TypeError' && !neverConnected) || /→ 5\d\d/.test((err as Error).message)) throw new DeliveryUncertain(`iMessage delivery unconfirmed: ${(err as Error).message}`)
          throw err
        }
        sent++
      }
      return
    }
    const guid = target.includes(';') ? target : `iMessage;-;${target}`
    for (const part of chunk(text, 4000)) await run('/usr/bin/osascript', ['-e', SEND_SCRIPT, part, guid], { timeout: 30_000 })
  }

  function dispatch(sender: string, chatId: string, text: string, messageId: string): void {
    if (!authorizedChat(chatId, sender)) return
    const profile = profileForSender('imessage', sender)
    if (!profile || profile.id !== OWNER_ID) return
    gw.status = { ...gw.status, lastMessageAt: Date.now() }
    onChange()
    const conf = cfg().gateways.imessage
    // The typing indicator wants the chat as BlueBubbles named it; the conversation and replies use one stable name.
    const chat = backend() === 'bluebubbles' ? canonicalChat(chatId, sender) : chatId
    void withProfile(profile.id, () => handleInbound({
      key: `imessage:${chat}`,
      text,
      trigger: 'imessage',
      triggerRef: `${chat}:${messageId}`,
      provider: conf.provider,
      cwd: conf.cwd,
      reply: (t) =>
        withProfile(OWNER_ID, () => withRetry(() => sendText(chat, t))).catch((err) => {
          // Definitely not sent (BlueBubbles down for minutes): keep it and resend once it is back, instead of dropping the reply.
          if (!(err as { noRetry?: boolean }).noRetry && backend() === 'bluebubbles') queueOutbox(chat, t)
          gw.status = { ...gw.status, detail: `Send failed${(err as { noRetry?: boolean }).noRetry ? '' : ' (queued to resend)'}: ${(err as Error).message}` }
          onChange()
        }),
      onStart: () => withProfile(OWNER_ID, () => (backend() === 'bluebubbles' && chatId.includes(';') ? bbApi('POST', `/api/v1/chat/${encodeURIComponent(chatId)}/typing`).then(() => undefined, () => undefined) : Promise.resolve())),
      onDone: () => withProfile(OWNER_ID, () => (backend() === 'bluebubbles' && chatId.includes(';') ? bbApi('DELETE', `/api/v1/chat/${encodeURIComponent(chatId)}/typing`).then(() => undefined, () => undefined) : Promise.resolve()))
    })).catch((err) => {
      gw.status = { ...gw.status, detail: `Message handling failed: ${(err as Error).message}` }
      onChange()
    })
  }

  type Queued = { target: string; text: string; at: number }
  function queueOutbox(target: string, text: string): void {
    withProfile(OWNER_ID, () => kvSet(OUTBOX, [...(kvGet<Queued[]>(OUTBOX) ?? []), { target, text, at: Date.now() }].slice(-50)))
  }

  /** Resends queued replies in order; stops at the first failure so ordering holds and nothing is sent twice. */
  async function flushOutbox(): Promise<void> {
    if (flushing) return
    flushing = true
    try {
      for (;;) {
        const queue = (withProfile(OWNER_ID, () => kvGet<Queued[]>(OUTBOX)) ?? []).filter((q) => Date.now() - q.at < OUTBOX_MAX_AGE)
        const next = queue[0]
        if (!next) { withProfile(OWNER_ID, () => kvSet(OUTBOX, [])); return }
        // Removed before sending: an unconfirmed send must not be repeated.
        withProfile(OWNER_ID, () => kvSet(OUTBOX, queue.slice(1)))
        try {
          await withProfile(OWNER_ID, () => sendText(next.target, next.text))
        } catch (err) {
          if (!(err as { noRetry?: boolean }).noRetry) withProfile(OWNER_ID, () => kvSet(OUTBOX, [next, ...(kvGet<Queued[]>(OUTBOX) ?? [])]))
          return
        }
      }
    } finally { flushing = false }
  }

  function seenGuids(): Set<string> {
    return (seen ??= new Set(withProfile(OWNER_ID, () => kvGet<string[]>(SEEN)) ?? []))
  }

  function markSeen(guid: string): void {
    const set = seenGuids()
    set.add(guid)
    for (const old of set) {
      if (set.size <= 500) break
      set.delete(old)
    }
    withProfile(OWNER_ID, () => kvSet(SEEN, [...set]))
  }

  /** Shared by the webhook and the catch-up poll; `seen` and the persisted cursor keep each message to one answer. */
  function handleRecord(rec: Record<string, unknown>, type: string): void {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return
    if (rec.isFromMe || rec.fromMe) return
    if (typeof rec.associatedMessageType === 'number' && rec.associatedMessageType >= 1000) return
    if (typeof rec.associatedMessageType === 'string' && rec.associatedMessageType && rec.associatedMessageGuid) return
    const guid = String(rec.guid ?? '')
    if (guid && seenGuids().has(guid)) return
    if (!guid && type === 'updated-message') return
    // An update (delivery, read, edit) for a message from long ago is never a new request.
    if (typeof rec.dateCreated === 'number' && Date.now() - rec.dateCreated > CATCH_UP_MAX_AGE) return
    const chats = Array.isArray(rec.chats) ? rec.chats as { guid?: string }[] : []
    if (chats.length > 1) return
    const handle = rec.handle as { address?: string } | undefined
    const sender = typeof handle?.address === 'string' ? handle.address : typeof rec.sender === 'string' ? rec.sender : ''
    if (!authorizedSender('imessage', sender)) return
    // A missing route could be a group chat: wait for the catch-up query with authoritative chat metadata.
    const chatId = rec.chatGuid ?? chats[0]?.guid
    if (typeof chatId !== 'string') return
    if (!authorizedChat(chatId, sender)) return
    const text = typeof rec.text === 'string' ? rec.text.replace(/\uFFFC/g, '').trim() : ''
    if (!text) return
    // Initial webhook events can lack text; only deduplicate after a usable message arrives.
    if (guid) markSeen(guid)
    // Only the catch-up scan advances its cursor. A live webhook can arrive ahead of missed messages.
    dispatch(sender, chatId, text, String(rec.guid ?? Date.now()))
  }

  /**
   * Keeps exactly one webhook pointing here. Registrations left by an earlier password or a crash (no clean stop)
   * would otherwise post every message twice or fail with 401, and BlueBubbles can lose ours when it is reset.
   */
  async function ensureWebhook(): Promise<void> {
    if (!webhookUrl) return
    const ours = webhookUrl.split('?')[0]
    const existing = await bbApi<{ data?: { id: number; url: string }[] }>('GET', '/api/v1/webhook')
    let found = false
    for (const w of existing.data ?? []) {
      if (w.url.split('?')[0] !== ours) continue
      if (w.url === webhookUrl && !found) { found = true; continue }
      await bbApi('DELETE', `/api/v1/webhook/${w.id}`).catch(() => undefined)
    }
    if (!found) await bbApi('POST', '/api/v1/webhook', { url: webhookUrl, events: ['new-message', 'updated-message'] })
  }

  /**
   * Webhooks are lost while Jarvis restarts (updates, crashes) and occasionally in flight. Ask BlueBubbles for
   * anything newer than the last message handled, up to six hours back, at startup and then every CATCH_UP_MS.
   */
  async function catchUpBlueBubbles(): Promise<void> {
    // A scan left over from before a restart must neither block this connection's scan nor report on its health.
    const gen = generation
    if (!server || catchingUp === gen) return
    catchingUp = gen
    const live = () => !!server && gen === generation
    try {
      const cursor = withProfile(OWNER_ID, () => kvGet<number>(CURSOR))
      if (!cursor) {
        withProfile(OWNER_ID, () => kvSet(CURSOR, Date.now()))
        return
      }
      // Include the boundary timestamp (several messages can share a millisecond) and look a few minutes further
      // back: a text delivered late (phone offline) carries its send time, which can be older than the cursor. The
      // persisted GUIDs keep the overlap from answering anything twice.
      const after = Math.max(cursor - CATCH_UP_OVERLAP, Date.now() - CATCH_UP_MAX_AGE) - 1
      let newest = 0
      for (let offset = 0; ; offset += 50) {
        const res = await bbApi<{ data?: Record<string, unknown>[] }>('POST', '/api/v1/message/query', { limit: 50, offset, sort: 'ASC', after, with: ['chat', 'handle'] })
        if (!live()) return
        const records = res.data ?? []
        for (const rec of records) {
          handleRecord(rec, 'catch-up')
          if (typeof rec?.dateCreated === 'number') newest = Math.max(newest, rec.dateCreated)
        }
        if (records.length < 50) break
      }
      // Advance past every examined message, not only answered ones: otherwise 50 messages from
      // other senders (or our own) pin the window and newer messages are never caught up.
      if (newest) withProfile(OWNER_ID, () => kvSet(CURSOR, Math.max(kvGet<number>(CURSOR) ?? 0, newest)))
      // Re-register right after an outage (BlueBubbles may have restarted without our webhook), else every few minutes.
      if (catchUpFailures >= 3 || ++catchUpTicks % WEBHOOK_CHECK_TICKS === 0) await ensureWebhook()
      if (!live()) return
      void flushOutbox()
      if (catchUpFailures >= 3) {
        gw.status = { ...gw.status, state: 'running', detail: gw.status.detail.replace(/^BlueBubbles unreachable.*$/, 'BlueBubbles reconnected') }
        onChange()
      }
      catchUpFailures = 0
    } catch (err) {
      if (!live()) return
      console.error('[jarvis] iMessage catch-up failed:', (err as Error).message)
      // A BlueBubbles that stays down silently drops webhooks. Report it so the gateway watchdog restarts us
      // (re-registering the webhook) once it is back.
      if (++catchUpFailures === 3) {
        gw.status = { ...gw.status, state: 'error', detail: `BlueBubbles unreachable: ${(err as Error).message}` }
        onChange()
      }
    } finally {
      if (catchingUp === gen) catchingUp = 0
    }
  }

  async function startBlueBubbles(): Promise<void> {
    const conf = cfg().gateways.imessage
    const { url, password } = bbConfig()
    if (!password) throw new Error('Set BLUEBUBBLES_PASSWORD (and BLUEBUBBLES_SERVER_URL if not http://localhost:1234) in Environment.')
    await bbApi('GET', '/api/v1/ping')
    generation++
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://localhost')
      if (req.method !== 'POST' || u.pathname !== conf.webhookPath) return void res.writeHead(404).end()
      if (!sameSecret(u.searchParams.get('password'), bbConfig().password)) return void res.writeHead(401).end()
      const parts: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > 1_048_576) return void req.destroy()
        parts.push(c)
      })
      req.on('end', () => {
        // Decode once at the end: per-chunk decoding splits multi-byte characters (emoji) across chunks.
        const body = Buffer.concat(parts).toString('utf8')
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
        let payload: Record<string, unknown>
        try {
          payload = JSON.parse(body)
        } catch {
          const form = new URLSearchParams(body)
          try {
            payload = JSON.parse(form.get('payload') ?? form.get('data') ?? '{}')
          } catch {
            return
          }
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
        const type = String(payload.type ?? payload.event ?? '')
        if (type && !MESSAGE_EVENTS.has(type)) return
        const data = payload.data
        const rec = (Array.isArray(data) ? data[0] : data && typeof data === 'object' ? data : payload) as Record<string, unknown>
        handleRecord(rec, type)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(conf.webhookPort, conf.webhookHost, () => { server!.off('error', reject); resolve() })
    })
    // A later socket error must not become an uncaught exception in the main process; the watchdog restarts us.
    server.on('error', (err) => {
      gw.status = { ...gw.status, state: 'error', detail: `Webhook server error: ${err.message}` }
      onChange()
    })
    const host = conf.webhookHost === '0.0.0.0' || conf.webhookHost === '::' ? '127.0.0.1' : conf.webhookHost
    webhookUrl = `http://${host.includes(':') ? `[${host}]` : host}:${conf.webhookPort}${conf.webhookPath}?password=${encodeURIComponent(password)}`
    await ensureWebhook()
    catchUpFailures = 0
    void catchUpBlueBubbles()
    catchUpTimer = setInterval(() => void catchUpBlueBubbles(), CATCH_UP_MS)
    catchUpTimer.unref()
    const info = await bbApi<{ data?: { os_version?: string; server_version?: string; private_api?: boolean } }>('GET', '/api/v1/server/info').catch(() => ({ data: undefined }))
    gw.status = {
      ...gw.status,
      state: 'running',
      detail: `BlueBubbles ${info.data?.server_version ?? ''} at ${url} · owner only (${ownerPhone() ?? 'no owner phone set'})`
    }
  }

  async function pollChatDb(): Promise<void> {
    if (!db || busy) return
    busy = true
    try {
      const last = kvGet<number>('imessage:lastRowid') ?? 0
      pollStmt ??= db.prepare(
          `SELECT m.ROWID rowid, m.text text, m.attributedBody body, h.id handle, c.guid chatGuid
           FROM message m
           LEFT JOIN handle h ON h.ROWID = m.handle_id
           LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
           LEFT JOIN chat c ON c.ROWID = cmj.chat_id
           WHERE m.ROWID > ? AND m.is_from_me = 0 AND m.item_type = 0 AND COALESCE(m.associated_message_type, 0) = 0
           ORDER BY m.ROWID LIMIT 100`
        )
      const rows = pollStmt.all(last) as { rowid: number; text: string | null; body: Buffer | null; handle: string | null; chatGuid: string | null }[]
      for (const r of rows) {
        kvSet('imessage:lastRowid', r.rowid)
        if (!authorizedChat(r.chatGuid, r.handle)) continue
        const text = (r.text ?? decodeAttributedBody(r.body) ?? '').replace(/￼/g, '').trim()
        if (text && r.handle && r.chatGuid) dispatch(r.handle, r.chatGuid, text, String(r.rowid))
      }
    } catch (err) {
      gw.status = { ...gw.status, state: 'error', detail: (err as Error).message }
      onChange()
    } finally {
      busy = false
    }
  }

  async function startMessagesApp(): Promise<void> {
    try {
      db = new Database(CHAT_DB, { readonly: true, fileMustExist: true })
    } catch (err) {
      db = null
      throw new Error(`Cannot read ${CHAT_DB}. Grant Mac Mini Jarvis Full Disk Access. (${(err as Error).message})`)
    }
    const max = (db.prepare('SELECT MAX(ROWID) m FROM message').get() as { m: number | null }).m ?? 0
    if (kvGet<number>('imessage:lastRowid') === null) kvSet('imessage:lastRowid', max)
    timer = setInterval(() => void pollChatDb(), Math.max(1000, cfg().gateways.imessage.pollMs))
    gw.status = { ...gw.status, state: 'running', detail: 'Reading Messages directly' }
  }

  const gw: Gateway = {
    name: 'imessage',
    status: { name: 'imessage', enabled: false, state: 'stopped', detail: '', lastMessageAt: null },

    async start() {
      gw.status = { ...gw.status, enabled: true, state: 'starting', detail: 'Connecting…' }
      onChange()
      try {
        if (backend() === 'bluebubbles') await startBlueBubbles()
        else await startMessagesApp()
      } catch (err) {
        await gw.stop()
        gw.status = { ...gw.status, enabled: true, state: 'error', detail: (err as Error).message }
      }
      onChange()
    },

    async stop() {
      if (timer) clearInterval(timer)
      timer = null
      if (catchUpTimer) clearInterval(catchUpTimer)
      catchUpTimer = null
      db?.close()
      db = null
      pollStmt = null
      if (server) {
        const url = webhookUrl
        server.close()
        // Keep-alive sockets would otherwise keep feeding the closed server for a while.
        server.closeIdleConnections()
        server = null
        if (url) {
          // Short timeouts: a stopped BlueBubbles must not stall shutdown or a gateway restart.
          const existing = await bbApi<{ data?: { id: number; url: string }[] }>('GET', '/api/v1/webhook', undefined, 5000).catch(() => ({ data: [] }))
          for (const w of existing.data?.filter((x) => x.url === url) ?? []) await bbApi('DELETE', `/api/v1/webhook/${w.id}`, undefined, 5000).catch(() => undefined)
        }
      }
      webhookUrl = null
      gw.status = { ...gw.status, enabled: cfg().gateways.imessage.enabled, state: 'stopped', detail: '' }
      onChange()
    },

    send: sendText
  }
  return gw
}
