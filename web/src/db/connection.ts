import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import { createSqlitePersistence } from '../persistence/sqlite'

export function defaultStudioPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NT_STUDIO_DB_PATH) {
    if (!isAbsolute(env.NT_STUDIO_DB_PATH)) throw new Error('NT_STUDIO_DB_PATH must be absolute')
    return env.NT_STUDIO_DB_PATH
  }
  const state = env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  if (!isAbsolute(state)) throw new Error('XDG_STATE_HOME must be absolute')
  return join(state, 'noveltea-gen', 'studio.sqlite')
}

/** The raw driver and Drizzle implementation are private to the SQLite
 * adapter. Public StudioDatabase consumers only see portable persistence ports
 * and a lifecycle method. These internal accessors are restricted to Better
 * Auth, migrations and isolated schema/adapter tests by the source-boundary check.
 */
const handles = new WeakMap<object, {
  sqlite: Database.Database
  db: BetterSQLite3Database<typeof schema>
}>()

export function openStudioDatabase(path = defaultStudioPath()) {
  if (path !== ':memory:') {
    if (!isAbsolute(path)) throw new Error('Studio database path must be absolute')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  }
  const sqlite = new Database(path, { timeout: 5000 })
  try {
    if (path !== ':memory:') {
      chmodSync(path, 0o600)
      sqlite.pragma('journal_mode = WAL')
    }
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    const store = { persistence: createSqlitePersistence(db), close: () => sqlite.close() }
    handles.set(store, { sqlite, db })
    return store
  } catch (error) {
    sqlite.close()
    throw error
  }
}

export type StudioDatabase = ReturnType<typeof openStudioDatabase>

/** Internal exception: Better Auth's embedded SQLite driver, migration/schema
 * maintenance and explicit low-level tests. Never import in route or service code. */
export function studioSqliteDriver(store: StudioDatabase): Database.Database {
  const handle = handles.get(store)
  if (!handle) throw new Error('Invalid Studio database handle')
  return handle.sqlite
}

/** Internal exception: Drizzle migration runner only. */
export function studioDrizzleForMigrations(store: StudioDatabase) {
  const handle = handles.get(store)
  if (!handle) throw new Error('Invalid Studio database handle')
  return handle.db
}
