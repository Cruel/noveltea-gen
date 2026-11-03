import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import type { StudioAuth } from './auth'
import { readAuthConfig, type StudioAuthConfig } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './session.server'
import { JsonInputError, readJsonInput } from './json-input.server'

export type GitProvider = 'github' | 'gitlab'
type Tokens = { access: string; refresh: string | null }
type Connection = {
  id: string; owner: string; provider: GitProvider; providerAccountId: string; login: string
  credentials: string; revision: number; accessExpiresAt: number | null; refreshExpiresAt: number | null
  refreshLeaseId: string | null; refreshLeaseUntil: number | null
  status: 'connected' | 'reauthorize' | 'disconnected'
}
export class GitConnectionError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message) }
}
const response = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
const errorResponse = (error: unknown) => response({
  error: error instanceof GitConnectionError || error instanceof JsonInputError
    ? error.message : 'Git connection failed. Retry or reconnect from Settings.',
}, error instanceof GitConnectionError || error instanceof JsonInputError ? error.statusCode : 500)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const providerPath = (provider: GitProvider) => provider === 'github'
  ? 'https://github.com/login/oauth/access_token' : 'https://gitlab.com/oauth/token'
const oauthRedirect = (baseURL: string, provider: GitProvider) =>
  baseURL + '/api/integrations/git/callback/' + provider
const expires = (seconds: unknown): number | null =>
  typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 && seconds <= 1e8
    ? Date.now() + seconds * 1000 : null
const keyFor = (config: StudioAuthConfig) =>
  Buffer.from(hkdfSync('sha256', config.secret, 'NovelTea Studio Git integrations', 'git-connections-v1', 32))
function seal(owner: string, provider: GitProvider, accountId: string, value: Tokens, config: StudioAuthConfig) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(config), iv)
  cipher.setAAD(Buffer.from(owner + ':' + provider + ':' + accountId))
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), body].map(part => part.toString('base64url')).join('.')
}
function unseal(row: Connection, config: StudioAuthConfig): Tokens {
  const parts = row.credentials.split('.').map(part => Buffer.from(part, 'base64url'))
  if (parts.length !== 3 || parts[0]!.length !== 12 || parts[1]!.length !== 16)
    throw new GitConnectionError(409, 'Stored credentials could not be read; reconnect this account.')
  const decipher = createDecipheriv('aes-256-gcm', keyFor(config), parts[0]!)
  decipher.setAAD(Buffer.from(row.owner + ':' + row.provider + ':' + row.providerAccountId))
  decipher.setAuthTag(parts[1]!)
  let value: unknown
  try { value = JSON.parse(Buffer.concat([decipher.update(parts[2]!), decipher.final()]).toString('utf8')) }
  catch { throw new GitConnectionError(409, 'Stored credentials could not be read; reconnect this account.') }
  if (!value || typeof value !== 'object' || !('access' in value) ||
    typeof value.access !== 'string' || !value.access ||
    !('refresh' in value) || (value.refresh !== null && typeof value.refresh !== 'string'))
    throw new GitConnectionError(409, 'Stored credentials are invalid; reconnect this account.')
  return value as Tokens
}
function readConnection(store: StudioDatabase, owner: string, id: string): Connection {
  const row = store.sqlite.prepare(`SELECT id, owner_user_id AS owner, provider,
    provider_account_id AS providerAccountId, login, credentials, revision,
    refresh_lease_id AS refreshLeaseId, refresh_lease_until AS refreshLeaseUntil,
    access_expires_at AS accessExpiresAt, refresh_expires_at AS refreshExpiresAt, status
    FROM git_connections WHERE id=? AND owner_user_id=?`).get(id, owner) as Connection | undefined
  if (!row) throw new GitConnectionError(404, 'Git connection not found for this user.')
  return row
}
export function listGitConnections(store: StudioDatabase, owner: string) {
  return store.sqlite.prepare(`SELECT id, provider, provider_account_id AS accountId, login, status,
    access_expires_at AS accessExpiresAt FROM git_connections
    WHERE owner_user_id=? ORDER BY provider, login`).all(owner) as Array<{
    id: string; provider: GitProvider; accountId: string; login: string
    status: string; accessExpiresAt: number | null
  }>
}
function credentialsResponse(input: unknown): { access: string; refresh: string | null;
  accessExpiry: number | null; refreshExpiry: number | null } {
  if (!input || typeof input !== 'object') throw new GitConnectionError(502, 'Git provider did not return credentials.')
  const data = input as Record<string, unknown>
  if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 8192 ||
      (data.refresh_token !== undefined && typeof data.refresh_token !== 'string'))
    throw new GitConnectionError(502, 'Git provider returned invalid credentials.')
  return { access: data.access_token,
    refresh: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : null,
    accessExpiry: expires(data.expires_in), refreshExpiry: expires(data.refresh_token_expires_in) }
}
async function exchange(provider: GitProvider, params: URLSearchParams) {
  let result: Response
  try {
    result = await fetch(providerPath(provider), {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params, redirect: 'error', signal: AbortSignal.timeout(10000),
    })
  } catch { throw new GitConnectionError(503, 'Git provider token endpoint is unavailable.') }
  if (!result.ok) throw new GitConnectionError(409, 'Git authorization expired or was rejected. Reconnect.')
  const value = await result.json().catch(() => null)
  if (value && typeof value === 'object' && 'error' in value)
    throw new GitConnectionError(409, 'Git provider rejected authorization. Reconnect.')
  return credentialsResponse(value)
}
async function profile(provider: GitProvider, token: string): Promise<{ id: string; login: string }> {
  const endpoint = provider === 'github' ? 'https://api.github.com/user' : 'https://gitlab.com/api/v4/user'
  let result: Response
  try {
    result = await fetch(endpoint, { headers: {
      Authorization: 'Bearer ' + token, Accept: 'application/json', 'User-Agent': 'NovelTea-Studio',
    }, redirect: 'error', signal: AbortSignal.timeout(10000) })
  } catch { throw new GitConnectionError(503, 'Git provider identity verification is unavailable.') }
  if (!result.ok) throw new GitConnectionError(409, 'Git provider could not verify the authorized identity.')
  const data = await result.json().catch(() => null) as { id?: unknown; login?: unknown; username?: unknown } | null
  const login = provider === 'github' ? data?.login : data?.username
  if (typeof data?.id !== 'number' || !Number.isSafeInteger(data.id) || data.id <= 0 ||
      typeof login !== 'string' || !login || login.length > 255)
    throw new GitConnectionError(502, 'Git provider returned an invalid identity.')
  return { id: String(data!.id), login }
}

