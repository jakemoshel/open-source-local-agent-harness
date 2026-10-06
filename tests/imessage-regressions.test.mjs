import test from 'node:test'
import assert from 'node:assert/strict'
import { loadModule, deferred } from './load-module.mjs'

test('reset boundary survives repeated context builds and excludes old turns', async () => {
  const kv = new Map(); let now = 200
  const old = Date.now; Date.now = () => now
  try {
    const c = await loadModule('src/main/context.ts', {
      './config': { cfg: () => ({ memory: { recap: { enabled: true, maxTurns: 10, maxChars: 4000 } } }) },
      './db': { kvGet: k => kv.get(k), kvSet: (k,v) => kv.set(k,v), listRuns: () => [{ id: 'old', prompt: 'old secret task', createdAt: 100, status: 'succeeded' }], listEvents() {}, getDb() {} }
    })
    c.markExplicitReset('chat')
    assert.equal(c.compactionRecap('chat'), '')
    now = 300
    assert.equal(c.compactionRecap('chat'), '')
    // A flag left by an older build is consumed once and becomes a boundary instead of blocking recaps forever.
    kv.set('norecap:legacy', true)
    assert.equal(c.compactionRecap('legacy'), '')
    assert.equal(kv.get('norecap:legacy'), false)
    assert.equal(kv.get('resetAt:legacy'), 300)
  } finally { Date.now = old }
})

test('BlueBubbles sends one bubble, canonicalizes stale direct GUIDs and never retries ambiguous failures', async () => {
  const requests = []; let fail = false, refused = false
  const original = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    requests.push({ url, body: opts.body && JSON.parse(opts.body) })
    if (refused) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
    if (fail) throw new TypeError('fetch failed after submitting')
    return { ok: true, json: async () => ({}) }
  }
  try {
    const m = await loadModule('src/main/gateways/imessage.ts', {
      '../config': { cfg: () => ({ gateways: { imessage: { backend: 'bluebubbles' } } }) },
      '../env': { readEnvFile: () => ({ BLUEBUBBLES_PASSWORD: 'test' }) },
      '../db': { kvGet: () => null, kvSet() {} },
      './commands': { handleInbound() {} },
      'better-sqlite3': { default: class {} }
    })
    const gw = m.createIMessage(() => {})
    await gw.send('iMessage;-;+15551234567', 'one\n\ntwo\n\nthree')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].body.chatGuid, 'any;-;+15551234567')
    assert.equal(requests[0].body.message, 'one\n\ntwo\n\nthree')
    fail = true
    await assert.rejects(gw.send('any;-;+15551234567', 'test'), e => e.noRetry === true)
    // Nothing reached a server that refused the connection, so the reply stays retryable.
    refused = true
    await assert.rejects(gw.send('any;-;+15551234567', 'test'), e => !e.noRetry)
  } finally { globalThis.fetch = original }
})

