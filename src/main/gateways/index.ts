import { isOwner, OWNER_ID, withProfile } from '../profile-context'
import type { GatewayStatus } from '@shared/types'
import { bus } from '../bus'
import { cfg } from '../config'
import { createIMessage } from './imessage'
import { createSlack } from './slack'
import { withRetry, type Gateway } from './types'

type Name = GatewayStatus['name']

const emit = () => bus.emit('gateway:update', gatewayStatuses())

const gateways: Record<Name, Gateway> = {
  slack: createSlack(emit),
  imessage: createIMessage(emit)
}
const names = Object.keys(gateways) as Name[]

/**
 * One queue per gateway: start/stop calls overlap when config changes quickly, so each gateway runs them one at a
 * time, but a gateway that is slow to connect (Slack retrying with no network) must never hold up the other one
 * or shutdown of the other one.
 */
const chains: Record<Name, Promise<unknown>> = { slack: Promise.resolve(), imessage: Promise.resolve() }
const lastSig: Record<Name, string> = { slack: '', imessage: '' }
const failures: Record<Name, number> = { slack: 0, imessage: 0 }
let watchdog: NodeJS.Timeout | null = null
let stopped = true
let listening = false

function serial<T>(name: Name, fn: () => Promise<T>): Promise<T> {
  const next = chains[name].then(fn, fn)
  chains[name] = next.catch(() => undefined)
  return next
}

/** Settings that require a restart of that one gateway; toggling Slack must not drop iMessage's webhook. */
function signature(name: Name): string {
  const g = cfg().gateways
  return name === 'slack'
    ? JSON.stringify([g.slack.enabled])
    : JSON.stringify([g.imessage.enabled, g.imessage.backend, g.imessage.pollMs, g.imessage.webhookPort, g.imessage.webhookHost, g.imessage.webhookPath])
}

function restart(name: Name): Promise<void> {
  return serial(name, async () => {
    const gw = gateways[name]
    await gw.stop()
    if (cfg().gateways[name].enabled) await gw.start()
  })
}

function syncGateways(force = false): Promise<void> {
  return Promise.all(names.map((name) => {
    const sig = signature(name)
    if (!force && sig === lastSig[name]) return undefined
    lastSig[name] = sig
    return restart(name)
  })).then(() => undefined)
}

export async function restartGateway(name: Name): Promise<GatewayStatus> {
  await restart(name)
  return gateways[name].status
}

/** Retry enabled gateways that ended in an error state (no network yet, BlueBubbles still launching). */
export function restartFailedGateways(): Promise<void> {
  return Promise.all(names.map((name) => serial(name, async () => {
    const gw = gateways[name]
    if (!cfg().gateways[name].enabled || gw.status.state !== 'error') {
      failures[name] = 0
      return
    }
    await gw.stop()
    await gw.start()
    failures[name] = gw.status.state === 'error' ? failures[name] + 1 : 0
  }))).then(() => undefined)
}

function scheduleWatchdog(): void {
  if (stopped) return
  // Back off from 30s to 2 minutes while a gateway keeps failing: a retry is one cheap request, and messages
  // wait (BlueBubbles catch-up only runs while the gateway is up) for as long as the delay.
  const worst = Math.max(0, ...Object.values(failures))
  const delay = Math.min(2 * 60_000, 30_000 * 2 ** Math.min(worst, 2))
  watchdog = setTimeout(() => void restartFailedGateways().catch((err) => console.error('[jarvis] gateway recovery failed:', err)).finally(scheduleWatchdog), delay)
  watchdog.unref()
}

export function gatewayStatuses(): GatewayStatus[] {
  const conf = cfg().gateways
  return names.map((name) => ({ ...gateways[name].status, enabled: conf[name].enabled }))
}

/** Proactive messages (schedules, recovered runs) wait out a gateway reconnect for a few minutes before giving up. */
export async function deliver(name: Name, target: string, text: string): Promise<void> {
  await withProfile(OWNER_ID, () => withRetry(() => gateways[name].send(target, text), [5000, 15_000, 30_000, 60_000, 120_000]))
}

export function startGateways(): void {
  stopped = false
  void syncGateways(true)
  scheduleWatchdog()
  if (listening) return
  listening = true
  bus.on('config:changed', (kind: string) => {
    if (stopped || !isOwner()) return
    if (kind === 'config') void syncGateways()
    if (kind === 'env') void syncGateways(true)
  })
}

export function stopGateways(): Promise<void> {
  stopped = true
  if (watchdog) clearTimeout(watchdog)
  watchdog = null
  return Promise.all(names.map((name) => serial(name, () => gateways[name].stop()))).then(() => undefined)
}
