import type { StudioAuth, StudioAuthConfig } from './auth'
import type { StudioDatabase } from '../db/connection'
import { readUserDashboard } from './catalog'
import { requireUser } from './session.server'
import { tokenForGitConnection, GitConnectionError, listGitConnections } from './git-connections.server'
export { requireUser } from './session.server'

export async function getDashboardData(auth: StudioAuth, store: StudioDatabase, headers: Headers) {
  const user = await requireUser(auth, headers)
  if (!user) return null
  const accounts = await auth.api.listUserAccounts({ headers })
  const providers = accounts
    .filter(account => account.providerId === 'github' || account.providerId === 'gitlab')
    .map(account => account.providerId)
  return { user, connectedProviders: [...new Set(providers)], ...(await readUserDashboard(store.persistence.dashboard, user.id)) }
}

// A repository's connection always wins over the user's other provider accounts.
// Historical repositories (connection_id=NULL) continue using the original login-backed
// credential until the owner explicitly rebinds them. Never select an arbitrary account.
export async function getRepositoryToken(
  auth: StudioAuth, store: StudioDatabase, headers: Headers, provider: 'github' | 'gitlab',
  repositoryId?: string, selectedConnectionId?: string, config?: StudioAuthConfig,
): Promise<string | null> {
  const actor = await requireUser(auth, headers)
  if (!actor) return null
  let connectionId = selectedConnectionId
  let historical = false
  if (repositoryId) {
    // Preserve the existing disconnected-provider behavior before checking the
    // caller's catalog. Never disclose whether a foreign repository exists.
    const hasLogin = (await store.persistence.git.legacyAccounts(actor.id, provider)).length > 0
    const hasIntegration = await store.persistence.git.hasActive(actor.id, provider)
    const repo = await store.persistence.repositories.get(actor.id, repositoryId, provider)
    if (!repo && !hasLogin && !hasIntegration) return null
    if (!repo) throw new GitConnectionError(404, 'Repository does not belong to this user.')
    if (!repo.connectionId && !hasLogin) {
      if (hasIntegration) throw new GitConnectionError(409,
        'This legacy repository needs a Git connection. Rebind it in Settings.')
      return null
    }
    if (selectedConnectionId && repo.connectionId !== selectedConnectionId)
      throw new GitConnectionError(409, 'Repository uses a different Git connection.')
    connectionId = repo.connectionId ?? undefined
    historical = !connectionId
  }
  if (!historical && !connectionId) {
    connectionId = await selectGitConnection(store, actor.id, provider)
  }
  if (connectionId) {
    const row = await store.persistence.git.read(actor.id, connectionId)
    if (!row || row.provider !== provider) throw new GitConnectionError(403, 'Invalid provider connection selection.')
    return tokenForGitConnection(store, actor.id, connectionId, config)
  }
  const accounts = await store.persistence.git.legacyAccounts(actor.id, provider)
  if (accounts.length > 1) throw new GitConnectionError(409,
    'Multiple legacy login identities exist. Connect a dedicated repository identity in Settings.')
  if (!accounts.length) return null
  const token = await auth.api.getAccessToken({ headers, body: { accountId: accounts[0]! } })
  return token.accessToken
}

// Used by both token selection and catalog imports. A new repository must
// persist the same credential selection that authorized the provider lookup.
export async function selectGitConnection(store: StudioDatabase, owner: string,
  provider: 'github' | 'gitlab', requestedId?: string): Promise<string | undefined> {
  if (requestedId) {
    const match = await store.persistence.git.read(owner, requestedId)
    if (match && match.provider !== provider) throw new GitConnectionError(403, 'Invalid Git connection selection.')
    if (!match) throw new GitConnectionError(403, 'Invalid Git connection selection.')
    if (match.status !== 'connected') throw new GitConnectionError(409, 'Git connection requires reauthorization.')
    return match.id
  }
  const connections = (await listGitConnections(store, owner))
    .filter(item => item.provider === provider && item.status !== 'disconnected')
  if (connections.length > 1)
    throw new GitConnectionError(409, 'Choose which ' + provider + ' account to use for this operation.')
  if (connections[0]?.status === 'reauthorize')
    throw new GitConnectionError(409, 'Git connection requires reauthorization.')
  return connections[0]?.id
}

export async function repositoryForStory(store: StudioDatabase, owner: string, storyId: unknown,
  provider: 'github' | 'gitlab'): Promise<string | undefined> {
  if (typeof storyId !== 'string') return undefined
  return (await store.persistence.repositories.repositoryForStory(owner, storyId, provider)) ?? undefined
}

export async function dashboardResponse(auth: StudioAuth, store: StudioDatabase, request: Request): Promise<Response> {
  const dashboard = await getDashboardData(auth, store, request.headers)
  if (!dashboard) return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
  return Response.json(dashboard, { headers: { 'Cache-Control': 'no-store' } })
}