export async function gitConnectionRequest(auth: StudioAuth, store: StudioDatabase, request: Request,
  config: StudioAuthConfig = readAuthConfig()): Promise<Response> {
  try {
    assertStudioSchemaCurrent(store)
    const actor = await requireUser(auth, request.headers)
    if (!actor) throw new GitConnectionError(401, 'Sign in required.')
    if (request.method === 'GET') return response({ connections: listGitConnections(store, actor.id) })
    if (request.method !== 'POST' && request.method !== 'DELETE' && request.method !== 'PUT')
      throw new GitConnectionError(405, 'Method not allowed.')
    if (request.headers.get('origin') !== config.baseURL)
      throw new GitConnectionError(403, 'Cross-origin request refused.')
    const body = await readJsonInput(request) as { provider?: unknown; connectionId?: unknown; repositoryId?: unknown } | null
    if (request.method === 'PUT') {
      if (typeof body?.connectionId !== 'string' || typeof body.repositoryId !== 'string' ||
          !/^[0-9a-f-]{36}$/i.test(body.connectionId) || !/^[0-9a-f-]{36}$/i.test(body.repositoryId))
        throw new GitConnectionError(422, 'Choose a repository and Git connection.')
      const repository = store.sqlite.prepare(`SELECT id,provider,provider_repository_id AS providerId,name
        FROM repositories WHERE id=? AND owner_user_id=?`)
        .get(body.repositoryId, actor.id) as { id: string; provider: GitProvider; providerId: string; name: string } | undefined
      if (!repository) throw new GitConnectionError(404, 'Repository not found for this Studio user.')
      const connection = readConnection(store, actor.id, body.connectionId)
      if (connection.provider !== repository.provider || connection.status !== 'connected')
        throw new GitConnectionError(409, 'Select an active connection for this repository provider.')
      const token = await tokenForGitConnection(store, actor.id, connection.id, config)
      if (connection.provider === 'github') {
        const { matchingRepository, GithubError } = await import('./github-repositories.server')
        try {
          const remote = await matchingRepository(token, repository.name)
          if (String(remote.id) !== repository.providerId)
            throw new GitConnectionError(409, 'GitHub repository identity changed; cannot rebind.')
        } catch (error) {
          if (error instanceof GithubError) throw new GitConnectionError(error.status, error.message)
          throw error
        }
      } else {
        const { page, eligible, ProviderFailure } = await import('./gitlab-repositories.server')
        try {
          let verified = false
          for (let number = 1; number <= 100; number++) {
            const result = await page(token, number)
            verified = result.data.some(item => eligible(item) &&
              String(item.id) === repository.providerId && item.path_with_namespace === repository.name)
            if (verified || !result.next) break
          }
          if (!verified) throw new GitConnectionError(403, 'GitLab repository is not writable using this connection.')
        } catch (error) {
          if (error instanceof ProviderFailure) throw new GitConnectionError(error.status, error.message)
          throw error
        }
      }
      const updated = store.sqlite.prepare(`UPDATE repositories SET connection_id=?
        WHERE id=? AND owner_user_id=? AND provider=? AND name=? AND provider_repository_id=?
        AND EXISTS(SELECT 1 FROM git_connections WHERE id=? AND owner_user_id=? AND status='connected')`)
        .run(connection.id, repository.id, actor.id, repository.provider, repository.name,
          repository.providerId, connection.id, actor.id).changes
      if (!updated) throw new GitConnectionError(409, 'Repository or connection changed during verification. Retry.')
      return response({ rebound: true, repositoryId: repository.id, connectionId: connection.id })
    }
    if (request.method === 'DELETE') {
      if (!body || typeof body.connectionId !== 'string') throw new GitConnectionError(422, 'Connection ID required.')
      // Keep the binding and identity so disconnect cannot silently switch to an unrelated credential.
      const changed = store.sqlite.prepare(`UPDATE git_connections SET status='disconnected',
        credentials='',access_expires_at=NULL,refresh_expires_at=NULL,revision=revision+1,
        refresh_lease_id=NULL,refresh_lease_until=NULL,updated_at=? WHERE id=? AND owner_user_id=?`)
        .run(new Date().toISOString(), body.connectionId, actor.id).changes
      if (!changed) throw new GitConnectionError(404, 'Connection not found.')
      return response({ connections: listGitConnections(store, actor.id) })
    }
    if (body?.provider !== 'github' && body?.provider !== 'gitlab')
      throw new GitConnectionError(422, 'Choose GitHub or GitLab.')
    const provider = body.provider
    store.sqlite.prepare('DELETE FROM git_connection_flows WHERE expires_at<?').run(Date.now())
    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    store.sqlite.prepare(`INSERT INTO git_connection_flows
      (state_hash,owner_user_id,provider,verifier,expires_at) VALUES (?,?,?,?,?)`)
      .run(digest(state), actor.id, provider, verifier, Date.now() + 10 * 60_000)
    const url = new URL(provider === 'github'
      ? 'https://github.com/login/oauth/authorize' : 'https://gitlab.com/oauth/authorize')
    const client = provider === 'github' ? config.github : config.gitlab
    url.searchParams.set('client_id', client.clientId)
    url.searchParams.set('redirect_uri', oauthRedirect(config.baseURL, provider))
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', state)
    url.searchParams.set('scope', provider === 'github' ? 'offline_access' : 'api write_repository')
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
    url.searchParams.set('code_challenge_method', 'S256')
    return response({ authorizationUrl: url.toString() })
  } catch (error) { return errorResponse(error) }
}

