import { loadEnv } from 'vite'
import { defaultStudioPath, openStudioDatabase } from './connection'
import { readAuthConfig } from '../lib/auth'
import { migrateStudio } from './migrations'

// The pnpm workspace script runs in web/, the same root Vite uses in dev.
// loadEnv honors .env, .env.local, mode-specific files, and shell overrides;
// passing the result explicitly avoids using a different DB path from Studio.
const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development'
const env = loadEnv(mode, process.cwd(), '')
const store = openStudioDatabase(defaultStudioPath(env))
try {
  await migrateStudio(store, readAuthConfig(env))
  console.log('NovelTea Studio SQLite migrations applied.')
} finally {
  store.close()
}
