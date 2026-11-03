import { randomUUID } from 'node:crypto'
import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { requireUser, getRepositoryToken, selectGitConnection } from './access.server'
import { GitConnectionError } from './git-connections.server'

type Project = {
  id: number; path_with_namespace: string; name_with_namespace: string
  web_url: string; visibility: string; archived: boolean; empty_repo?: boolean
  permissions?: { project_access?: { access_level: number } | null; group_access?: { access_level: number } | null }
}

export class ProviderFailure extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
export const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
export function failure(err: unknown) {
  if (err instanceof ProviderFailure) return reply({ error: err.message }, err.status)
  if (err instanceof GitConnectionError) return reply({ error: err.message }, err.statusCode)
  const incident = randomUUID().slice(0, 8)
  console.error(`[Studio GitLab ${incident}] Unexpected server failure`, {
    name: err instanceof Error ? err.name : typeof err,
    code: err && typeof err === 'object' && 'code' in err ? String(err.code).slice(0, 40) : undefined,
    stack: err instanceof Error ? err.stack?.split('\n').slice(1, 8).join('\n') : undefined,
  })
  return reply({ error: `Studio encountered an internal error (reference ${incident}). Check the server logs.` }, 500)
}
export async function gitlab<T>(token: string, path: string): Promise<{ data: T; next: number | null }> {
  let response: Response
  try {
    response = await fetch('https://gitlab.com/api/v4' + path, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(10000),
    })
  } catch { throw new ProviderFailure(502, 'Could not contact GitLab. Retry later.') }
  if (response.status === 401) throw new ProviderFailure(409, 'GitLab authorization expired or was revoked. Reconnect GitLab.')
  if (response.status === 403) throw new ProviderFailure(403, 'GitLab denied access. Check group membership and OAuth permissions.')
  if (response.status === 429) throw new ProviderFailure(503, 'GitLab API rate limit reached. Retry later.')
  if (response.status === 404) throw new ProviderFailure(404, 'GitLab project, commit or path was not found.')
  if (!response.ok) throw new ProviderFailure(502, 'GitLab project lookup failed. Retry later.')
  let data: T
  try { data = await response.json() as T } catch { throw new ProviderFailure(502, 'GitLab returned invalid JSON') }
  const nextRaw = response.headers.get('x-next-page')
  const next = nextRaw && /^[1-9]\d*$/.test(nextRaw) ? Number(nextRaw) : null
  return { data, next }
}
export async function actor(auth: StudioAuth, store: StudioDatabase, headers: Headers,
  repositoryId?: string, connectionId?: string) {
  const user = await requireUser(auth, headers)
  if (!user) throw new ProviderFailure(401, 'Sign in required')
  let token: string | null
  try { token = await getRepositoryToken(auth, store, headers, 'gitlab', repositoryId, connectionId) }
  catch (error) {
    if (error instanceof GitConnectionError) throw error
    throw new ProviderFailure(409, 'GitLab authorization expired or was revoked. Reconnect GitLab.')
  }
  if (!token) throw new ProviderFailure(409, 'Link your GitLab account to connect projects')
  return { id: user.id, token }
}
export function eligible(project: Project) {
  return Number.isSafeInteger(project.id) && project.id > 0 &&
    typeof project.path_with_namespace === 'string' &&
    typeof project.name_with_namespace === 'string' && !project.archived
}
export async function page(token: string, number: number) {
  const result = await gitlab<Project[]>(token, `/projects?membership=true&min_access_level=30&simple=false&per_page=100&page=${number}&order_by=id&sort=asc`)
  if (!Array.isArray(result.data)) throw new ProviderFailure(502, 'GitLab returned an invalid project list')
  return result
}
export async function gitlabRepositoryRequest(auth: StudioAuth, store: StudioDatabase, request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405)
  if (request.method === 'POST') {
    const origin = new URL(request.url).origin
    if (request.headers.get('origin') !== origin) return reply({ error: 'Cross-origin write refused' }, 403)
  }
  try {
    const submitted = request.method === 'POST' ? await request.clone().json().catch(() => null) : null
    const selected = request.method === 'GET' ? new URL(request.url).searchParams.get('connectionId') : submitted?.connectionId
    const requestedConnection = typeof selected === 'string' && selected ? selected : undefined
    const viewer = await requireUser(auth, request.headers)
    if (!viewer) return reply({ error: 'Sign in required.' }, 401)
    const connectionId = selectGitConnection(store, viewer.id, 'gitlab', requestedConnection)
    const user = await actor(auth, store, request.headers, undefined, connectionId)
    if (request.method === 'GET') {
      const raw = new URL(request.url).searchParams.get('page') || '1'
      if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 100) return reply({ error: 'Invalid page' }, 400)
      const result = await page(user.token, Number(raw))
      return reply({ projects: result.data.filter(eligible).map(project => ({
        id: project.id, name: project.name_with_namespace, path: project.path_with_namespace,
        visibility: project.visibility, empty: !!project.empty_repo,
      })), page: Number(raw), nextPage: result.next })
    }
    const body = await request.json().catch(() => null)
    if (!Number.isSafeInteger(body?.projectId) || body.projectId <= 0) return reply({ error: 'Invalid GitLab project' }, 400)
    // Re-list via the authenticated membership endpoint at commit time.
    // Never trust browser IDs, path strings, visibility or push claims.
    let matched: Project | undefined
    for (let i = 1; i <= 100; i++) {
      const result = await page(user.token, i)
      matched = result.data.find(p => p.id === body.projectId && eligible(p))
      if (matched) break
      if (!result.next) break
      if (i === 100) throw new ProviderFailure(503, 'Too many projects to verify safely')
    }
    if (!matched) return reply({ error: 'Project not found among your push-access GitLab projects' }, 403)
    store.sqlite.prepare(`INSERT INTO repositories (id, owner_user_id, provider, provider_repository_id, name, created_at, connection_id)
      VALUES (?, ?, 'gitlab', ?, ?, ?, ?)
      ON CONFLICT(owner_user_id, provider, provider_repository_id) DO UPDATE SET name=excluded.name
      -- Existing binding changes require explicit Settings rebinding after verification.`)
      .run(randomUUID(), user.id, String(matched.id), matched.path_with_namespace, new Date().toISOString(), connectionId ?? null)
    const repository = store.sqlite.prepare(`SELECT id, name, provider FROM repositories
      WHERE owner_user_id=? AND provider='gitlab' AND provider_repository_id=?`).get(user.id, String(matched.id))
    return reply({ repository })
  } catch (err) { return failure(err) }
}
