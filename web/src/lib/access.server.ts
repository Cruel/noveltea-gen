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
    const hasLogin = !!store.sqlite.prepare('SELECT 1 FROM account WHERE userId=? AND providerId=?')
      .get(actor.id, provider)
    const hasIntegration = !!store.sqlite.prepare(`SELECT 1 FROM git_connections
      WHERE owner_user_id=? AND provider=? AND status!='disconnected'`).get(actor.id, provider)
    const repo = store.sqlite.prepare(`SELECT connection_id AS connectionId FROM repositories
      WHERE id=? AND owner_user_id=? AND provider=?`).get(repositoryId, actor.id, provider) as
        { connectionId: string | null } | undefined
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
    connectionId = selectGitConnection(store, actor.id, provider)
  }
  if (connectionId) {
    const row = store.sqlite.prepare('SELECT provider FROM git_connections WHERE id=? AND owner_user_id=?')
      .get(connectionId, actor.id) as { provider: string } | undefined
    if (!row || row.provider !== provider) throw new GitConnectionError(403, 'Invalid provider connection selection.')
    return tokenForGitConnection(store, actor.id, connectionId, config)
  }
  const accounts = store.sqlite.prepare(
    'SELECT id FROM account WHERE userId=? AND providerId=?',
  ).all(actor.id, provider) as Array<{ id: string }>
  if (accounts.length > 1) throw new GitConnectionError(409,
    'Multiple legacy login identities exist. Connect a dedicated repository identity in Settings.')
  if (!accounts.length) return null
  const token = await auth.api.getAccessToken({ headers, body: { accountId: accounts[0]!.id } })
  return token.accessToken
}

// Used by both token selection and catalog imports. A new repository must
// persist the same credential selection that authorized the provider lookup.
export function selectGitConnection(store: StudioDatabase, owner: string,
  provider: 'github' | 'gitlab', requestedId?: string): string | undefined {
  if (requestedId) {
    const match = store.sqlite.prepare(`SELECT id,status FROM git_connections
      WHERE id=? AND owner_user_id=? AND provider=?`)
      .get(requestedId, owner, provider) as { id: string; status: string } | undefined
    if (!match) throw new GitConnectionError(403, 'Invalid Git connection selection.')
    if (match.status !== 'connected') throw new GitConnectionError(409, 'Git connection requires reauthorization.')
    return match.id
  }
  const connections = listGitConnections(store, owner)
    .filter(item => item.provider === provider && item.status !== 'disconnected')
  if (connections.length > 1)
    throw new GitConnectionError(409, 'Choose which ' + provider + ' account to use for this operation.')
  if (connections[0]?.status === 'reauthorize')
    throw new GitConnectionError(409, 'Git connection requires reauthorization.')
  return connections[0]?.id
}

export function repositoryForStory(store: StudioDatabase, owner: string, storyId: unknown,
  provider: 'github' | 'gitlab'): string | undefined {
  if (typeof storyId !== 'string') return undefined
  const row = store.sqlite.prepare(`SELECT r.id FROM stories s JOIN repositories r
    ON s.repository_id=r.id AND s.owner_user_id=r.owner_user_id
    WHERE s.id=? AND s.owner_user_id=? AND r.provider=?`)
    .get(storyId, owner, provider) as { id: string } | undefined
  return row?.id
}

export async function dashboardResponse(auth: StudioAuth, store: StudioDatabase, request: Request): Promise<Response> {
  const dashboard = await getDashboardData(auth, store, request.headers)
  if (!dashboard) return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
  return Response.json(dashboard, { headers: { 'Cache-Control': 'no-store' } })
}
