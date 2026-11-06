import { openStudioDatabase } from '../db/connection'
import { createStudioAuth, readAuthConfig } from './auth'

// A hosted specialist may NEVER silently use local Pi auth or host API keys
// when its per-user async runtime context is missing. Independent CLI processes
// retain their own explicit runtime behavior.
process.env.NT_REQUIRE_USER_PI_RUNTIME = '1'

// One application-level SQLite owner for auth, catalogs and migrations.
const store = openStudioDatabase()
// Fail at process startup, before serving even login/OAuth requests. A schema
// reset or migration is always a deliberate operator action, never runtime IO.
await store.assertReady()
export const auth = createStudioAuth(store, readAuthConfig())
export const database = store
