import type { BetterAuthOptions } from 'better-auth'
import type { StudioStore } from '../persistence/store'

/** Authentication storage is registered by its backend, never inferred by
 * the auth service from a SQLite path or driver.
 * Better Auth still migrates its tables separately from the Studio schema.
 */
type AuthStorage = NonNullable<BetterAuthOptions['database']>
const storage = new WeakMap<StudioStore, AuthStorage>()

export function registerStudioAuthStorage(store: StudioStore, adapter: AuthStorage): void {
  if (storage.has(store)) throw new Error('Studio authentication storage was already registered')
  storage.set(store, adapter)
}

export function studioAuthStorage(store: StudioStore): AuthStorage {
  const selected = storage.get(store)
  if (!selected) throw new Error('Studio authentication storage is not configured')
  return selected
}
