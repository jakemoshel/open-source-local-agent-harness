import { bindProfile, profileId } from './profile-context'
import { Cron } from 'croner'
import type { Schedule } from '@shared/types'
import { bus } from './bus'
import { cfg, files, hasGranolaConnection, MEMORY_INGEST_PROMPT, MEMORY_REVIEW_PROMPT } from './config'
import { audit, kvGet, kvSet } from './db'
import { notifyScheduledRun } from './schedule-notifications'
import { holdCompletion } from './maintenance'
import { startRun, waitForRun } from './runs'

const states = new Map<string, { jobs: Map<string, Cron>; inFlight: Map<string, string>; timer: NodeJS.Timeout | null; running: boolean }>()
function state() {
  let s = states.get(profileId())
  if (!s) { s = { jobs: new Map(), inFlight: new Map(), timer: null, running: false }; states.set(profileId(), s) }
  return s
}
let listening = false
const CATCH_UP_WINDOW = 12 * 3600_000

function validateCron(expr: string): string | null {
  try {
    new Cron(expr, { paused: true }).stop()
    return null
  } catch (err) {
    return (err as Error).message
  }
}

export function nextRuns(expr: string, n = 3, timezone?: string): number[] {
  try {
    const c = new Cron(expr, { paused: true, timezone: timezone || cfg().timezone })
    const out = c.nextRuns(n).map((d) => d.getTime())
    c.stop()
    return out
  } catch {
    return []
  }
}

/** Why a schedule can't be armed, or null. One-off jobs are validated by their runAt time instead of cron. */
export function scheduleError(s: Pick<Schedule, 'cron' | 'runAt'>): string | null {
  if (s.runAt) return Number.isFinite(Date.parse(s.runAt)) ? null : `Invalid runAt "${s.runAt}": use an ISO 8601 time like 2026-09-27T15:00:00-04:00`
  return validateCron(s.cron)
}

export function upcoming(s: Schedule, n = 3): number[] {
  if (s.runAt) {
    const at = Date.parse(s.runAt)
    return Number.isFinite(at) && at > Date.now() ? [at] : []
  }
  return nextRuns(s.cron, n, s.timezone)
}

/** A one-off job is done once it has fired (or was missed for too long): keep it for history, but disarmed. */
function retireOneOff(id: string): void {
  const list = files.schedules.value.schedules
  if (!list.some((x) => x.id === id && x.runAt && x.enabled)) return
  files.schedules.write({ schedules: list.map((x) => (x.id === id ? { ...x, enabled: false } : x)) })
}

export async function fireSchedule(s: Schedule): Promise<string> {
  const { inFlight } = state()
  const existing = inFlight.get(s.id)
  if (existing) return existing
  const run = startRun({
    prompt: s.op ? `harness op ${s.op}` : s.prompt,
    provider: s.provider,
    model: s.model,
    effort: s.effort,
    cwd: s.cwd,
    title: `⏱ ${s.name}`,
    trigger: 'schedule',
    triggerRef: s.id,
    kind: s.source === 'default' && ((s.id === 'memory-ingest' && s.prompt === MEMORY_INGEST_PROMPT) || (s.id === 'memory-review' && s.prompt === MEMORY_REVIEW_PROMPT)) ? 'memory' : undefined,
    conversationKey: s.persistentConversation ? `schedule:${s.id}` : undefined,
    direct: s.op ? { op: s.op, args: s.opArgs ?? {} } : undefined
  })
  inFlight.set(s.id, run.id)
  kvSet(`schedule:last:${s.id}`, Date.now())
  const release = holdCompletion()
  void waitForRun(run.id).then(done => notifyScheduledRun(s, done)).catch((err) => {
    audit('system', 'schedule', `Schedule ${s.name} completion/delivery failed: ${String(err)}`, undefined, { runId: run.id })
  }).finally(() => { release(); inFlight.delete(s.id) })
  return run.id
}

export function lastFired(id: string): number | null {
  return kvGet<number>(`schedule:last:${id}`)
}

