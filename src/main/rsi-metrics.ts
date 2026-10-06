import type { Run, UpdateStatus } from '@shared/types'
import { bus } from './bus'
import { getDb } from './db'
import { OWNER_ID, withProfile } from './profile-context'
import { correctionCount } from './learning-policy'

declare const __BUILD_COMMIT__: string
const buildCommit = () => typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'development'

/** Measurements are observations, never model estimates. Telemetry must not interrupt a job. */
export function recordRsiMetric(kind: string, data: Record<string, unknown>, commit = buildCommit()): void {
  try {
    withProfile(OWNER_ID, () => getDb().prepare('INSERT INTO rsi_metrics(ts, commit_sha, kind, data) VALUES (?, ?, ?, ?)').run(Date.now(), commit, kind, JSON.stringify(data)))
  } catch { /* database may not be open during startup or shutdown */ }
}

export function rsiStatistics(days = 14) {
  const since = Date.now() - days * 86_400_000
  const rows = withProfile(OWNER_ID, () => getDb().prepare(`SELECT commit_sha AS "commit", kind, COUNT(*) AS samples,
    AVG(json_extract(data, '$.durationMs')) AS durationMs,
    AVG(json_extract(data, '$.firstOutputMs')) AS firstOutputMs,
    json_group_array(json(data)) FILTER (WHERE kind = 'benchmark') AS benchmarks,
    SUM(CASE WHEN json_extract(data, '$.succeeded') THEN 1 ELSE 0 END) AS succeeded,
    SUM(COALESCE(json_extract(data, '$.toolErrors'), 0)) AS toolErrors,
    SUM(COALESCE(json_extract(data, '$.corrections'), 0)) AS corrections
    FROM rsi_metrics WHERE ts >= ? GROUP BY commit_sha, kind ORDER BY MAX(ts) DESC`).all(since)) as { benchmarks: string; [key: string]: unknown }[]
  return rows.map(r => ({ ...r, benchmarks: JSON.parse(r.benchmarks) }))
}

let started = false
export function startRsiMetrics(): void {
  if (started) return
  started = true
  bus.on('run:finished', (run: Run, kind: string) => {
    try {
      const observed = getDb().prepare(`SELECT
        SUM(CASE WHEN type = 'tool_result' AND json_extract(data, '$.isError') THEN 1 ELSE 0 END) AS errors,
        json_group_array(json_object('text', json_extract(data, '$.text'), 'steering', json_extract(data, '$.steering'))) FILTER (WHERE type = 'user') AS users
        FROM events WHERE run_id = ? AND type IN ('user', 'tool_result')`).get(run.id) as { errors: number | null; users: string }
      const followUp = !!run.conversationKey && !!getDb().prepare('SELECT 1 FROM runs WHERE conversation_key = ? AND id != ? AND created_at <= ? LIMIT 1').get(run.conversationKey, run.id, run.createdAt)
      recordRsiMetric(kind === 'task' ? 'task' : kind, {
        durationMs: (run.finishedAt ?? Date.now()) - (run.startedAt ?? run.createdAt),
        firstOutputMs: run.usage?.firstOutputMs, succeeded: run.status === 'succeeded',
        provider: run.provider, model: run.model,
        toolErrors: observed.errors ?? 0,
        corrections: correctionCount(JSON.parse(observed.users), followUp)
      })
    } catch { /* best-effort observability */ }
  })
  let buildStarted = 0
  bus.on('update:status', (status: UpdateStatus) => {
    if (status.phase === 'building' && !buildStarted) buildStarted = Date.now()
    if (buildStarted && ['ready', 'failed', 'rolled-back', 'succeeded'].includes(status.phase ?? '')) {
      recordRsiMetric('build', { durationMs: Date.now() - buildStarted, succeeded: !['failed', 'rolled-back'].includes(status.phase ?? '') }, status.remoteCommit ?? undefined)
      buildStarted = 0
    }
  })
}
