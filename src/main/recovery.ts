import type { Run } from '@shared/types'
import { audit, INTERRUPTED_ERROR, kvSet, takeInterruptedRuns } from './db'
import { deliver } from './gateways'
import { withProfile } from './profile-context'
import { allProfiles } from './profiles'
import { recordFault } from './faults'
import { startRun, waitForRun } from './runs'
import { replyTarget } from './reply-target'
export { replyTarget }

const RECOVER_WINDOW_MS = 60 * 60_000
const RECOVERED_PREFIX = 'recovered:'

const recoverPrompt = (prompt: string) => `Jarvis restarted (an update, crash or power loss) while you were working on the request below, so your previous turn was cut off. Check what was already done (files written, messages sent, commands run) before repeating any step, then finish the task and reply as you normally would.

Request:
${prompt}`

/** Where the original conversation's reply would have gone, rebuilt from its conversation key. */
async function resume(run: Run): Promise<void> {
  const next = startRun({
    prompt: recoverPrompt(run.prompt),
    provider: run.provider,
    cwd: run.cwd,
    title: `↺ ${run.title}`.slice(0, 90),
    trigger: run.trigger,
    triggerRef: `${RECOVERED_PREFIX}${run.id}`,
    conversationKey: run.conversationKey ?? undefined
  })
  const target = replyTarget(run)
  const done = await waitForRun(next.id)
  if (!target || done.status === 'cancelled') return
  await deliver(target.gateway, target.target, done.status === 'succeeded' ? done.result || '(done)' : `⚠️ ${done.status}${done.error ? `: ${done.error}` : ''}`)
}

/**
 * Picks up work that a restart cut off: recent conversational runs continue in their session (and reply where the
 * message came from); interrupted schedules are re-armed for the catch-up pass. Each run is recovered at most once.
 */
export function recoverInterruptedRuns(): void {
  const cutoff = Date.now() - RECOVER_WINDOW_MS
  for (const p of allProfiles()) {
    if (!p.enabled) continue
    withProfile(p.id, () => {
      const runs = takeInterruptedRuns().filter((r) => r.error === INTERRUPTED_ERROR && r.createdAt >= cutoff && !(r.triggerRef ?? '').startsWith(RECOVERED_PREFIX))
      runs.sort((a, b) => a.createdAt - b.createdAt)
      for (const run of runs) {
        try {
          if (run.trigger === 'schedule' && run.triggerRef) {
            kvSet(`schedule:last:${run.triggerRef}`, null)
            continue
          }
          if (!run.conversationKey || !['slack', 'imessage', 'ui'].includes(run.trigger)) continue
          audit('system', 'system', `Resuming "${run.title}" after a restart`, undefined, { runId: run.id })
          void resume(run).catch((err) => audit('system', 'system', `Could not resume "${run.title}": ${(err as Error).message}`, undefined, { runId: run.id }))
        } catch (err) {
          console.error('[jarvis] recovery failed for run', run.id, err)
          recordFault({ source: 'recovery', error: err, context: `run ${run.id}` })
        }
      }
    })
  }
}
