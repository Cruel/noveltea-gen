import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import type { StudioAuth } from './auth'
import { readAuthConfig, type StudioAuthConfig } from './auth'
import type { StudioStore as StudioDatabase } from '../persistence/store'
import { requireUser } from './session.server'
import { JsonInputError, readJsonInput } from './json-input.server'
import type { GitConnectionRecord, GitProvider } from '../persistence/git-contracts'

export type { GitProvider } from '../persistence/git-contracts'
type Tokens = { access: string; refresh: string | null }
type Connection = GitConnectionRecord
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
async function readConnection(store: StudioDatabase, owner: string, id: string): Promise<Connection> {
  const row = await store.persistence.git.read(owner, id)
  if (!row) throw new GitConnectionError(404, 'Git connection not found for this user.')
  return row
}
export async function listGitConnections(store: StudioDatabase, owner: string) {
  return store.persistence.git.list(owner)
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
export async function readGitAccountProfile(provider: GitProvider, token: string,
  timeoutMs = 10000): Promise<{ id: string; login: string }> {
  const endpoint = provider === 'github' ? 'https://api.github.com/user' : 'https://gitlab.com/api/v4/user'
  let result: Response
  try {
    result = await fetch(endpoint, { headers: {
      Authorization: 'Bearer ' + token, Accept: 'application/json', 'User-Agent': 'NovelTea-Studio',
    }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
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
    await store.assertReady()
    const actor = await requireUser(auth, request.headers)
    if (!actor) throw new GitConnectionError(401, 'Sign in required.')
    if (request.method === 'GET') return response({ connections: await listGitConnections(store, actor.id) })
    if (request.method !== 'POST' && request.method !== 'DELETE' && request.method !== 'PUT')
      throw new GitConnectionError(405, 'Method not allowed.')
    if (request.headers.get('origin') !== config.baseURL)
      throw new GitConnectionError(403, 'Cross-origin request refused.')
    const body = await readJsonInput(request) as { provider?: unknown; connectionId?: unknown; repositoryId?: unknown } | null
    if (request.method === 'PUT') {
      if (!body || (body.connectionId !== null && (typeof body.connectionId !== 'string' ||
          !/^[0-9a-f-]{36}$/i.test(body.connectionId))) || typeof body.repositoryId !== 'string' ||
          !/^[0-9a-f-]{36}$/i.test(body.repositoryId))
        throw new GitConnectionError(422, 'Choose a repository and Git account.')
      const repository = await store.persistence.repositories.get(actor.id, body.repositoryId)
      if (!repository) throw new GitConnectionError(404, 'Repository not found for this Studio user.')
      let token: string
      if (body.connectionId === null) {
        const logins = await store.persistence.git.legacyAccounts(actor.id, repository.provider)
        if (logins.length !== 1) throw new GitConnectionError(409,
          'Exactly one Studio login for this provider is required to use login-based repository access.')
        try {
          const credential = await auth.api.getAccessToken({ headers: request.headers, body: { accountId: logins[0]! } })
          if (!credential.accessToken) throw new Error('No access token')
          token = credential.accessToken
        } catch {
          throw new GitConnectionError(409, 'Studio login authorization is unavailable. Reconnect the login method.')
        }
      } else {
        const connection = await readConnection(store, actor.id, body.connectionId)
        if (connection.provider !== repository.provider || connection.status !== 'connected')
          throw new GitConnectionError(409, 'Select an active account for this repository provider.')
        token = await tokenForGitConnection(store, actor.id, connection.id, config)
      }
      if (repository.provider === 'github') {
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
      const updated = await store.persistence.repositories.rebind(actor.id, repository, body.connectionId)
      if (!updated) throw new GitConnectionError(409, 'Repository or account changed during verification. Retry.')
      return response({ rebound: true, repositoryId: repository.id, connectionId: body.connectionId })
    }
    if (request.method === 'DELETE') {
      if (!body || typeof body.connectionId !== 'string') throw new GitConnectionError(422, 'Connection ID required.')
      // Keep the binding and identity so disconnect cannot silently switch to an unrelated credential.
      const changed = await store.persistence.git.disconnect(actor.id, body.connectionId, new Date().toISOString())
      if (!changed) throw new GitConnectionError(404, 'Connection not found.')
      return response({ connections: await listGitConnections(store, actor.id) })
    }
    if (body?.provider !== 'github' && body?.provider !== 'gitlab')
      throw new GitConnectionError(422, 'Choose GitHub or GitLab.')
    const provider = body.provider
    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const now = Date.now()
    await store.persistence.git.startFlow(actor.id, provider, digest(state), verifier,
      now + 10 * 60_000, now)
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
  const row = await store.persistence.git.consumeFlow(digest(state), provider, Date.now())
  if (!row) return success('integration_error=expired')
  try {
    await store.assertReady()
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
    const identity = await readGitAccountProfile(provider, tokens.access)
    const sealed = seal(actor.id, provider, identity.id, { access: tokens.access, refresh: tokens.refresh }, config)
    const now = new Date().toISOString()
    await store.persistence.git.connect({
      id: randomUUID(), owner: actor.id, provider, providerAccountId: identity.id,
      login: identity.login, credentials: sealed, accessExpiresAt: tokens.accessExpiry,
      refreshExpiresAt: tokens.refreshExpiry, now,
    })
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
  const initial = await readConnection(store, owner, id)
  if (initial.status !== 'connected') throw new GitConnectionError(409, 'Git connection requires reauthorization.')
  if (initial.refreshLeaseId) {
    if (!initial.refreshLeaseUntil || initial.refreshLeaseUntil <= Date.now()) {
      // The prior outcome is unknowable after a worker crash. The old one-time
      // refresh token must not be replayed; require explicit reauthorization.
      await store.persistence.git.requireReauthorization(owner, id, initial.revision, initial.refreshLeaseId)
      throw new GitConnectionError(409, 'Git credential refresh was interrupted. Reauthorize this connection.')
    }
    throw new GitConnectionError(409, 'Git connection is refreshing. Retry shortly.')
  }
  if (!initial.accessExpiresAt || initial.accessExpiresAt > Date.now() + 90_000)
    return unseal(initial, config).access
  if (initial.refreshExpiresAt && initial.refreshExpiresAt < Date.now()) {
    await store.persistence.git.requireReauthorization(owner, id, initial.revision)
    throw new GitConnectionError(409, 'Git refresh authorization expired. Reconnect.')
  }
  const tokens = unseal(initial, config)
  if (!tokens.refresh) {
    await store.persistence.git.requireReauthorization(owner, id, initial.revision)
    throw new GitConnectionError(409, 'Git connection requires reauthorization.')
  }
  const lease = randomUUID()
  const now = Date.now()
  const updated = await store.persistence.git.acquireRefreshLease(owner, id, initial.revision, lease,
    now + 30_000, now)
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
    const changed = await store.persistence.git.finishRefresh(owner, id, initial.revision, lease, {
      credentials: sealed, accessExpiresAt: refreshed.accessExpiry,
      refreshExpiresAt: refreshed.refreshExpiry ?? initial.refreshExpiresAt,
      now: new Date().toISOString(),
    })
    if (!changed) throw new GitConnectionError(409, 'Git connection changed during token refresh.')
    return refreshed.access
  } catch (error) {
    // A refresh grant may be one-time. Never replay it after an uncertain response.
    await store.persistence.git.failRefresh(owner, id, lease)
    throw error
  }
}
