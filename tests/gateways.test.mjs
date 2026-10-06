import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { loadModule, deferred, tick } from './load-module.mjs'

function fakeGateway(name, log, startImpl = async () => {}) {
  const gw = {
    name,
    status: { name, enabled: false, state: 'stopped', detail: '', lastMessageAt: null },
    async start() { log.push(`${name}:start`); await startImpl(); gw.status = { ...gw.status, state: 'running' } },
    async stop() { log.push(`${name}:stop`); gw.status = { ...gw.status, state: 'stopped' } },
    async send() {}
  }
  return gw
}

async function loadGateways(conf, slackStart) {
  const log = [], bus = new EventEmitter()
  const m = await loadModule('src/main/gateways/index.ts', {
    '../profile-context': { isOwner: () => true, OWNER_ID: 'owner', withProfile: (_, fn) => fn() },
    '../bus': { bus },
    '../config': { cfg: () => ({ gateways: conf }) },
    './slack': { createSlack: () => fakeGateway('slack', log, slackStart) },
    './imessage': { createIMessage: () => fakeGateway('imessage', log) }
  })
  return { m, log, bus }
}

test('a Slack start that never settles holds up neither iMessage nor shutdown of iMessage', async () => {
  const hang = deferred()
  const conf = { slack: { enabled: true }, imessage: { enabled: true, backend: 'bluebubbles' } }
  const { m, log } = await loadGateways(conf, () => hang.promise)
  m.startGateways()
  for (let i = 0; i < 10; i++) await tick()
  assert.ok(log.includes('imessage:start'), 'iMessage starts while Slack is still connecting')
  assert.equal(m.gatewayStatuses().find((g) => g.name === 'imessage').state, 'running')
  const stopping = m.stopGateways()
  for (let i = 0; i < 10; i++) await tick()
  assert.equal(log.filter((l) => l === 'imessage:stop').length, 2)
  hang.resolve()
  await stopping
})

test('changing one gateway setting restarts only that gateway', async () => {
  const conf = { slack: { enabled: true }, imessage: { enabled: true, backend: 'bluebubbles', pollMs: 1000 } }
  const { m, log, bus } = await loadGateways(conf)
  m.startGateways()
  for (let i = 0; i < 10; i++) await tick()
  log.length = 0
  conf.slack.enabled = false
  bus.emit('config:changed', 'config')
  for (let i = 0; i < 10; i++) await tick()
  assert.deepEqual(log, ['slack:stop'])
  await m.stopGateways()
})

test('Slack start gives up when Socket Mode never connects and closes the late connection', async () => {
  const realSetTimeout = globalThis.setTimeout
  // Fire the 45s connect timeout immediately; everything else keeps real timing.
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 45_000 ? 0 : ms, ...rest)
  const connect = deferred(), apps = []
  class App {
    constructor() { this.stopped = 0; this.client = { auth: { test: async () => ({ user_id: 'B1', user: 'jarvis', team: 'T' }) } }; apps.push(this) }
    event() {}
    message() {}
    start() { return connect.promise }
    async stop() { this.stopped++ }
  }
  try {
    const m = await loadModule('src/main/gateways/slack.ts', {
      '@slack/bolt': { App, LogLevel: { ERROR: 'error' } },
      '../config': { cfg: () => ({ gateways: { slack: { enabled: true, meetingChannels: [] } } }) },
      '../env': { readEnvFile: () => ({ SLACK_BOT_TOKEN: 'xoxb', SLACK_APP_TOKEN: 'xapp' }) },
      '../db': { audit() {} },
      '../meetings': { archiveMeeting() {}, readMeetingNotes() {} },
      './commands': { handleInbound() {} },
      '../profiles': { profileForSender() {} }
    })
    const gw = m.createSlack(() => {})
    await gw.start()
    assert.equal(gw.status.state, 'error')
    assert.match(gw.status.detail, /Timed out/)
    await gw.stop()
    const stopsBefore = apps[0].stopped
    connect.resolve()
    await tick()
    assert.equal(apps[0].stopped, stopsBefore + 1, 'a connection that opens after being replaced is closed')
  } finally { globalThis.setTimeout = realSetTimeout }
})
