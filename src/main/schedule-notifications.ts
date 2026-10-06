import { Notification } from 'electron'
import type { Run, Schedule } from '@shared/types'
import { cfg, files } from './config'
import { audit, kvGet, kvSet, listRuns } from './db'
import { deliver } from './gateways'
import { holdCompletion } from './maintenance'
import { allProfiles, getProfile, normalizeContact } from './profiles'
import { OWNER_ID, profileId, withProfile } from './profile-context'

interface Delivery { gateway: 'slack' | 'imessage'; target: string; text: string; state?: 'sending' | 'sent' | 'failed' | 'uncertain'; retryAt?: number; attempts?: number }
interface Notice { desktop: boolean; deliveries: Delivery[] }
const inFlight = new Set<string>()
let timer: NodeJS.Timeout | null = null
let openRun: (id: string) => void = () => undefined
const terminal = (r: Run) => r.finishedAt != null && ['succeeded', 'failed', 'cancelled'].includes(r.status)
function completionText(name: string, run: Run): string {
  if (run.status === 'succeeded') return `${name} completed.${/^\s*NO_DIGEST\s*$/.test(run.result ?? '') ? ' No new items to report.' : ''}`
  return `${name} ${run.status}.${run.error ? ` ${run.error.slice(0, 600)}` : ''}`
}
export async function notifyScheduledRun(schedule: Pick<Schedule, 'name' | 'deliver'>, run: Run): Promise<void> {
  if (!terminal(run)) return
  const key = `schedule:completion:${run.id}`, scoped = `${profileId()}:${run.id}`
  if (inFlight.has(scoped)) return
  inFlight.add(scoped)
  const release = holdCompletion()
  try {
    let notice = kvGet<Notice>(key)
    if (!notice) {
      const status = completionText(schedule.name, run)
      const deliveries: Delivery[] = []
      const owner = withProfile(OWNER_ID, () => {
        const config = cfg().notifications
        const handles = getProfile(OWNER_ID).handles
        return { enabled: config?.scheduleCompletions !== false, target: config?.imessageTarget || handles[0], handles }
      })
      if (schedule.deliver) {
        const output = run.status === 'succeeded' && !/^\s*NO_DIGEST\s*$/.test(run.result ?? '') ? `\n\n${run.result || '(no output)'}` : ''
        deliveries.push({ ...schedule.deliver, text: status + output })
      }
      const alreadyOwner = deliveries.some(d => d.gateway === 'imessage' && [owner.target, ...owner.handles].filter(Boolean).some(h => normalizeContact(h!) === normalizeContact(d.target)))
      if (owner.enabled && owner.target && !alreadyOwner) {
        // Admin gets completion status for other profiles, not their private output/error.
        const text = profileId() === OWNER_ID ? status : `${getProfile().name}: ${schedule.name} ${run.status === 'succeeded' ? 'completed' : run.status}.`
        deliveries.push({ gateway: 'imessage', target: owner.target, text })
      }
      notice = { desktop: false, deliveries }
      kvSet(key, notice)
    }
    if (!notice.desktop) {
      const notification = new Notification({ title: run.status === 'succeeded' ? 'Scheduled task completed' : `Scheduled task ${run.status}`, body: completionText(schedule.name, run), silent: false })
      notification.on('click', () => openRun(run.id))
      notification.show(); notice.desktop = true; kvSet(key, notice)
    }
    for (const d of notice.deliveries) {
      if (d.state === 'sent' || d.state === 'uncertain' || (d.attempts ?? 0) >= 5 || (d.retryAt ?? 0) > Date.now()) continue
      if (d.state === 'sending') { d.state = 'uncertain'; kvSet(key, notice); continue }
      d.state = 'sending'; d.attempts = (d.attempts ?? 0) + 1; kvSet(key, notice)
      try { await deliver(d.gateway, d.target, d.text); d.state = 'sent' }
      catch (err) {
        d.state = (err as { noRetry?: boolean }).noRetry ? 'uncertain' : 'failed'
        d.retryAt = Date.now() + 60000
        audit('system', 'schedule', `Completion notification ${d.state} for ${schedule.name}`, undefined, { runId: run.id })
      }
      kvSet(key, notice)
    }
  } finally { release(); inFlight.delete(scoped) }
}
/** Deliveries give up after 5 attempts a minute apart; older runs are settled and need no re-checking every 30s. */
const RECONCILE_WINDOW_MS = 24 * 3600_000
function reconcileScheduleNotifications(): void {
  for (const p of allProfiles()) if (p.enabled) withProfile(p.id, () => {
    let since = kvGet<number>('schedule:notificationsSince')
    if (since === null) { since = Date.now(); kvSet('schedule:notificationsSince', since) }
    since = Math.max(since, Date.now() - RECONCILE_WINDOW_MS)
    // Newest first; a run created before since minus the longest allowed run cannot have finished inside the window.
    const oldestCreated = since - 24 * 3600_000
    for (const run of listRuns({ trigger: 'schedule', limit: 500 })) {
      if (run.createdAt < oldestCreated) break
      if (!terminal(run) || run.finishedAt! < since) continue
      const schedule = files.schedules.value.schedules.find(s => s.id === run.triggerRef) ?? { name: run.title.replace(/^⏱\s*/, '') }
      void notifyScheduledRun(schedule, run).catch(error => audit('system', 'schedule', `Completion notification error: ${String(error)}`, undefined, { runId: run.id }))
    }
  })
}
export function startScheduleNotifications(onOpen: (id: string) => void): void {
  openRun = onOpen
  reconcileScheduleNotifications()
  timer = setInterval(reconcileScheduleNotifications, 30000); timer.unref()
}
export function stopScheduleNotifications(): void { if (timer) clearInterval(timer); timer = null }
