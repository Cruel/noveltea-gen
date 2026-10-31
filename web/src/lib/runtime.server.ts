import { openStudioDatabase } from '../db/connection'
import { createStudioAuth, readAuthConfig } from './auth'

// One application-level SQLite owner for auth, catalogs and migrations.
const store = openStudioDatabase()
export const auth = createStudioAuth(store, readAuthConfig())
export const database = store
