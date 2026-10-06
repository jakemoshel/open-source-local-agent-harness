import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT_HOME } from '../profile-context'

/**
 * Fixed ingress identities, read once from ~/.jarvis/owner.json ({"phone": "+15551234567", "slack": "U0123ABCD"}) or
 * JARVIS_OWNER_PHONE / JARVIS_OWNER_SLACK. No harness operation writes them, so message text, profile edits and legacy
 * allowlists cannot grant access. An identity left unset blocks that gateway entirely.
 */
let owner: { phone: string | null; slack: string | null } | null = null

function ownerIds(): { phone: string | null; slack: string | null } {
  if (owner) return owner
  let file: { phone?: unknown; slack?: unknown } = {}
  try { file = JSON.parse(readFileSync(join(ROOT_HOME, 'owner.json'), 'utf8')) } catch { /* not configured */ }
  const slack = process.env.JARVIS_OWNER_SLACK ?? file.slack
  owner = {
    phone: normalizedPhone(process.env.JARVIS_OWNER_PHONE ?? file.phone),
    slack: typeof slack === 'string' && /^[UW][A-Z0-9]+$/.test(slack) ? slack : null
  }
  return owner
}

/** Called only from the owner's own UI (owner_set is not an agent operation). */
export function setOwnerIds(next: { phone?: string; slack?: string }): { phone: string | null; slack: string | null } {
  const phone = next.phone?.trim() ? normalizedPhone(next.phone) : null
  if (next.phone?.trim() && !phone) throw new Error('Use a phone number with country code, like +15551234567')
  const slack = next.slack?.trim() || null
  if (slack && !/^[UW][A-Z0-9]+$/.test(slack)) throw new Error('Slack member IDs look like U0123ABCD')
  writeFileSync(join(ROOT_HOME, 'owner.json'), JSON.stringify({ ...(phone ? { phone } : {}), ...(slack ? { slack } : {}) }, null, 2) + '\n', { mode: 0o600 })
  owner = null
  return ownerIds()
}

export const ownerPhone = (): string | null => ownerIds().phone
export const ownerSlack = (): string | null => ownerIds().slack

/** Accept formatting, never discard letters or arbitrary punctuation to manufacture a phone number. */
export function normalizedPhone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64 || !/^\+?[0-9 ()-]+$/.test(value.trim())) return null
  const digits = value.trim().replace(/[ ()-]/g, '')
  const phone = digits.replace(/^1(?=\d{10}$)/, '+1').replace(/^(?=\d{10}$)/, '+1')
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null
}

export function authorizedSender(gateway: 'slack' | 'imessage', sender: unknown): boolean {
  const { phone, slack } = ownerIds()
  return gateway === 'slack' ? !!slack && sender === slack : !!phone && normalizedPhone(sender) === phone
}

/** Direct chats must name the authenticated sender; group chats can contain third-party content. */
export function authorizedChat(chat: unknown, sender: unknown): boolean {
  if (!authorizedSender('imessage', sender) || typeof chat !== 'string') return false
  const direct = /^(?:iMessage|SMS|RCS|any);-;([^;]+)$/.exec(chat)
  return !!direct && normalizedPhone(direct[1]) === ownerPhone()
}
