import { startScheduleNotifications, stopScheduleNotifications } from './schedule-notifications'
import { loadProfiles, allProfiles, profilesRecovered } from './profiles'
import { recoverInterruptedRuns } from './recovery'
import { recordFault } from './faults'
import { initializeProfile, forEachProfile, pruneProfileEvents } from './profile-runtime'
import { isOwner, profileId } from './profile-context'
import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, shell, Tray, type IpcMainInvokeEvent } from 'electron'
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Approval } from '@shared/types'
import { bus, type BusChannel } from './bus'
import { cfg, loadAll } from './config'
import { initializeContextStore } from './context-store'
import { initializeToolLibrary } from './harness-tools'
import { startControlServer, stopControlServer } from './control'
import { audit, getRun, openDb, pruneEvents } from './db'
import { blockedInProcessEnv } from './env'
import { restartFailedGateways, startGateways, stopGateways } from './gateways'
import { initApprovalPrompts } from './gateways/approvals'
import { invoke, opInfos } from './ops'
import { ensureDirs, paths } from './paths'
import { activeRunIds, cancelAll } from './runs'
import { stopMcpShare } from './mcp-share'
import { catchUpSchedules, startScheduler, stopScheduler } from './scheduler'
import { startLearning, stopLearning } from './learning'
import { startImprovementMemory } from './improvement'
import { startRsiMetrics } from './rsi-metrics'
import { startSelfRepair } from './self-repair'
import { startAuthWatch } from './auth'
import { syncKeepAlive } from './system'
import { closeAllTerminals } from './terminal'
import { loginsBusyForUpdate, stopAllLogins } from './provider-login'
import { recoverRenderer } from './window-recovery'
import { applyUpdate, checkForUpdates, getUpdateStatus, markHealthy, startUpdater, stopUpdater } from './updater'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let shutdownStarted = false

/** Clean exits are not crashes. Keep enough evidence to distinguish window closes, quits and update restarts. */
function logLifecycle(detail: string): void {
  try {
    appendFileSync(join(app.getPath('logs'), 'main.log'), `[${new Date().toISOString()}] lifecycle: ${detail}\n`)
    audit('system', 'system', detail)
  } catch { /* Diagnostics must never cause a shutdown or startup failure. */ }
}

