#!/usr/bin/env node
// Jarvis diagnostics from a terminal (works over SSH):
//   npm run doctor            full report from the running app
//   npm run doctor -- --fix   also retry gateways, reinstall the LaunchAgent, run missed schedules
//   npm run doctor -- --json  machine-readable report
// When Jarvis is not running, reports why it might be down instead.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

const LABEL = 'com.macminijarvis.app'
const HOME = process.env.JARVIS_HOME ?? join(homedir(), '.jarvis')
const direct = join(HOME, 'control.sock')
const SOCKET = Buffer.byteLength(direct) < 100 ? direct : join(tmpdir(), `jarvis-${createHash('sha1').update(HOME).digest('hex').slice(0, 10)}.sock`)
const fix = process.argv.includes('--fix')
const json = process.argv.includes('--json')

function ask() {
  return new Promise((resolve, reject) => {
    const s = createConnection(SOCKET)
    let buf = ''
    const timer = setTimeout(() => {
      s.destroy()
      reject(new Error('Jarvis did not answer within 120s'))
    }, 120_000)
    s.setEncoding('utf8')
    s.on('connect', () => s.write(JSON.stringify({ id: 1, op: '__doctor', args: { fix, json } }) + '\n'))
    s.on('data', (c) => {
      buf += c
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      clearTimeout(timer)
      s.end()
      const msg = JSON.parse(buf.slice(0, nl))
      msg.error ? reject(new Error(msg.error)) : resolve(msg.result)
    })
    s.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
  } catch {
    return null
  }
}

function offline(reason) {
  const lines = [`JARVIS diagnostics — offline (${reason})`, '']
  const app = '/Applications/Mac Mini Jarvis.app'
  lines.push(existsSync(app) ? `✓ Installed  ${app}` : `✗ Not installed in /Applications\n    → npm run dist, then drag the app into /Applications`)
  const plist = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`)
  const job = sh('/bin/launchctl', ['print', `gui/${userInfo().uid}/${LABEL}`])
  if (!existsSync(plist)) lines.push('! No startup LaunchAgent\n    → open the app once; Settings → System → Run as a macOS startup service')
  else if (!job) lines.push(`✗ LaunchAgent not loaded\n    → launchctl bootstrap gui/$(id -u) ${plist}`)
  else {
    const exit = /last exit code = (-?\d+)/.exec(job)?.[1]
    lines.push(`✗ LaunchAgent loaded but Jarvis is not running${exit ? ` (last exit ${exit})` : ''}\n    → launchctl kickstart -k gui/$(id -u)/${LABEL}`)
  }
  const log = join(homedir(), 'Library/Logs/Mac Mini Jarvis/main.log')
  if (existsSync(log)) {
    const tail = readFileSync(log, 'utf8').trim().split('\n').slice(-8)
    if (tail.length) lines.push('', `Last lines of ${log}:`, ...tail.map((l) => `    ${l}`))
  }
  const install = join(HOME, 'data/jobs/updater.log')
  if (existsSync(install)) lines.push('', `Last update log (${install}):`, ...readFileSync(install, 'utf8').trim().split('\n').slice(-5).map((l) => `    ${l}`))
  return lines.join('\n')
}

try {
  const result = await ask()
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
  if (typeof result === 'string' ? /systems? down/.test(result.split('\n')[0]) : result.checks.some((c) => c.status === 'fail')) process.exitCode = 1
} catch (err) {
  console.log(offline(err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? 'Jarvis is not running' : err.message))
  process.exitCode = 2
}