test('NEW alone opens a new thread without a model; NEW with a prompt cancels the old run and runs in the new thread', async () => {
  const calls = []; const replies = []; const kv = new Map()
  const m = await loadModule('src/main/gateways/commands.ts', {
    '../updater': { applyUpdate() {} },
    '../config': { cfg: () => ({ gateways: { idleResetMinutes: 0 } }) },
    '../db': { listRuns: ({conversationKey, status}) => status === 'running' && conversationKey === 'imessage:any;-;+15551234567' ? [{id:'old'}] : [], getConversation() {}, deleteConversation: k => calls.push(['delete', k]), kvGet: k => kv.get(k) ?? null, kvSet: (k, v) => kv.set(k, v) },
    './approvals': { rememberChat() {}, answerApproval() {} },
    '../provider-login': { waitingForClaudeCode: () => false, normalizeLoginCode() {}, cancelLogin() {}, loginInstructions() {}, loginListening() {}, loginResultText() {}, startLogin() {}, submitLoginCode() {} },
    '../model-commands': { parseModelCommand: () => null, splitModelPrefix: async () => null, applyModelCommand: async () => ({}), runModelCommand: async () => '', chatModel: () => null, copyChatModel: (from, to) => calls.push(['copy', from, to]) },
    '../runs': { cancelRun: id => calls.push(['cancel', id]), sendMessage: async input => { calls.push(['send', input.prompt, input.conversationKey]); return {run:{id:'next'},steered:false} }, waitForRun: async () => ({status:'succeeded',result:'done'}) }
  })
  const chat = 'imessage:any;-;+15551234567'
  const inbound = text => ({key:chat,text,trigger:'imessage',triggerRef:'guid',reply:async text => replies.push(text)})
  await m.handleInbound(inbound('NEW'))
  assert.deepEqual(calls.map(c => c[0]), ['cancel','copy'])
  assert.deepEqual(replies, ['New chat started.'])
  const first = m.currentThread(chat)
  assert.match(first, /^imessage:any;-;\+15551234567#[a-z0-9]+$/, 'the chat moved to a new thread')
  await m.handleInbound(inbound('hello'))
  assert.deepEqual(calls.at(-1), ['send', 'hello', first], 'later messages stay in the new thread')
  calls.length = 0
  const clock = Date.now
  Date.now = () => 123456
  try {
    const rapid = m.startNewThread(first)
    assert.notEqual(m.startNewThread(rapid), rapid, 'two NEW commands in the same millisecond must be distinct')
  } finally { Date.now = clock }
  await m.handleInbound(inbound('NEW next task'))
  const second = m.currentThread(chat)
  assert.notEqual(second, first)
  assert.deepEqual(calls.at(-1), ['send', 'next task', second])
  assert.ok(!calls.some(c => c[0] === 'delete'), 'old threads keep their session')
  assert.equal(replies.at(-1), 'done')
  assert.equal(m.chatOfThread(second), chat)
})

test('autocapitalized New/Stop are commands; lowercase stays a message; idle conversations restart with a recap', async () => {
  const calls = []; const replies = []
  let lastRun = { finishedAt: Date.now() - 3 * 3_600_000 }
  const m = await loadModule('src/main/gateways/commands.ts', {
    '../updater': { applyUpdate() {} },
    '../config': { cfg: () => ({ gateways: { idleResetMinutes: 120 } }) },
    '../db': { listRuns: ({ status }) => status ? [] : [lastRun], getConversation: () => ({ sessionId: 's1' }), deleteConversation: k => calls.push(['delete', k]), kvGet: () => null, kvSet() {} },
    '../model-commands': { parseModelCommand: () => null, splitModelPrefix: async () => null, applyModelCommand: async () => ({}), runModelCommand: async () => '', chatModel: () => null, copyChatModel: () => calls.push(['copy']) },
    './approvals': { rememberChat() {}, answerApproval() {} },
    '../provider-login': { waitingForClaudeCode: () => false, normalizeLoginCode() {}, cancelLogin() {}, loginInstructions() {}, loginListening() {}, loginResultText() {}, startLogin() {}, submitLoginCode() {} },
    '../runs': { cancelRun: id => calls.push(['cancel', id]), sendMessage: async input => { calls.push(['send', input.prompt]); return { run: { id: 'next' }, steered: false } }, waitForRun: async () => ({ status: 'succeeded', result: 'done' }) }
  })
  const inbound = text => ({ key: 'imessage:any;-;+15551234567', text, trigger: 'imessage', triggerRef: 'guid', reply: async text => replies.push(text) })
  await m.handleInbound(inbound('New'))
  assert.deepEqual(calls.map(c => c[0]), ['copy'])
  assert.equal(replies.at(-1), 'New chat started.')
  await m.handleInbound(inbound('Stop'))
  assert.equal(replies.at(-1), 'Nothing is running.')
  calls.length = 0
  // Three hours idle: the session is dropped (recap kept, so no explicit reset) before the message is sent.
  await m.handleInbound(inbound('new idea for the deck'))
  assert.deepEqual(calls, [['delete', 'imessage:any;-;+15551234567'], ['send', 'new idea for the deck']], 'the kv mock keeps the original thread')
  calls.length = 0
  lastRun = { finishedAt: Date.now() - 60_000 }
  await m.handleInbound(inbound('stop'))
  assert.deepEqual(calls, [['send', 'stop']])
})

test('the chat sidebar groups by date or by source, with background threads folded', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const React = await import('react')
  const chats = ['ui','imessage','slack','schedule','imported','agent'].map(source => ({key:source,title:`${source} chat`,source,turns:1,lastStatus:'succeeded',updatedAt:Date.now()}))
  chats.push({key:'live',title:'live chat',source:'imessage',turns:2,lastStatus:'running',updatedAt:Date.now()})
  const original = { window: globalThis.window, localStorage: globalThis.localStorage }
  const saved = new Map()
  globalThis.window = {ea:{}, addEventListener() {}, removeEventListener() {}}
  globalThis.localStorage = { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v) }
  try {
    const { Chat } = await loadModule('src/renderer/src/pages/Chat.tsx', {
      'react-router-dom': { useNavigate: () => () => {}, useParams: () => ({}), Link: ({children,...props}) => React.createElement('a', props, children) },
      '@/lib/api': { ea: {}, useOp: op => ({data:op === 'conversations_list' ? chats : null}), useBus() {}, call() {} },
      '@/components/toast': { useAction: () => () => {}, useToast: () => () => {} }
    })
    let html = renderToStaticMarkup(React.createElement(Chat))
    assert.ok(html.includes('aria-label="Running"') && html.includes('aria-label="Today"'), 'date grouping is the default, running chats on top')
    for (const chat of chats) assert.ok(html.includes(chat.title), chat.title)
    saved.set('chat.sidebar.groupBy', '"source"')
    html = renderToStaticMarkup(React.createElement(Chat))
    for (const label of ['Running','App','iMessage','Slack','Schedules','Imported','Agent']) assert.ok(html.includes(`aria-label="${label}"`), label)
    for (const title of ['ui chat','imessage chat','slack chat','schedule chat','live chat']) assert.ok(html.includes(title), title)
    for (const title of ['imported chat','agent chat']) assert.ok(!html.includes(title), `${title} starts folded`)
  } finally { Object.assign(globalThis, original) }
})

