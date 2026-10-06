import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { loadModule } from './load-module.mjs'

test('Claude preserves usage-limit details and assistant error codes for recovery', async () => {
  let messages = []
  const { claudeProvider } = await loadModule('src/main/providers/claude.ts', {
    '@anthropic-ai/claude-agent-sdk': {
      query: () => ({ async *[Symbol.asyncIterator]() { yield* messages }, close() {} }),
      createSdkMcpServer: (s) => s, tool: () => ({})
    },
    '../auth': { claudeBinary: () => '/unused' },
    '../config': { cfg: () => ({ providers: { claude: {} }, timezone: 'UTC' }), files: { safeguards: { value: { approvalTimeoutSec: 1 } } } },
    '../harness-tools': { HARNESS_TOOL_DEFS: [{ name: 'ops' }, { name: 'call' }], runHarnessTool() {} }
  })
  const opts = { cwd: process.cwd(), context: '', prompt: 'hello', env: {}, mcpServers: {}, signal: new AbortController().signal, steering: { register() {}, async close() {} } }
  const failed = { type: 'result', subtype: 'error_during_execution', usage: { input_tokens: 0, output_tokens: 0 }, num_turns: 0, errors: ['You have hit your usage limit'] }
  messages = [failed]
  let events = await Array.fromAsync(claudeProvider.run(opts))
  assert.match(events.at(-1).error, /hit your usage limit/)
  messages = [{ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'Try later' }] } }, { ...failed, errors: [] }]
  events = await Array.fromAsync(claudeProvider.run(opts))
  assert.match(events.at(-1).error, /rate_limit: Try later/)
})

test('restart falls back to opening the app when launchctl kickstart fails', async () => {
  const { START_JARVIS_SH } = await loadModule('src/main/system.ts', {
    electron: { app: {}, systemPreferences: {} }, './config': { cfg() {}, files: {} },
    './db': { audit() {} }, './paths': { expandHome: (p) => p, loginEnv: () => ({}), paths: {} }
  })
  const script = `launchctl() { if [ "$1" = print ]; then return 0; fi; return 1; }
open() { printf '%s\\n' "$@"; }
${START_JARVIS_SH}
start_jarvis '/Applications/Mac Mini Jarvis.app'`
  assert.equal(execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8' }), '-g\n-a\n/Applications/Mac Mini Jarvis.app\n--args\n--hidden\n')
})