export async function gitConnectionCallback(auth: StudioAuth, store: StudioDatabase, request: Request,
  provider: GitProvider, config: StudioAuthConfig = readAuthConfig()): Promise<Response> {
  const success = (query: string) => Response.redirect(config.baseURL + '/settings?' + query, 303)
  const url = new URL(request.url)
  const state = url.searchParams.get('state')
  if (!state || !/^[a-zA-Z0-9_-]{43}$/.test(state)) return success('integration_error=invalid_state')
  // Atomically consume the state exactly once before exchanging the authorization code.
  const row = store.sqlite.prepare(`DELETE FROM git_connection_flows
    WHERE state_hash=? AND provider=? AND expires_at>=?
    RETURNING owner_user_id AS owner, verifier`).get(digest(state), provider, Date.now()) as
      { owner: string; verifier: string } | undefined
  if (!row) return success('integration_error=expired')
  try {
    assertStudioSchemaCurrent(store)
    const actor = await requireUser(auth, request.headers)
    if (!actor || actor.id !== row.owner)
      return success('integration_error=session_mismatch')
    if (url.searchParams.has('error')) return success('integration_error=denied')
    const code = url.searchParams.get('code')
    if (!code || code.length > 4096) return success('integration_error=invalid_code')
    const client = provider === 'github' ? config.github : config.gitlab
    const params = new URLSearchParams({
      grant_type: 'authorization_code', client_id: client.clientId, client_secret: client.clientSecret,
      code, redirect_uri: oauthRedirect(config.baseURL, provider), code_verifier: row.verifier,
    })
    const tokens = await exchange(provider, params)
    const identity = await profile(provider, tokens.access)
    const sealed = seal(actor.id, provider, identity.id, { access: tokens.access, refresh: tokens.refresh }, config)
    const now = new Date().toISOString()
    store.sqlite.prepare(`INSERT INTO git_connections
      (id,owner_user_id,provider,provider_account_id,login,credentials,access_expires_at,refresh_expires_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(owner_user_id,provider,provider_account_id) DO UPDATE SET
        login=excluded.login, credentials=excluded.credentials, access_expires_at=excluded.access_expires_at,
        refresh_expires_at=excluded.refresh_expires_at, revision=git_connections.revision+1,
        status='connected', refresh_lease_id=NULL, refresh_lease_until=NULL, updated_at=excluded.updated_at`)
      .run(randomUUID(), actor.id, provider, identity.id, identity.login, sealed,
        tokens.accessExpiry, tokens.refreshExpiry, now, now)
    return success('integration_connected=' + provider)
  } catch (error) {
    console.error('[Studio Git integration] OAuth callback rejected', {
      provider, kind: error instanceof Error ? error.constructor.name : 'unknown',
    })
    return success('integration_error=authorization_failed')
  }
}

