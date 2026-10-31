import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

export function defaultStudioPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NT_STUDIO_DB_PATH) {
    if (!isAbsolute(env.NT_STUDIO_DB_PATH)) throw new Error('NT_STUDIO_DB_PATH must be absolute')
    return env.NT_STUDIO_DB_PATH
  }
  const state = env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  if (!isAbsolute(state)) throw new Error('XDG_STATE_HOME must be absolute')
  return join(state, 'noveltea-gen', 'studio.sqlite')
}

export function openStudioDatabase(path = defaultStudioPath()) {
  if (path !== ':memory:') {
    if (!isAbsolute(path)) throw new Error('Studio database path must be absolute')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  }
  const sqlite = new Database(path, { timeout: 5000 })
  if (path !== ':memory:') {
    chmodSync(path, 0o600)
    sqlite.pragma('journal_mode = WAL')
  }
  sqlite.pragma('foreign_keys = ON')
  return { sqlite, db: drizzle(sqlite, { schema }) }
}

export type StudioDatabase = ReturnType<typeof openStudioDatabase>
