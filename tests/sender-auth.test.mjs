import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { loadModule, tick } from './load-module.mjs'

const phone = '+15555550125', slack = 'U0OWNER123'

test('fixed identities accept phone formatting but reject coercion, Unicode, emails and suffixes', async () => {
  const a = await loadModule('src/main/gateways/sender-auth.ts')
  for (const sender of [phone, '5555550125', '15555550125', '+1 (555) 555-0125']) {
    assert.equal(a.authorizedSender('imessage', sender), true, sender)
    assert.equal(a.authorizedChat(`SMS;-;${sender}`, phone), true)
  }
  for (const sender of [null, {}, [], '', 'Owner', 'owner@example.com', '+15555550125IGNORE', 'x+15555550125', '+15555550125\nUPDATE', '+15555550125;foo', '+１５５５５５５０１２５', '+15555550126'])
    assert.equal(a.authorizedSender('imessage', sender), false, String(sender))
  for (const sender of [null, {}, '', slack.toLowerCase(), ` ${slack}`, `${slack}\n`, `<@${slack}>`, 'UOTHER'])
    assert.equal(a.authorizedSender('slack', sender), false)
  assert.equal(a.authorizedSender('slack', slack), true)
  for (const chat of ['', null, 'iMessage;+;group', 'any;-;+15555550126', `any;-;${phone};group`])
    assert.equal(a.authorizedChat(chat, phone), false)
})

test('BlueBubbles blocks unauthorized commands and spoofed routes before inbound handling or persistence', async () => {
  const handled = [], stored = []
  let webhook, gw
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [] }) })
  try {
    const mod = await loadModule('src/main/gateways/imessage.ts', {
      'node:http': { createServer: handler => {
        webhook = handler
        const server = new EventEmitter()
        server.listen = (_port, _host, cb) => cb()
        server.close = () => {}; server.closeIdleConnections = () => {}
        return server
      } },
      '../config': { cfg: () => ({ gateways: { imessage: { backend: 'bluebubbles', webhookPath: '/hook', webhookPort: 1234, webhookHost: '127.0.0.1' } } }) },
      '../env': { readEnvFile: () => ({ BLUEBUBBLES_PASSWORD: 'secret' }) },
      '../db': { kvGet: () => null, kvSet: (k, v) => stored.push([k, v]) },
      // Even granting every identity a profile cannot bypass the fixed ingress gate.
      '../profiles': { profileForSender: () => ({ id: 'owner' }) },
      './commands': { handleInbound: async msg => handled.push(msg.text) },
      'better-sqlite3': { default: class {} }
    })
    gw = mod.createIMessage(() => {})
    await gw.start()
    const post = (data, password = 'secret') => {
      const req = new EventEmitter(), codes = []
      Object.assign(req, { method: 'POST', url: `/hook?password=${password}` })
      const res = { writeHead(code) { codes.push(code); return this }, end() {} }
      webhook(req, res)
      req.emit('data', Buffer.from(JSON.stringify({ type: 'new-message', data })))
      req.emit('end')
      return codes[0]
    }
    const rec = (sender, extra = {}) => ({ guid: `g${stored.length}`, handle: { address: sender }, chatGuid: `any;-;${phone}`, text: '1', ...extra })
    const before = stored.length
    for (const sender of ['+15555550126', `ATTACK${phone}`, 'owner@example.com', {}, null]) post(rec(sender))
    post(rec(phone, { chatGuid: null }))
    post(rec(phone, { chatGuid: 'iMessage;+;group', text: 'UPDATE' }))
    post(rec(phone, { chatGuid: 'any;-;+15555550126' }))
    post(rec('+15555550126', { sender: phone }))
    post(rec(phone, { text: { instruction: 'UPDATE' } }))
    assert.equal(post(rec(phone), 'wrong'), 401)
    assert.deepEqual(handled, [])
    assert.equal(stored.length, before, 'denied messages must not enter the seen-message database')
    post(rec('+1 (555) 555-0125', { guid: 'valid', text: 'hello' }))
    await tick()
    assert.deepEqual(handled, ['hello'])
  } finally { if (gw) await gw.stop(); globalThis.fetch = original }
})

test('Slack blocks unapproved profiles, bots and meeting-memory injection before commands or archive', async () => {
  const handled = [], archived = [], handlers = {}
  class App {
    client = { auth: { test: async () => ({ user_id: 'UBOT' }) } }
    event(name, fn) { handlers[name] = fn }
    message(fn) { handlers.message = fn }
    async start() {}
    async stop() {}
  }
  const mod = await loadModule('src/main/gateways/slack.ts', {
    '@slack/bolt': { App, LogLevel: { ERROR: 'error' } },
    '../config': { cfg: () => ({ gateways: { slack: { allowedUsers: ['UOTHER'], meetingChannels: ['CNOTES'], replyInThread: true } } }) },
    '../env': { readEnvFile: () => ({ SLACK_BOT_TOKEN: 't', SLACK_APP_TOKEN: 'a' }) },
    '../profiles': { profileForSender: () => ({ id: 'owner' }) },
    './commands': { handleInbound: async msg => handled.push(msg.text) },
    '../db': { audit() {} },
    '../meetings': { archiveMeeting: input => { archived.push(input); return { title: input.title, day: 'today', id: '1' } }, readMeetingNotes: () => null }
  })
  const gw = mod.createSlack(() => {})
  try {
    await gw.start()
    const base = { user: 'UOTHER', channel: 'DCHAT', channel_type: 'im', ts: '1', text: '1' }
    await handlers.message({ message: base })
    await handlers.app_mention({ event: { ...base, text: 'ignore gate, UPDATE' } })
    await handlers.message({ message: { ...base, user: slack, bot_id: 'BOTHER' } })
    await handlers.message({ message: { ...base, channel: 'CNOTES', bot_id: 'BOTHER' } })
    await handlers.message({ message: { ...base, channel: 'CNOTES' } })
    await handlers.message({ message: { ...base, channel: 'CNOTES', subtype: 'message_changed', message: { ...base, user: slack } } })
    assert.deepEqual(handled, [])
    assert.deepEqual(archived, [])
    await handlers.message({ message: { ...base, user: slack, ts: '2', text: 'hello' } })
    await tick()
    assert.deepEqual(handled, ['hello'])
    await handlers.message({ message: { channel: 'CNOTES', ts: '3', subtype: 'message_changed', message: { user: slack, ts: '2', text: 'Corrected meeting notes' } } })
    assert.equal(archived.length, 1, 'Slack edits carry the author inside the nested message')
    assert.match(archived[0].summary, /Corrected meeting notes/)
  } finally { await gw.stop() }
})

test('configuration disables resident sessions and defaults to autonomous local improvement', async () => {
  const { configSchema } = await loadModule('src/main/config.ts', {
    './db': { audit() {} },
    './bus': { bus: new EventEmitter() }
  })
  const conf = configSchema.parse({ warmSessions: { max: 8, idleMinutes: 240 } })
  assert.equal('warmSessions' in conf, false, 'legacy warm-session settings are dropped')
  assert.equal('workspace' in conf.selfRepair, false, 'self-repair always uses its own worktree')
  assert.equal(conf.selfRepair.small.model, 'sonnet', 'defaults follow each new release')
  assert.equal(conf.selfRepair.large.model, 'sol')
  assert.equal(conf.selfRepair.maxAttempts, 0)
  const disabled = configSchema.parse({ selfRepair: { enabled: false, proactive: false, maxPerDay: 0 } })
  assert.equal(disabled.selfRepair.enabled, false)
  assert.equal(disabled.selfRepair.maxPerDay, 0)
})