test('transcript search returns persisted channel and routing metadata', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const sql = new DatabaseSync(':memory:')
  class Adapter {
    constructor() { return sql }
  }
  sql.pragma = () => {}
  const db = await loadModule('src/main/db.ts', {
    'better-sqlite3': { default: Adapter },
    './paths': { paths: {db:':memory:'} },
    './bus': { bus: {emit() {}} }
  })
  try {
    db.openDb()
    db.insertRun({id:'sms',title:'Test',provider:'codex',model:null,status:'succeeded',trigger:'imessage',triggerRef:'any;-;+1555:message-guid',conversationKey:'imessage:any;-;+1555',cwd:'/tmp',prompt:'find this',sessionId:null,parentRunId:null,result:'done',error:null,usage:null,createdAt:100,startedAt:100,finishedAt:101})
    db.appendEvent('sms','user',{text:'searchable message'})
    const [hit] = db.searchTranscripts('searchable')
    assert.equal(hit.source,'imessage')
    assert.equal(hit.conversationKey,'imessage:any;-;+1555')
    assert.equal(hit.triggerRef,'any;-;+1555:message-guid')
    assert.match(hit.snippet,/searchable/)
  } finally { sql.close() }
})

test('one conversation per 1:1 chat whatever service prefix or handle format BlueBubbles reports', async () => {
  const m = await loadModule('src/main/gateways/imessage.ts', {
    '../config': { cfg: () => ({ gateways: { imessage: { backend: 'bluebubbles' } } }) },
    '../env': { readEnvFile: () => ({}) }, '../db': { kvGet: () => null, kvSet() {} },
    './commands': { handleInbound() {} }, 'better-sqlite3': { default: class {} }
  })
  const forms = ['iMessage;-;+15551234567', 'SMS;-;+1 (555) 123-4567', 'any;-;15551234567', 'iMessage;-;5551234567']
  assert.deepEqual(new Set(forms.map((c) => m.canonicalChat(c, '+15551234567'))), new Set(['any;-;+15551234567']))
  assert.equal(m.canonicalChat('iMessage;-;Owner@Example.com', ''), 'any;-;owner@example.com')
  assert.equal(m.canonicalChat('iMessage;+;chat123', '+15551234567'), 'iMessage;+;chat123')
  assert.equal(m.canonicalChat('', '+1 555 123 4567'), 'any;-;+15551234567')
})

test('agent Markdown is sent as plain text on iMessage and as mrkdwn on Slack; Slack input is decoded', async () => {
  const t = await loadModule('src/main/gateways/types.ts')
  const md = '## Plan\n**Bold** [docs](https://x.com) `x`\n- item\n```\n**kept** <3\n```'
  assert.equal(t.plainText(md), 'Plan\nBold docs (https://x.com) x\n• item\n**kept** <3')
  assert.equal(t.slackText(md + '\nA & B'), '*Plan*\n*Bold* <https://x.com|docs> `x`\n• item\n```\n**kept** <3\n```\nA &amp; B')
  assert.equal(t.slackIncoming('<https://a.com/?x=1&amp;y|a.com> &lt;b&gt; <mailto:j@x.com|j@x.com>'), 'https://a.com/?x=1&y <b> j@x.com')
})

