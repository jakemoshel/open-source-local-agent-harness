import { existsSync, readFileSync, renameSync, mkdirSync, openSync, closeSync, fsyncSync, writeSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { OWNER_ID, ROOT_HOME, isOwner, profileId, withProfile } from './profile-context'
import { ownerPhone, ownerSlack } from './gateways/sender-auth'

export const normalizeContact = (s: string) => s.includes('@') ? s.trim().toLowerCase() : s.replace(/[^\d+]/g, '').replace(/^1(?=\d{10}$)/, '+1').replace(/^(?=\d{10}$)/, '+1')
const schema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), name: z.string().trim().min(1).max(100),
  role: z.enum(['admin', 'member']), enabled: z.boolean().default(true),
  slackUsers: z.array(z.string().regex(/^U[A-Z0-9]+$/)).default([]),
  handles: z.array(z.string().trim().min(1)).default([])
})
export type Profile = z.infer<typeof schema>
const registry = join(ROOT_HOME, 'profiles.json')
let profiles: Profile[] = []

function save(next: Profile[]): void {
  mkdirSync(ROOT_HOME, { recursive: true, mode: 0o700 })
  const tmp = registry + '.tmp'
  const fd = openSync(tmp, 'w', 0o600)
  try { writeSync(fd, JSON.stringify({ profiles: next }, null, 2) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
  try { if (existsSync(registry)) { readRegistry(registry); copyFileSync(registry, `${registry}.bak`) } } catch { /* keep the last good backup */ }
  renameSync(tmp, registry)
  profiles = next
}

function readRegistry(path: string): Profile[] {
  const parsed = z.object({ profiles: z.array(schema) }).parse(JSON.parse(readFileSync(path, 'utf8'))).profiles
  validate(parsed)
  return parsed
}

/** Set when profiles.json was unreadable at startup and a backup or the owner-only default was used. */
export let profilesRecovered: string | null = null

export function loadProfiles(legacy?: { slack: string[]; handles: string[] }): void {
  if (existsSync(registry)) {
    try {
      profiles = readRegistry(registry)
      return
    } catch (err) {
      // A bad hand edit or a torn write must not keep Jarvis from booting for the owner.
      const aside = `${registry}.corrupt-${Date.now()}`
      renameSync(registry, aside)
      try {
        profiles = readRegistry(`${registry}.bak`)
        profilesRecovered = `profiles.json was unreadable (${(err as Error).message.split('\n')[0]}); restored the last good copy`
        save(profiles)
        return
      } catch {
        profilesRecovered = `profiles.json was unreadable (${(err as Error).message.split('\n')[0]}); moved it aside and started with the owner only`
      }
    }
  }
  const phone = ownerPhone(), slack = ownerSlack()
  save([{ id: OWNER_ID, name: 'Owner', role: 'admin', enabled: true,
    slackUsers: [...new Set([...(slack ? [slack] : []), ...(legacy?.slack ?? [])])],
    handles: [...new Set([...(phone ? [phone] : []), ...(legacy?.handles ?? []).map(normalizeContact)])] }])
}

function validate(next: Profile[]): void {
  const ids = new Set<string>(), contacts = new Set<string>()
  if (!next.some((p) => p.id === OWNER_ID && p.role === 'admin' && p.enabled)) throw new Error('The owner must remain the enabled admin')
  for (const p of next) {
    if (ids.has(p.id)) throw new Error('Duplicate profile ID')
    ids.add(p.id)
    for (const h of p.handles) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(h) && !/^\+[1-9]\d{7,14}$/.test(normalizeContact(h))) throw new Error('Use a phone number with country code or a valid email')
    if (p.id !== OWNER_ID && p.role !== 'member') throw new Error('Only the owner is the admin')
    for (const c of [...p.slackUsers.map((s) => `slack:${s}`), ...p.handles.map((s) => `imessage:${normalizeContact(s)}`)]) {
      if (contacts.has(c)) throw new Error(`Contact already belongs to a profile: ${c}`)
      contacts.add(c)
    }
  }
}

export function getProfile(id = profileId()): Profile {
  const found = profiles.find((p) => p.id === id)
  if (!found) throw new Error('Profile not found')
  return { ...found, slackUsers: [...found.slackUsers], handles: [...found.handles] }
}
export const listProfiles = () => (isOwner() ? profiles : profiles.filter((p) => p.id === profileId())).map((p) => getProfile(p.id))
export function allProfiles(): Profile[] { return profiles.map((p) => getProfile(p.id)) }
export function requireAdmin(): void { if (!isOwner()) throw new Error('Only the owner can manage shared settings and other profiles') }
export function profileForSender(gateway: 'slack' | 'imessage', sender: string): Profile | null {
  return profiles.find((p) => p.enabled && (gateway === 'slack' ? p.slackUsers.includes(sender) : p.handles.some((h) => normalizeContact(h) === normalizeContact(sender)))) ?? null
}
export function saveProfile(input: unknown): Profile {
  requireAdmin()
  const p = schema.parse(input)
  p.handles = [...new Set(p.handles.map(normalizeContact))]
  p.slackUsers = [...new Set(p.slackUsers)]
  const next = profiles.some((x) => x.id === p.id) ? profiles.map((x) => x.id === p.id ? p : x) : [...profiles, p]
  validate(next); save(next)
  return p
}
export function asProfile<T>(id: string, fn: () => T): T {
  if (id !== profileId()) requireAdmin()
  const p = getProfile(id)
  if (!p.enabled) throw new Error('Profile is disabled')
  return withProfile(id, fn)
}