function logError(label: string, err: unknown): void {
  try {
    const file = join(app.getPath('logs'), 'main.log')
    // Keep one rotated copy so a noisy failure can't fill the disk on a machine that never restarts.
    if (existsSync(file) && statSync(file).size > 5 * 1024 ** 2) renameSync(file, `${file}.1`)
    appendFileSync(file, `[${new Date().toISOString()}] ${label}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  } catch {
    return
  }
  // The renderer reports its own exit reasons (OOM, killed); those aren't harness code faults.
  if (label !== 'renderer') recordFault({ source: label === 'uncaughtException' ? 'crash' : label === 'unhandledRejection' ? 'rejection' : label, error: err })
}

/** Optional subsystems start independently: one failing must not take the rest of Jarvis down into a crash loop. */
function step(label: string, fn: () => unknown): void {
  try {
    const out = fn()
    if (out instanceof Promise) out.catch((err) => logError(`startup:${label}`, err))
  } catch (err) {
    logError(`startup:${label}`, err)
  }
}

process.on('uncaughtException', (err) => logError('uncaughtException', err))
process.on('unhandledRejection', (err) => logError('unhandledRejection', err))

// A second copy (login item + LaunchAgent, or a double-click) must never run gateways twice.
if (!app.requestSingleInstanceLock()) app.exit(0)

// Jarvis is a mostly-headless service: skip the GPU process and spellchecker to keep memory low.
app.disableHardwareAcceleration()

const ALLOWED_EXTERNAL = new Set(['https:', 'http:', 'mailto:'])

function openExternalSafely(url: string): void {
  try {
    if (ALLOWED_EXTERNAL.has(new URL(url).protocol)) void shell.openExternal(url)
  } catch {
    return
  }
}

function isAppUrl(url: string): boolean {
  if (process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)) return true
  // Compare as URLs: the packaged path contains spaces, which appear percent-encoded in the page URL.
  return url.startsWith(pathToFileURL(join(import.meta.dirname, '../renderer')).href + '/')
}

/** Only our own renderer may call ops; a navigated or embedded page must not reach the harness API. */
function trusted(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  return e.senderFrame === e.sender.mainFrame && isAppUrl(url)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    // Matches the page background so the window never flashes a different colour while loading.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0e0c' : '#f7f7f5',
    vibrancy: undefined,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  recoverRenderer(win, () => quitting, (detail) => logError('renderer', detail))
  win.on('close', () => {
    if (quitting) return
    if (cfg().ui.keepRunningInTray) {
      logLifecycle('Window closed; Jarvis remains running in the tray')
      app.dock?.hide()
    }
    else {
      quitting = true
      app.quit()
    }
  })
  win.on('closed', () => (win = null))
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
  // Links in agent output (which can quote untrusted messages or web pages) open in the browser, never in this window.
  win.webContents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return
    e.preventDefault()
    openExternalSafely(url)
  })
  win.webContents.on('will-redirect', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}

function showWindow(path?: string): void {
  if (!win) createWindow()
  void app.dock?.show()
  win!.show()
  win!.focus()
  if (path) win!.webContents.send('navigate', path)
}

function updateTray(): void {
  if (!tray) return
  const n = activeRunIds().length
  tray.setTitle(n ? ` ${n}` : '')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: n ? `${n} run${n === 1 ? '' : 's'} active` : 'Idle', enabled: false },
      { type: 'separator' },
      { label: 'Open Mac Mini Jarvis', click: () => showWindow() },
      { label: 'New run…', click: () => showWindow('/runs?new=1') },
      { label: 'Open harness folder', click: () => void shell.openPath(paths.home) },
      { type: 'separator' },
      updateMenuItem(),
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

function updateMenuItem(): Electron.MenuItemConstructorOptions {
  const u = getUpdateStatus()
  if (u.state === 'unsupported') return { label: 'Updates: development build', enabled: false }
  if (u.state === 'building' || u.state === 'installing' || u.state === 'checking') return { label: u.message ?? 'Updating…', enabled: false }
  if (u.state === 'available') return { label: `Install update (${u.behind.length} change${u.behind.length === 1 ? '' : 's'})`, click: () => void applyUpdate({ actor: 'user' }) }
  return { label: 'Check for updates', click: () => void checkForUpdates() }
}

function send(channel: BusChannel, payload: unknown, profile: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send('bus', channel, payload, profile)
    } catch {
      // A renderer that is reloading misses one event; it refetches on mount.
    }
  }
}

/**
 * Token deltas arrive dozens of times a second per run; one IPC message each made the renderer re-render per token.
 * They are merged per run and flushed every DELTA_FLUSH_MS, and always before that run's next event or update so
 * the renderer never sees text after the event that replaced it.
 */
const DELTA_FLUSH_MS = 40
const pendingDeltas = new Map<string, { text: string; profile: string }>()
let deltaTimer: NodeJS.Timeout | null = null
function flushDeltas(runId?: string): void {
  for (const [id, d] of runId ? [[runId, pendingDeltas.get(runId)] as const] : [...pendingDeltas]) {
    if (!d) continue
    pendingDeltas.delete(id)
    send('run:delta', { runId: id, text: d.text }, d.profile)
  }
  if (!pendingDeltas.size && deltaTimer) { clearTimeout(deltaTimer); deltaTimer = null }
}

function forward(channel: BusChannel): void {
  if (channel === 'run:delta') {
    bus.on(channel, ({ runId, text }: { runId: string; text: string }) => {
      if (!BrowserWindow.getAllWindows().length) return
      const d = pendingDeltas.get(runId)
      if (d) d.text += text
      else pendingDeltas.set(runId, { text, profile: profileId() })
      deltaTimer ??= setTimeout(() => { deltaTimer = null; flushDeltas() }, DELTA_FLUSH_MS)
    })
    return
  }
  bus.on(channel, (payload) => {
    const runId = channel === 'run:event' ? (payload as { runId?: string })?.runId : channel === 'run:update' ? (payload as { id?: string })?.id : undefined
    if (runId && pendingDeltas.has(runId)) flushDeltas(runId)
    send(channel, payload, profileId())
  })
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Open Mac Mini Jarvis', accelerator: 'CommandOrControl+O', click: () => showWindow() },
      { type: 'separator' }, { role: 'quit' }
    ] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }
  ]))
  ensureDirs()
  openDb()
  loadAll()
  loadProfiles({ slack: cfg().gateways.slack.allowedUsers, handles: cfg().gateways.imessage.allowedHandles })
  logLifecycle(`Jarvis started; pid=${process.pid}`)
  if (profilesRecovered) step('profiles-audit', () => audit('system', 'system', profilesRecovered!))
  step('prune', () => pruneEvents(cfg().retentionDays))

  const blocked = blockedInProcessEnv()
  if (blocked.length) console.warn(`[jarvis] Stripping billing credentials from agent env: ${blocked.join(', ')}`)

  ipcMain.handle('ops:invoke', async (e, name: string, args: unknown) => {
    if (!trusted(e)) return { ok: false, error: 'Untrusted sender' }
    try {
      return { ok: true, result: await invoke(name, args, { actor: 'user' }) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('ops:list', (e) => (trusted(e) ? opInfos() : []))
  ipcMain.handle('shell:open', (e, target: string) => (trusted(e) && typeof target === 'string' && target.startsWith('/') ? shell.openPath(target) : 'Refused'))
  ipcMain.handle('shell:reveal', (e, target: string) => {
    if (trusted(e) && typeof target === 'string' && target.startsWith('/')) shell.showItemInFolder(target)
  })

  for (const c of ['run:update', 'run:event', 'run:delta', 'approval:update', 'config:changed', 'gateway:update', 'audit:new', 'update:status'] as BusChannel[]) forward(c)
  bus.on('update:status', () => updateTray())

  bus.on('approval:update', (a: Approval) => {
    if (a.status !== 'pending') return
    const run = getRun(a.runId)
    const n = new Notification({ title: 'Approval needed', body: `${a.tool} · ${run?.title ?? a.runId}`, silent: false })
    n.on('click', () => showWindow(`/runs/${a.runId}`))
    n.show()
  })
  bus.on('run:update', updateTray)

  step('linked-memory', initializeContextStore)
  step('tool-library', initializeToolLibrary)
  step('control', startControlServer)
  step('scheduler', startScheduler)
  for (const p of allProfiles()) if (p.id !== 'owner') step(`profile:${p.id}`, () => initializeProfile(p.id))
  step('approval-prompts', initApprovalPrompts)
  step('gateways', startGateways)
  step('schedule-notifications', () => startScheduleNotifications(id => showWindow(`/runs/${id}`)))
  step('learning', startLearning)
  step('improvement-memory', startImprovementMemory)
  step('rsi-metrics', startRsiMetrics)
  step('self-repair', startSelfRepair)
  step('auth', startAuthWatch)
  step('keepalive', () => syncKeepAlive())
  step('updater', startUpdater)
  step('health', markHealthy)
  // Give gateways a moment to connect; replies retry for several minutes anyway.
  setTimeout(() => step('recovery', recoverInterruptedRuns), 15_000).unref()

  // Keep old event payloads from growing the database on a machine that never restarts.
  setInterval(() => step('prune', pruneProfileEvents), 24 * 3600_000).unref()

  // After sleep, a network change or a power-outage boot, gateways may have failed while the network or
  // BlueBubbles was still coming up, and cron slots may have passed. Recover both.
  powerMonitor.on('resume', () => {
    setTimeout(() => {
      step('resume:gateways', restartFailedGateways)
      step('resume:schedules', () => forEachProfile(catchUpSchedules))
    }, 30_000)
  })

  const trayIconPath = app.isPackaged ? join(process.resourcesPath, 'trayTemplate@2x.png') : join(import.meta.dirname, '../../resources/trayTemplate@2x.png')
  const icon = existsSync(trayIconPath) ? nativeImage.createFromBuffer(readFileSync(trayIconPath), { scaleFactor: 2 }) : nativeImage.createEmpty()
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Mac Mini Jarvis')
  updateTray()

  nativeTheme.themeSource = cfg().ui.theme
  bus.on('config:changed', (k: string) => {
    if (k !== 'config' || !isOwner()) return
    void syncKeepAlive()
    nativeTheme.themeSource = cfg().ui.theme
  })

  const hidden = app.getLoginItemSettings().wasOpenedAtLogin || process.argv.includes('--hidden')
  if (!hidden) createWindow()
  else app.dock?.hide()
}).catch((err) => {
  logError('startup', err)
  app.exit(1)
})

app.on('second-instance', () => showWindow())
app.on('activate', () => showWindow())
app.on('before-quit', () => {
  if (shutdownStarted) return
  shutdownStarted = true
  logLifecycle(`Jarvis quitting; pid=${process.pid}, updatePhase=${getUpdateStatus().phase ?? 'none'}, activeRuns=${activeRunIds().length}, pendingLogin=${loginsBusyForUpdate()}`)
  quitting = true
  for (const [label, fn] of [['schedule-notifications', stopScheduleNotifications], ['runs', cancelAll], ['scheduler', stopScheduler], ['learning', stopLearning], ['updater', stopUpdater], ['gateways', stopGateways], ['control', stopControlServer], ['terminals', closeAllTerminals], ['logins', stopAllLogins], ['mcp-share', stopMcpShare]] as const) step(`quit:${label}`, fn)
})
app.on('window-all-closed', () => undefined)
