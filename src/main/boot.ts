import { app, dialog } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

try {
  await import('./index.js')
} catch (err) {
  const dir = app.getPath('logs')
  mkdirSync(dir, { recursive: true })
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
  appendFileSync(join(dir, 'main.log'), `[${new Date().toISOString()}] startup failed\n${text}\n`)
  await app.whenReady()
  dialog.showErrorBox('Mac Mini Jarvis could not start', `${text}\n\nLog: ${join(dir, 'main.log')}`)
  app.exit(1)
}
