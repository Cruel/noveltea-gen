import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { readUserDashboard } from './catalog'

export async function requireUser(auth: StudioAuth, headers: Headers) {
  const session = await auth.api.getSession({ headers })
  if (!session?.user?.id) return null
  return { id: session.user.id, name: session.user.name, email: session.user.email }
}

export async function getDashboardData(auth: StudioAuth, store: StudioDatabase, headers: Headers) {
  const user = await requireUser(auth, headers)
  if (!user) return null
  const accounts = await auth.api.listUserAccounts({ headers })
  const providers = accounts
    .filter(account => account.providerId === 'github' || account.providerId === 'gitlab')
    .map(account => account.providerId)
  return { user, connectedProviders: [...new Set(providers)], ...readUserDashboard(store, user.id) }
}

// This is also the service boundary for server-side Git adapters. Caller input
// never selects a user or a Better Auth account ID.
export async function getRepositoryToken(
  auth: StudioAuth, store: StudioDatabase, headers: Headers, provider: 'github' | 'gitlab',
) {
  const actor = await requireUser(auth, headers)
  if (!actor) return null
  const account = store.sqlite.prepare(
    'SELECT id FROM account WHERE userId = ? AND providerId = ? ORDER BY createdAt DESC LIMIT 1',
  ).get(actor.id, provider) as { id: string } | undefined
  if (!account) return null
  const token = await auth.api.getAccessToken({ headers, body: { accountId: account.id } })
  return token.accessToken
}

export async function dashboardResponse(auth: StudioAuth, store: StudioDatabase, request: Request): Promise<Response> {
  const dashboard = await getDashboardData(auth, store, request.headers)
  if (!dashboard) return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
  return Response.json(dashboard, { headers: { 'Cache-Control': 'no-store' } })
}
