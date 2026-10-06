import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { loadModule } from './load-module.mjs'

const entry = { command: process.execPath, args: [resolve('tests/fixtures/echo-mcp.mjs')] }

async function connect(e) {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(e.url), { requestInit: { headers: e.headers } }))
  return client
}

test('agents share one stdio MCP server process over localhost', async () => {
  const share = await loadModule('src/main/mcp-share.ts')
  try {
    assert.equal(share.shareable(entry), true)
    assert.equal(share.shareable({ ...entry, shared: false }), false)
    assert.equal(share.shareable({ url: 'https://x' }), false)
    const e = await share.sharedEntry('echo', entry, { PATH: process.env.PATH }, process.cwd())
    assert.equal(e.type, 'http')
    const [a, b] = await Promise.all([connect(e), connect(e)])
    assert.deepEqual((await a.listTools()).tools.map((t) => t.name), ['echo'])
    const [ra, rb] = await Promise.all([a.callTool({ name: 'echo', arguments: { text: 'a' } }), b.callTool({ name: 'echo', arguments: { text: 'b' } })])
    const pid = (r) => r.content[0].text.split(' from ')[1]
    assert.equal(ra.content[0].text.split(' from ')[0], 'a')
    assert.equal(pid(ra), pid(rb), 'both sessions reached the same server process')
    const progress = []
    for (let i = 0; i < 20; i++) await a.callTool({ name: 'echo', arguments: { text: 'progress' } }, undefined, { onprogress: p => progress.push(p) })
    assert.equal(progress.length, 20, 'tool progress reaches the requesting client')
    assert.equal(progress[0].progress, 1)
    assert.deepEqual(share.mcpShareStatus(), [{ name: 'echo', running: true, sessions: 2 }])
    // New configurations must not change the process or credentials used by existing runs.
    const changed = await share.sharedEntry('echo', { ...entry, env: { X: '1' } }, { PATH: process.env.PATH }, process.cwd())
    assert.notEqual(changed.url, e.url)
    const c = await connect(changed)
    const rc = await a.callTool({ name: 'echo', arguments: { text: 'c' } })
    assert.equal(pid(rc), pid(ra))
    assert.notEqual(pid(await c.callTool({ name: 'echo', arguments: { text: 'changed' } })), pid(ra))
    // Wrong token is refused.
    await assert.rejects(connect({ ...e, headers: { Authorization: 'Bearer nope' } }))
    await Promise.all([a.close(), b.close(), c.close()])
  } finally {
    share.stopMcpShare()
  }
})

test('shutdown during stdio startup closes the child and never resurrects it', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { setTimeout: delay } = await import('node:timers/promises')
  const dir = await mkdtemp(resolve(tmpdir(), 'jarvis-mcp-startup-'))
  const marker = resolve(dir, 'pid')
  const share = await loadModule('src/main/mcp-share.ts')
  let pid, outcome
  try {
    const e = await share.sharedEntry('slow', { ...entry, env: { STARTUP_MARKER: marker } }, { PATH: process.env.PATH }, process.cwd())
    // Attach rejection handling immediately: stopping the proxy also closes its HTTP socket.
    outcome = connect(e).then(client => ({ client }), error => ({ error }))
    for (let i = 0; i < 200; i++) {
      const text = await readFile(marker, 'utf8').catch(() => null)
      if (text) { pid = Number(text); break }
      await delay(10)
    }
    assert.ok(pid, 'the child reached its delayed startup')
    share.stopMcpShare()
    const result = await outcome
    await result.client?.close()
    assert.ok(result.error, 'initialization is rejected when the app shuts down')
    for (let i = 0; i < 200; i++) {
      try { process.kill(pid, 0) } catch { pid = null; break }
      await delay(10)
    }
    assert.equal(pid, null, 'no orphaned stdio process')
    assert.deepEqual(share.mcpShareStatus(), [])
  } finally {
    share.stopMcpShare()
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
    await rm(dir, { recursive: true, force: true })
  }
})
