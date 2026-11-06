/** Stable test-facing entrypoint; dialect-specific read-only credential access lives in the backend adapter. */
export { readIsolatedStudioOAuth } from './support/sqlite-oauth-source'
