import { getDb } from './db'
import { createHash } from 'node:crypto'

/** Persist one content fingerprint per session/page; explicit reload and changed content bypass suppression. */
export function skillPageSeen(session: string, name: string, file: string, offset: number, maxChars: number, content: string, reload = false): boolean {
  const db = getDb()
  const key = createHash('sha256').update(JSON.stringify([session, name, file, offset, maxChars])).digest('hex')
  const hash = createHash('sha256').update(content).digest('hex')
  const old = db.prepare('SELECT hash FROM skill_pages WHERE key = ?').get(key) as { hash: string } | undefined
  db.prepare('INSERT INTO skill_pages (key, hash, ts) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET hash = excluded.hash, ts = excluded.ts').run(key, hash, Date.now())
  return !reload && old?.hash === hash
}

export interface SkillUsage {
  name: string
  suggested: number
  loaded: number
  succeeded: number
  failed: number
  lastLoadedAt: number | null
}

export interface SkillHealthReport {
  name: string
  suggested: number
  loaded: number
  succeeded: number
  failed: number
  successRate: number | null
  lastLoadedAt: number | null
  health: 'healthy' | 'at_risk' | 'failing' | 'untested'
  recommendation: 'keep' | 'review' | 'patch' | 'prune'
}

export function recordSkill(name: string, runId: string, action: 'suggested' | 'loaded' | 'saved'): void {
  getDb().prepare('INSERT OR IGNORE INTO skill_activity (name, run_id, action, ts) VALUES (?, ?, ?, ?)').run(name, runId, action, Date.now())
}

export function runSkillActivity(runId: string): { loaded: boolean; saved: boolean } {
  const rows = getDb().prepare('SELECT action FROM skill_activity WHERE run_id = ?').all(runId) as { action: string }[]
  return { loaded: rows.some(r => r.action === 'loaded'), saved: rows.some(r => r.action === 'saved') }
}

export function skillStats(since = 0): SkillUsage[] {
  return getDb().prepare(`SELECT a.name,
    SUM(a.action = 'suggested') suggested, SUM(a.action = 'loaded') loaded,
    SUM(a.action = 'loaded' AND r.status = 'succeeded') succeeded,
    SUM(a.action = 'loaded' AND r.status = 'failed') failed,
    MAX(CASE WHEN a.action = 'loaded' THEN a.ts END) lastLoadedAt
    FROM skill_activity a JOIN runs r ON r.id = a.run_id WHERE a.ts >= ? GROUP BY a.name ORDER BY loaded DESC, a.name`).all(since) as SkillUsage[]
}

/** Hermes-style skill quality evaluation: calculates success rates, health, and actionable recommendations. */
export function evaluateSkills(since = 0): SkillHealthReport[] {
  const stats = skillStats(since)
  return stats.map((s) => {
    const totalOutcomes = s.succeeded + s.failed
    const successRate = totalOutcomes > 0 ? Number((s.succeeded / totalOutcomes).toFixed(2)) : null
    let health: SkillHealthReport['health'] = 'untested'
    let recommendation: SkillHealthReport['recommendation'] = 'keep'

    if (s.loaded === 0) {
      health = 'untested'
      recommendation = 'keep'
    } else if (totalOutcomes > 0) {
      if (s.failed >= 2 && (successRate ?? 0) < 0.5) {
        health = 'failing'
        recommendation = 'review'
      } else if (s.failed > 0 && (successRate ?? 0) < 0.8) {
        health = 'at_risk'
        recommendation = 'patch'
      } else {
        health = 'healthy'
        recommendation = 'keep'
      }
    }

    return {
      ...s,
      successRate,
      health,
      recommendation
    }
  })
}
