import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { loadModule } from './load-module.mjs'

for (const outcome of ['live', 'closed', 'contents-destroyed', 'quitting', 'clean-exit']) {
  test(`renderer recovery: ${outcome}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { recoverRenderer } = await loadModule('src/main/window-recovery.ts')
    const contents = new EventEmitter()
    let reloads = 0, closed = false, destroyed = false, quitting = false
    contents.isDestroyed = () => destroyed
    contents.reload = () => reloads++
    const window = { webContents: contents, isDestroyed: () => closed }
    const reports = []
    recoverRenderer(window, () => quitting, detail => reports.push(detail))
    contents.emit('render-process-gone', {}, { reason: outcome === 'clean-exit' ? 'clean-exit' : 'crashed', exitCode: 1 })
    closed = outcome === 'closed'
    destroyed = outcome === 'contents-destroyed'
    quitting = outcome === 'quitting'
    t.mock.timers.tick(1000)
    assert.equal(reloads, outcome === 'live' ? 1 : 0)
    assert.equal(reports.length, 1)
  })
}