export async function tokenForGitConnection(store: StudioDatabase, owner: string, id: string,
  config: StudioAuthConfig = readAuthConfig()): Promise<string> {
  const initial = readConnection(store, owner, id)
  if (initial.status !== 'connected') throw new GitConnectionError(409, 'Git connection requires reauthorization.')
  if (initial.refreshLeaseId) {
    if (!initial.refreshLeaseUntil || initial.refreshLeaseUntil <= Date.now()) {
      // The prior outcome is unknowable after a worker crash. The old one-time
      // refresh token must not be replayed; require explicit reauthorization.
      store.sqlite.prepare(`UPDATE git_connections SET status='reauthorize'
        WHERE id=? AND owner_user_id=? AND revision=? AND refresh_lease_id=?`)
        .run(id, owner, initial.revision, initial.refreshLeaseId)
      throw new GitConnectionError(409, 'Git credential refresh was interrupted. Reauthorize this connection.')
    }
    throw new GitConnectionError(409, 'Git connection is refreshing. Retry shortly.')
  }
  if (!initial.accessExpiresAt || initial.accessExpiresAt > Date.now() + 90_000)
    return unseal(initial, config).access
  if (initial.refreshExpiresAt && initial.refreshExpiresAt < Date.now()) {
    store.sqlite.prepare(`UPDATE git_connections SET status='reauthorize'
      WHERE id=? AND owner_user_id=? AND revision=?`).run(id, owner, initial.revision)
    throw new GitConnectionError(409, 'Git refresh authorization expired. Reconnect.')
  }
  const tokens = unseal(initial, config)
  if (!tokens.refresh) {
    store.sqlite.prepare(`UPDATE git_connections SET status='reauthorize'
      WHERE id=? AND owner_user_id=? AND revision=?`).run(id, owner, initial.revision)
    throw new GitConnectionError(409, 'Git connection requires reauthorization.')
  }
  const lease = randomUUID()
  const updated = store.sqlite.prepare(`UPDATE git_connections
    SET refresh_lease_id=?,refresh_lease_until=? WHERE id=? AND owner_user_id=? AND revision=?
      AND status='connected' AND (refresh_lease_until IS NULL OR refresh_lease_until<?)`)
    .run(lease, Date.now() + 30_000, id, owner, initial.revision, Date.now()).changes
  if (!updated) throw new GitConnectionError(409, 'Git connection is refreshing. Retry shortly.')
  try {
    const client = initial.provider === 'github' ? config.github : config.gitlab
    const refreshed = await exchange(initial.provider, new URLSearchParams({
      client_id: client.clientId, client_secret: client.clientSecret,
      grant_type: 'refresh_token', refresh_token: tokens.refresh,
    }))
    const sealed = seal(owner, initial.provider, initial.providerAccountId, {
      access: refreshed.access, refresh: refreshed.refresh ?? tokens.refresh,
    }, config)
    const changed = store.sqlite.prepare(`UPDATE git_connections
      SET credentials=?, access_expires_at=?,refresh_expires_at=?, revision=revision+1,
        refresh_lease_id=NULL,refresh_lease_until=NULL,updated_at=?
      WHERE id=? AND owner_user_id=? AND revision=? AND refresh_lease_id=?`)
      .run(sealed, refreshed.accessExpiry, refreshed.refreshExpiry ?? initial.refreshExpiresAt,
        new Date().toISOString(), id, owner, initial.revision, lease).changes
    if (!changed) throw new GitConnectionError(409, 'Git connection changed during token refresh.')
    return refreshed.access
  } catch (error) {
    // A refresh grant may be one-time. Never replay it after an uncertain response.
    store.sqlite.prepare(`UPDATE git_connections SET status='reauthorize',
      refresh_lease_id=NULL,refresh_lease_until=NULL WHERE id=? AND owner_user_id=? AND refresh_lease_id=?`)
      .run(id, owner, lease)
    throw error
  }
}
