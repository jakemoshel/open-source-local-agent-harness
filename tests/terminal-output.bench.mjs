import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { loadModule } from './load-module.mjs'

const { cleanOutput } = await loadModule('src/main/terminal.ts', {
  './config': { defaultCwd: () => process.cwd() },
  './env': { agentEnv: () => ({}) },
  './paths': { expandHome: x => x }
})

// A single backspace-heavy line, within the terminal's 512 KiB buffer limit.
const raw = '\x1b[32m' + 'ab\b'.repeat(50_000) + 'ready\x1b[0m \t\r\n'
const expected = 'a'.repeat(50_000) + 'ready\n'
for (let i = 0; i < 5; i++) cleanOutput('ab\b'.repeat(1_000))
const samples = []
for (let i = 0; i < 5; i++) {
  const start = performance.now()
  const output = cleanOutput(raw)
  samples.push(performance.now() - start)
  assert.equal(output, expected)
}
samples.sort((a, b) => a - b)
console.log(JSON.stringify({ value: samples[2], lowerIsBetter: true }))
