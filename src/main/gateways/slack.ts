import { profileForSender } from '../profiles'
import { withProfile, OWNER_ID } from '../profile-context'
import { App, LogLevel } from '@slack/bolt'
import { cfg } from '../config'
import { readEnvFile } from '../env'
import { handleInbound } from './commands'
import { authorizedSender } from './sender-auth'
import { chunk, DeliveryUncertain, slackIncoming, slackText, withRetry, type Gateway } from './types'
import { audit } from '../db'
import { archiveMeeting, readMeetingNotes } from '../meetings'
import { meetingIdFor, slackNoteToMeeting, unwrapSlackEvent, type SlackNoteMessage } from './slack-meetings'

type SlackMessage = { user?: string; text?: string; channel: string; ts: string; thread_ts?: string; channel_type?: string; bot_id?: string; subtype?: string }

/** Subtypes that are still a person writing to Jarvis: a message with a file attached, a thread reply also sent to the channel. */
const USER_SUBTYPES = new Set(['file_share', 'thread_broadcast'])
const START_TIMEOUT_MS = 45_000

export function createSlack(onChange: () => void): Gateway {
  let app: InstanceType<typeof App> | null = null
  let botUserId: string | null = null
  // Socket Mode redelivers events after a reconnect; never answer the same message twice.
  const seen = new Set<string>()
  /** True the first time an event key is seen; the set stays bounded. */
  const firstSight = (key: string): boolean => {
    if (seen.has(key)) return false
    seen.add(key)
    if (seen.size > 2000) seen.delete(seen.values().next().value!)
    return true
  }

  /** The client of the current connection; a restart mid-run replaces the app, so never hold on to an old one. */
  async function liveClient(timeoutMs = 120_000): Promise<InstanceType<typeof App>['client']> {
    const until = Date.now() + timeoutMs
    while (!app || gw.status.state !== 'running') {
      if (Date.now() > until || (!cfg().gateways.slack.enabled && !app)) throw new Error('Slack gateway is not connected')
      await new Promise((r) => setTimeout(r, 2000))
    }
    return app.client
  }

  /** Retry only the current chunk; acknowledged chunks must never be replayed by deliver(). */
  async function sendText(channel: string, thread: string | undefined, text: string, proactive = false): Promise<void> {
    let sent = 0
    for (const part of chunk(slackText(text), 3500)) {
      try {
        await withRetry(async () => {
          // A reconnect can replace the client between attempts, including mid-message.
          const client = await liveClient(proactive ? 10_000 : 120_000)
          try {
            await client.chat.postMessage({ channel, thread_ts: thread, text: part })
          } catch (err) {
            const e = err as {
              code?: string; statusCode?: number; retryAfter?: number
              original?: { code?: string; cause?: { code?: string } }
              data?: { error?: string; response_metadata?: { retryAfter?: number } }
            }
            const code = e?.original?.cause?.code ?? e?.original?.code ?? ''
            const neverConnected = e?.code === 'slack_webapi_request_error' && /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT)$/.test(code)
            // Slack documents possible partial success for internal_error/fatal_error.
            // https://docs.slack.dev/reference/methods/chat.postMessage/#errors
            const rejected = e?.code === 'slack_webapi_rate_limited_error'
              || (e?.code === 'slack_webapi_platform_error' && !!e.data?.error && !/^(internal_error|fatal_error|service_unavailable)$/.test(e.data.error))
              || (e?.code === 'slack_webapi_http_error' && e.statusCode! >= 400 && e.statusCode! < 500)
            if (!neverConnected && !rejected) throw new DeliveryUncertain(`Slack delivery unconfirmed: ${(err as Error)?.message ?? String(err)}`)
            const retryAfter = e.retryAfter ?? e.data?.response_metadata?.retryAfter
            if (retryAfter && Number.isFinite(retryAfter) && retryAfter > 0) await new Promise((r) => setTimeout(r, retryAfter * 1000))
            throw err
          }
        // Before the first acknowledgement, deliver() owns proactive retries. After it,
        // retry here so its whole-message retry cannot duplicate earlier chunks.
        }, proactive ? (sent === 0 ? [] : [5000, 15_000, 30_000, 60_000, 120_000]) : undefined)
      } catch (err) {
        if (sent > 0 && !(err as { noRetry?: boolean })?.noRetry) throw new DeliveryUncertain(`Slack delivery incomplete after ${sent} chunk(s): ${(err as Error)?.message ?? String(err)}`)
        throw err
      }
      sent++
    }
  }

  const gw: Gateway = {
    name: 'slack',
    status: { name: 'slack', enabled: false, state: 'stopped', detail: '', lastMessageAt: null },

    async start() {
      const env = readEnvFile()
      const token = env.SLACK_BOT_TOKEN
      const appToken = env.SLACK_APP_TOKEN
      gw.status = { ...gw.status, enabled: true, state: 'starting', detail: 'Connecting…' }
      onChange()
      if (!token || !appToken) {
        gw.status = { ...gw.status, state: 'error', detail: 'Set SLACK_BOT_TOKEN (xoxb-) and SLACK_APP_TOKEN (xapp-) in Env.' }
        onChange()
        return
      }
      // The SDK otherwise retries even ambiguous POST failures before we can classify them.
      const current = new App({ token, appToken, socketMode: true, logLevel: LogLevel.ERROR, clientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true } })
      app = current

      const handle = async (m: SlackMessage, isMention: boolean) => {
        if (!m || typeof m !== 'object' || typeof m.user !== 'string' || !authorizedSender('slack', m.user)) return
        if (m.bot_id || (m.subtype && !USER_SUBTYPES.has(m.subtype)) || typeof m.text !== 'string' || !m.text || typeof m.channel !== 'string' || !m.channel || typeof m.ts !== 'string' || !m.ts) return
        const conf = cfg().gateways.slack
        const profile = profileForSender('slack', m.user)
        if (!profile || profile.id !== OWNER_ID) return
        const isDm = m.channel_type === 'im'
        if (!isDm && !isMention) return
        const text = slackIncoming(botUserId ? m.text.replaceAll(`<@${botUserId}>`, '') : m.text).trim()
        if (!text || !firstSight(`${m.channel}:${m.ts}`)) return
        const threadTs = conf.replyInThread || m.thread_ts ? (m.thread_ts ?? m.ts) : undefined
        const key = isDm && !m.thread_ts ? `slack:${m.channel}` : `slack:${m.channel}:${m.thread_ts ?? m.ts}`
        gw.status = { ...gw.status, lastMessageAt: Date.now() }
        onChange()
        const replyThread = isDm && !m.thread_ts ? undefined : threadTs
        void withProfile(profile.id, () => handleInbound({
          key,
          text,
          trigger: 'slack',
          triggerRef: `${m.channel}:${m.ts}`,
          provider: conf.provider,
          cwd: conf.cwd,
          reply: (t) => sendText(m.channel, replyThread, t),
          onStart: () => liveClient(5000).then((c) => c.reactions.add({ channel: m.channel, timestamp: m.ts, name: 'eyes' })).then(() => undefined, () => undefined),
          onDone: () => liveClient(5000).then((c) => c.reactions.remove({ channel: m.channel, timestamp: m.ts, name: 'eyes' })).then(() => undefined, () => undefined)
        })).catch((err) => {
          gw.status = { ...gw.status, detail: `Reply failed: ${(err as Error).message}` }
          onChange()
        })
      }

      /** Meeting-notes channels: archive authorized owner posts straight into meetings memory, no model run. */
      const archiveNote = (raw: SlackNoteMessage): void => {
        if (!raw || typeof raw !== 'object' || raw.bot_id || (raw.user !== undefined && !authorizedSender('slack', raw.user))) return
        const m = unwrapSlackEvent(raw)
        if (!m) return
        // Meeting memory is also an AI input: arbitrary integrations must not write it.
        if (m.bot_id || !authorizedSender('slack', m.user)) return
        if (!firstSight(`note:${m.channel}:${m.ts}:${raw.subtype === 'message_changed' ? raw.ts : ''}`)) return
        try {
          let existing: { title: string; date: string; summary: string } | null = null
          try { existing = readMeetingNotes(meetingIdFor(m)) } catch { /* first post of this thread */ }
          const input = slackNoteToMeeting(m, existing)
          if (!input) return
          const saved = archiveMeeting(input)
          audit('system', 'meetings', `Archived Slack meeting note ${saved.title} (${saved.day})`, undefined, { id: saved.id, channel: m.channel, ts: m.ts })
          gw.status = { ...gw.status, lastMessageAt: Date.now() }
        } catch (err) {
          gw.status = { ...gw.status, detail: `Meeting note archive failed: ${(err as Error).message}` }
        }
        onChange()
      }

      current.event('app_mention', async ({ event }: { event: unknown }) => {
        if (!event || typeof event !== 'object') return
        if (cfg().gateways.slack.meetingChannels.includes((event as SlackMessage).channel)) return
        await handle(event as unknown as SlackMessage, true)
      })
      current.message(async ({ message }: { message: unknown }) => {
        if (!message || typeof message !== 'object') return
        const m = message as unknown as SlackMessage
        if (cfg().gateways.slack.meetingChannels.includes(m.channel)) return archiveNote(message as SlackNoteMessage)
        await handle(m, false)
      })

      // Socket Mode retries apps.connections.open indefinitely while offline, so start() may never settle. Give up
      // after a while (the watchdog retries) and close a connection that only opens after it was replaced.
      const started = current.start()
      started.then(() => { if (app !== current) void current.stop().catch(() => undefined) }, () => undefined)
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out connecting to Slack')), START_TIMEOUT_MS) })])
        const auth = await current.client.auth.test()
        if (app !== current) return
        botUserId = (auth.user_id as string) ?? null
        gw.status = { ...gw.status, state: 'running', detail: `Connected as @${auth.user} in ${auth.team}` }
      } catch (err) {
        if (app !== current) return
        gw.status = { ...gw.status, state: 'error', detail: (err as Error).message }
      } finally {
        clearTimeout(timer)
      }
      onChange()
    },

    async stop() {
      const old = app
      app = null
      // A socket that never answers the close must not stall shutdown or the restart.
      if (old) await Promise.race([old.stop().catch(() => undefined), new Promise((r) => setTimeout(r, 10_000).unref())])
      gw.status = { ...gw.status, enabled: cfg().gateways.slack.enabled, state: 'stopped', detail: '' }
      onChange()
    },

    async send(target, text) {
      const [channel, thread] = target.split(':')
      await sendText(channel, thread, text, true)
    }
  }
  return gw
}
