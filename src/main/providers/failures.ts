/**
 * Classifies provider failures so an unattended run can recover on its own:
 * - unavailable: this subscription can't serve right now (usage limit, expired/revoked login) → try the other provider
 * - transient: network blips, overloads, a CLI that crashed on startup → retry once after a pause
 */
type FailureKind = 'unavailable' | 'transient' | null

const LIMIT = /usage limit|hit your (usage )?limit|limit (reached|exceeded)|rate.?limit|quota|too many requests|\b429\b|usage_limit|out of (extra )?usage/i
const AUTH = /oauth token (has )?expired|token (has )?(expired|been revoked)|refresh.?token|please run \/login|not logged in|log ?in again|re-?authenticate|invalid (api key|token|bearer|credentials)|authentication_error|authentication_failed|oauth_org_not_allowed|account_on_hold|verification_required|billing_error|\b401\b|unauthori[sz]ed/i
const TRANSIENT = /overloaded|\b50[0234]\b|\b529\b|internal server error|service unavailable|bad gateway|gateway timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network (error|is unreachable)|fetch failed|stream (disconnected|closed|ended)|process exited|exited with code|app-server exited|connection (reset|closed|error)/i

export function classifyFailure(error: string): FailureKind {
  if (LIMIT.test(error) || AUTH.test(error)) return 'unavailable'
  if (TRANSIENT.test(error)) return 'transient'
  return null
}

export function isUsageLimit(error: string): boolean {
  return LIMIT.test(error)
}

/** When a usage-limited subscription is expected back. Claude reports "…limit reached|<epoch seconds>"; otherwise assume 30 minutes. */
export function limitResetAt(error: string, now = Date.now()): number {
  const epoch = /\|(\d{10})\b/.exec(error)
  if (epoch) {
    const at = Number(epoch[1]) * 1000
    if (at > now && at - now < 7 * 86_400_000) return at
  }
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(error)
  if (clock) {
    let h = Number(clock[1]) % 12
    if (clock[3].toLowerCase() === 'pm') h += 12
    const d = new Date(now)
    d.setHours(h, Number(clock[2] ?? 0), 0, 0)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  return now + 30 * 60_000
}
