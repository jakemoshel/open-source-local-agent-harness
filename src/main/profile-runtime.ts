import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadAll, files } from './config'
import { openDb, pruneEvents } from './db'
import { ensureDirs, paths } from './paths'
import { withProfile, isOwner } from './profile-context'
import { allProfiles, getProfile } from './profiles'
import { startScheduler, stopProfileSchedules } from './scheduler'
import { startLearning, stopProfileLearning } from './learning'
import { initializeContextStore } from './context-store'
import { initializeToolLibrary } from './harness-tools'

const initialized = new Set<string>()
export function initializeProfile(id: string): void {
  if (initialized.has(id)) return
  const p = getProfile(id)
  withProfile(id, () => {
    ensureDirs()
    for (const dir of ['workspace', 'auth/claude', 'auth/codex']) mkdirSync(join(paths.home, dir), { recursive: true, mode: 0o700 })
    openDb()
    loadAll()
    if (!isOwner()) {
      if (!existsSync(paths.soul)) writeFileSync(paths.soul, `You are Jarvis, the personal assistant for ${p.name}. Keep their work, memory, and preferences in this profile. The owner administers the shared Mac.\n`, { mode: 0o600 })
      if (!existsSync(join(paths.memories, 'USER.md'))) writeFileSync(join(paths.memories, 'USER.md'), `Name: ${p.name}\n`, { mode: 0o600 })
    }
    initializeContextStore()
    initializeToolLibrary()
    if (p.enabled) { startScheduler(); startLearning() }
  })
  initialized.add(id)
}
export function refreshProfile(id: string): void {
  initializeProfile(id)
  const p = getProfile(id)
  if (!p.enabled) { stopProfileSchedules(id); stopProfileLearning(id); return }
  withProfile(id, () => { startScheduler(); startLearning() })
}
export function forEachProfile(fn: () => void): void {
  for (const p of allProfiles()) if (p.enabled) withProfile(p.id, fn)
}
export function pruneProfileEvents(): void { forEachProfile(() => pruneEvents(files.config.value.retentionDays)) }