test('catch-up drains timestamp ties and live webhooks cannot skip missed messages', async () => {
  const { EventEmitter } = await import('node:events')
  const { deferred, tick } = await import('./load-module.mjs')
  const pending = deferred(), queried = deferred()
  const cursor = Date.now() - 1000
  const kv = new Map([['imessage:bb:lastTs', cursor]])
  const handled = [], queries = []
  let webhook, gw
  const original = globalThis.fetch
  const record = (id, at) => ({ guid: id, text: id, dateCreated: at, handle: { address: '+15555550125' }, chatGuid: 'any;-;+15555550125' })
  const records = Array.from({ length: 60 }, (_, i) => record(`missed-${i}`, cursor))
  records.push(record('tail', cursor + 100))
  globalThis.fetch = async (url, opts) => {
    let data = []
    if (url.includes('/message/query')) {
      const body = JSON.parse(opts.body)
      queries.push(body)
      if (queries.length === 1) { queried.resolve(); await pending.promise }
      data = records.slice(body.offset, body.offset + body.limit)
    }
    return { ok: true, json: async () => ({ data }) }
  }
  try {
    const m = await loadModule('src/main/gateways/imessage.ts', {
      'node:http': { createServer: handler => {
        webhook = handler
        const server = new EventEmitter()
        server.listen = (port, host, cb) => cb()
        server.close = () => {}
        server.closeIdleConnections = () => {}
        return server
      } },
      '../config': { cfg: () => ({ gateways: { imessage: { backend: 'bluebubbles', webhookPath: '/hook', webhookPort: 1234, webhookHost: '127.0.0.1' } } }) },
      '../env': { readEnvFile: () => ({ BLUEBUBBLES_PASSWORD: 'test' }) },
      '../db': { kvGet: key => kv.get(key) ?? null, kvSet: (key, value) => kv.set(key, value) },
      '../profiles': { profileForSender: () => ({ id: 'owner' }), allProfiles: () => [] },
      './commands': { handleInbound: async msg => { handled.push(msg.text) } },
      'better-sqlite3': { default: class {} }
    })
    gw = m.createIMessage(() => {})
    await gw.start()
    await queried.promise
    const req = new EventEmitter()
    Object.assign(req, { method: 'POST', url: '/hook?password=test' })
    const res = { writeHead() { return this }, end() {} }
    webhook(req, res)
    req.emit('data', Buffer.from(JSON.stringify({ type: 'new-message', data: record('live', cursor + 500) })))
    req.emit('end')
    assert.equal(kv.get('imessage:bb:lastTs'), cursor, 'webhook must not jump ahead of catch-up')
    pending.resolve()
    for (let i = 0; i < 100 && kv.get('imessage:bb:lastTs') === cursor; i++) await tick()
    assert.deepEqual(queries.map(q => q.offset), [0, 50])
    assert.equal(queries[0].after, cursor - 5 * 60_000 - 1, 'catch-up overlaps the cursor for late-delivered texts')
    assert.equal(handled.length, 62)
    assert.equal(new Set(handled).size, 62)
    assert.equal(kv.get('imessage:bb:lastTs'), cursor + 100)
    await gw.stop()
    await gw.start()
    for (let i = 0; i < 10; i++) await tick()
    assert.equal(handled.length, 62, 'persisted GUIDs prevent a second reply after restart')
  } finally {
    pending.resolve()
    if (gw) await gw.stop()
    globalThis.fetch = original
  }
})

test('NEW opens the returned empty thread; a late response cannot navigate away from another chat', async () => {
  for (const moved of [false, true]) {
    const React = await import('react')
    const navigated = [], refs = [], response = deferred()
    const { Chat } = await loadModule('src/renderer/src/pages/Chat.tsx', {
      react: { ...React.default, useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useRef: initial => { const ref = { current: initial }; refs.push(ref); return ref }, useEffect() {} },
      'react-router-dom': { useNavigate: () => path => navigated.push(path), useParams: () => ({ key: 'ui:old' }), Link: () => null },
      '@/lib/api': { ea: {}, useOp: () => ({ data: null }), useBus() {}, call: () => response.promise },
      '@/components/toast': { useAction: () => fn => fn(), useToast: () => () => {} }
    })
    const findComposer = node => {
      if (!node || typeof node !== 'object') return null
      if (node.props?.onSend) return node
      for (const child of [node.props?.children].flat()) { const found = findComposer(child); if (found) return found }
      return null
    }
    const composer = findComposer(Chat())
    assert.ok(composer)
    const sent = composer.props.onSend('NEW')
    if (moved) refs.find(ref => ref.current === 'ui:old').current = 'ui:other'
    response.resolve({ run: null, steered: false, notice: 'New chat started.', conversationKey: 'ui:new' })
    assert.equal(await sent, true)
    assert.deepEqual(navigated, moved ? [] : ['/chat/ui%3Anew'])
  }
})
