import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WebClient, WebAPIRequestError, WebAPIHTTPError, WebAPIPlatformError, WebAPIRateLimitedError } from '@slack/web-api'
import { loadModule } from './load-module.mjs'

const first = 'a'.repeat(3500), second = 'b'.repeat(500), message = first + second
const refused = () => new WebAPIRequestError(new TypeError('fetch failed', {
  cause: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
}))

async function fixture(t, post, realClient = false) {
  const handlers = {}, clients = [], options = [], waits = []
  let inbound, eventNumber = 0
  class App {
    constructor(opts) {
      options.push(opts)
      this.client = realClient
        ? new WebClient('test', { ...opts.clientOptions, logLevel: 'error', fetch: post })
        : { chat: { postMessage: post } }
      this.client.auth = { test: async () => ({ user_id: 'UBOT' }) }
      clients.push(this.client)
    }
    event(name, fn) { handlers[name] = fn }
    message(fn) { handlers.message = fn }
    async start() {}
    async stop() {}
  }
  const config = { gateways: { slack: { enabled: true, meetingChannels: [], replyInThread: true }, imessage: { enabled: false } } }
  const mod = await loadModule('src/main/gateways/slack.ts', {
    '@slack/bolt': { App, LogLevel: { ERROR: 'error' } },
    '../config': { cfg: () => config },
    '../env': { readEnvFile: () => ({ SLACK_BOT_TOKEN: 't', SLACK_APP_TOKEN: 'a' }) },
    '../profiles': { profileForSender: () => ({ id: 'owner' }) },
    './commands': { handleInbound: async msg => { inbound = msg } },
    '../db': { audit() {} },
    '../meetings': { archiveMeeting() {}, readMeetingNotes() {} }
  })
  const gateway = mod.createSlack(() => {})
  const { deliver } = await loadModule('src/main/gateways/index.ts', {
    './slack': { createSlack: () => gateway },
    './imessage': { createIMessage: () => ({ name: 'imessage' }) },
    '../config': { cfg: () => config },
    '../bus': { bus: new EventEmitter() }
  })
  await gateway.start()
  assert.equal(gateway.status.state, 'running')
  t.after(() => gateway.stop())
  // Exercise the real retry loops without waiting minutes for their backoff.
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => {
    waits.push(delay)
    return setImmediate(fn, ...args)
  })
  return {
    gateway, clients, options, waits,
    send: text => deliver('slack', 'C123:100.1', text),
    reply: async (text, event = {}) => {
      await handlers.app_mention({ event: { user: 'U0OWNER123', channel: 'C123', ts: `${100 + eventNumber++}.1`, text: 'hello', ...event } })
      return inbound.reply(text)
    }
  }
}

test('proactive Slack delivery retries only the rejected chunk', async t => {
  const accepted = [], attempts = []
  let rejected = false
  const f = await fixture(t, async args => {
    attempts.push(args)
    if (args.text === second && !rejected) { rejected = true; throw new WebAPIRateLimitedError(8) }
    accepted.push(args.text)
    return { ok: true }
  })
  await f.send(message)
  assert.deepEqual(accepted, [first, second], 'acknowledged chunks must not be replayed by deliver()')
  assert.deepEqual(attempts.map(a => a.text), [first, second, second])
  assert.ok(attempts.every(a => a.channel === 'C123' && a.thread_ts === '100.1'))
  assert.ok(f.waits.some(delay => delay >= 8000), 'honor Slack Retry-After before retrying')
})