function sync(): void {
  const { jobs } = state()
  for (const j of jobs.values()) j.stop()
  jobs.clear()
  for (const s of files.schedules.value.schedules) {
    if (!s.enabled) {
      kvSet(`schedule:armed:${s.id}`, null)
      continue
    }
    if (s.id === 'granola-archive' && !hasGranolaConnection()) continue
    if (scheduleError(s)) continue
    if (kvGet<number>(`schedule:armed:${s.id}`) === null) kvSet(`schedule:armed:${s.id}`, Date.now())
    if (s.runAt) {
      const at = Date.parse(s.runAt)
      // Past one-offs are handled by the catch-up pass (fired if recent, retired if long gone).
      if (at <= Date.now()) continue
      try {
        jobs.set(s.id, new Cron(new Date(at), { protect: true }, bindProfile(() => fireSchedule(s).then(() => retireOneOff(s.id)).catch((err) => console.error(`[jarvis] schedule ${s.id} failed:`, err)))))
      } catch (err) {
        console.error(`[jarvis] schedule ${s.id} not registered: ${(err as Error).message}`)
      }
      continue
    }
    try {
      jobs.set(s.id, new Cron(s.cron, { protect: true, timezone: s.timezone || cfg().timezone }, bindProfile(() => fireSchedule(s).then(() => undefined).catch((err) => console.error(`[jarvis] schedule ${s.id} failed:`, err)))))
    } catch (err) {
      console.error(`[jarvis] schedule ${s.id} not registered: ${(err as Error).message}`)
    }
  }
}

/**
 * Fire each enabled schedule once if its most recent slot passed while Jarvis was off, asleep or
 * rebooting (power outage, macOS update). Only slots in the last 12 hours, and only after the
 * schedule was enabled, so a fresh cutover never replays old jobs.
 */
export function catchUpSchedules(): void {
  const { jobs, inFlight } = state()
  const now = Date.now()
  for (const s of files.schedules.value.schedules) {
    if (s.id === 'granola-archive' && !hasGranolaConnection()) continue
    if (s.runAt && s.enabled && !inFlight.has(s.id)) {
      const at = Date.parse(s.runAt)
      if (!Number.isFinite(at) || at > now) continue
      if (now - at > CATCH_UP_WINDOW || (lastFired(s.id) ?? 0) >= at) {
        retireOneOff(s.id)
        continue
      }
      console.warn(`[jarvis] catching up missed one-off ${s.id} (due ${new Date(at).toISOString()})`)
      void fireSchedule(s).then(() => retireOneOff(s.id)).catch((err) => console.error(`[jarvis] schedule ${s.id} catch-up failed:`, err))
      continue
    }
    const job = jobs.get(s.id)
    if (!s.enabled || !job || job.isBusy() || inFlight.has(s.id)) continue
    const prev = job.previousRuns(1)[0]?.getTime()
    if (!prev || now - prev > CATCH_UP_WINDOW) continue
    const armed = kvGet<number>(`schedule:armed:${s.id}`) ?? now
    const last = lastFired(s.id) ?? 0
    if (prev <= armed || last >= prev) continue
    console.warn(`[jarvis] catching up missed schedule ${s.id} (slot ${new Date(prev).toISOString()})`)
    void fireSchedule(s).catch((err) => console.error(`[jarvis] schedule ${s.id} catch-up failed:`, err))
  }
}

function queueCatchUp(delay: number): void {
  const s = state()
  if (s.timer) clearTimeout(s.timer)
  s.timer = setTimeout(bindProfile(() => { s.timer = null; catchUpSchedules() }), delay)
  s.timer.unref()
}

export function startScheduler(): void {
  state().running = true
  sync()
  queueCatchUp(60_000)
  if (listening) return
  listening = true
  bus.on('config:changed', (kind: string) => {
    if (!['schedules', 'config', 'mcp'].includes(kind) || !states.get(profileId())?.running) return
    sync()
    // Retirement writes emit config changes too: defer and coalesce to avoid recursive catch-up.
    queueCatchUp(0)
  })
}

export function stopProfileSchedules(id: string): void {
  const s = states.get(id)
  if (!s) return
  s.running = false
  if (s.timer) clearTimeout(s.timer)
  s.timer = null
  for (const j of s.jobs.values()) j.stop()
  s.jobs.clear()
}
export function stopScheduler(): void {
  for (const id of states.keys()) stopProfileSchedules(id)
}
