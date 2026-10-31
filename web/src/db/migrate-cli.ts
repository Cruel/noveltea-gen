import { openStudioDatabase } from './connection'
import { readAuthConfig } from '../lib/auth'
import { migrateStudio } from './migrations'

const store = openStudioDatabase()
try {
  await migrateStudio(store, readAuthConfig())
  console.log('NovelTea Studio SQLite migrations applied.')
} finally {
  store.sqlite.close()
}
