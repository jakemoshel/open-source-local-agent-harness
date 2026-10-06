import type { BrowserWindow } from 'electron'

/** Recover only the renderer that failed, never a replacement window opened during the delay. */
export function recoverRenderer(window: BrowserWindow, quitting: () => boolean, report: (detail: string) => void): void {
  window.webContents.on('render-process-gone', (_event, detail) => {
    report(`${detail.reason} (exit ${detail.exitCode})`)
    if (detail.reason === 'clean-exit') return
    setTimeout(() => {
      if (!quitting() && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.reload()
    }, 1000).unref()
  })
}