for (const path of ['send', 'reply']) {
  test(`Slack ${path} recovers a rejected chunk without replaying earlier chunks`, async t => {
    const accepted = []
    let rejected = false
    const f = await fixture(t, async args => {
      if (args.text === second && !rejected) {
        rejected = true
        throw new WebAPIPlatformError({ ok: false, error: 'not_in_channel' })
      }
      accepted.push(args.text)
      return { ok: true }
    })
    await f[path](message)
    assert.deepEqual(accepted, [first, second])
  })

  test(`Slack ${path} stops outer retries when a later chunk exhausts safe retries`, async t => {
    const accepted = [], attempts = []
    const f = await fixture(t, async args => {
      attempts.push(args.text)
      if (args.text === second) throw refused()
      accepted.push(args.text)
      return { ok: true }
    })
    await assert.rejects(f[path](message), err => err.noRetry === true, 'partial delivery must stop whole-message retries')
    assert.deepEqual(accepted, [first])
    assert.equal(attempts.filter(text => text === second).length, path === 'send' ? 6 : 5)
  })

  test(`Slack ${path} never retries ambiguous errors, including an accepted first chunk`, async t => {
    const failures = [
      new WebAPIRequestError(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })),
      new WebAPIRequestError(new DOMException('timeout', 'TimeoutError')),
      new WebAPIHTTPError(503, 'Unavailable', {}),
      new WebAPIPlatformError({ ok: false, error: 'internal_error' }),
      new WebAPIPlatformError({ ok: false, error: 'fatal_error' }),
      new Error('response could not be parsed')
    ]
    let failure, calls = 0
    const f = await fixture(t, async () => { calls++; throw failure })
    for (const err of failures) {
      failure = err
      const before = calls
      await assert.rejects(f[path](message), e => e.noRetry === true)
      assert.equal(calls - before, 1, 'no resend after a potentially accepted POST')
    }
  })

  test(`Slack ${path} retries a never-connected first chunk safely`, async t => {
    const accepted = []
    let calls = 0
    const f = await fixture(t, async args => {
      if (++calls === 1) throw refused()
      accepted.push(args.text)
      return { ok: true }
    })
    await f[path](message)
    assert.equal(calls, 3)
    assert.deepEqual(accepted, [first, second])
  })

  test(`Slack ${path} stops on an ambiguous later chunk without resending either chunk`, async t => {
    const attempts = []
    const f = await fixture(t, async args => {
      attempts.push(args.text)
      if (args.text === second) throw new WebAPIRequestError(new Error('connection lost after POST'))
      return { ok: true }
    })
    await assert.rejects(f[path](message), err => err.noRetry === true)
    assert.deepEqual(attempts, [first, second])
  })
}

test('proactive retries reacquire the client after a mid-message reconnect', async t => {
  const accepted = []
  let f
  f = await fixture(t, async args => {
    if (args.text === first) { accepted.push(args.text); return { ok: true } }
    await f.gateway.stop()
    await f.gateway.start()
    f.clients.at(-1).chat.postMessage = async args => { accepted.push(args.text); return { ok: true } }
    throw refused()
  })
  await f.send(message)
  assert.deepEqual(accepted, [first, second])
})

test('Slack retries use the reconnected client and preserve reply routing and formatting', async t => {
  const accepted = []
  let f
  f = await fixture(t, async () => {
    await f.gateway.stop()
    await f.gateway.start()
    f.clients.at(-1).chat.postMessage = async args => { accepted.push(args); return { ok: true } }
    throw refused()
  })
  await f.reply('**hi** & <there>', { thread_ts: '99.9' })
  assert.deepEqual(accepted, [{ channel: 'C123', thread_ts: '99.9', text: '*hi* &amp; &lt;there&gt;' }])
  accepted.length = 0
  await f.reply('DM', { channel: 'D123', channel_type: 'im', ts: '101.1' })
  assert.deepEqual(accepted, [{ channel: 'D123', thread_ts: undefined, text: 'DM' }])
})

test('the real Slack SDK cannot invisibly retry an ambiguous POST', async t => {
  let calls = 0
  const f = await fixture(t, async () => {
    calls++
    throw Object.assign(new Error('socket reset after Slack accepted the POST'), { code: 'ECONNRESET' })
  }, true)
  const error = await f.send('hello').then(() => assert.fail('expected an uncertain send'), err => err)
  assert.equal(calls, 1, 'SDK retries must be disabled as well as gateway retries')
  assert.equal(error.noRetry, true)
  assert.equal(f.options[0].clientOptions.rejectRateLimitedCalls, true)
})
