import { AsyncLocalStorage } from 'node:async_hooks'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const ROOT_HOME = process.env.JARVIS_HOME ?? join(homedir(), '.jarvis')
export const OWNER_ID = 'owner'
const scope = new AsyncLocalStorage<string>()
export const profileId = () => scope.getStore() ?? OWNER_ID
export const isOwner = () => profileId() === OWNER_ID
export const profileHome = () => isOwner() ? ROOT_HOME : join(ROOT_HOME, 'profiles', profileId())
export function withProfile<T>(id: string, fn: () => T): T {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(id)) throw new Error('Invalid profile ID')
  return scope.run(id, fn)
}
export const bindProfile = <T extends (...args: any[]) => any>(fn: T): T => {
  const id = profileId()
  return ((...args) => withProfile(id, () => fn(...args))) as T
}
