import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { getRepositoryToken, requireUser } from './access.server'

type Options = { appSlug: string; baseURL: string }
type Actor = { id: string; token: string }
type Installation = {
  id: number
  account: { login: string; type: string }
  repository_selection: 'all' | 'selected'
  suspended_at: string | null
  permissions: Record<string, string>
}
type GithubRepository = {
  id: number
  full_name: string
  private: boolean
  permissions?: { push?: boolean }
}
type Page<T> = { total_count: number; repositories?: T[]; installations?: T[] }

class GithubError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}
function errorResponse(error: unknown) {
  if (error instanceof GithubError) return json({ error: error.message }, error.status)
  // Never reflect provider responses, tokens, or account identifiers in errors.
  return json({ error: 'GitHub is temporarily unavailable. Try again later.' }, 502)
}

export function readGithubAppOptions(env: NodeJS.ProcessEnv = process.env): Options {
  const appSlug = env.GITHUB_APP_SLUG
  if (!appSlug || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(appSlug)) throw new Error('GITHUB_APP_SLUG is required for GitHub repository connections')
  if (!env.BETTER_AUTH_URL) throw new Error('BETTER_AUTH_URL is required')
  return { appSlug, baseURL: new URL(env.BETTER_AUTH_URL).origin }
}

function normalizeFullName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 300) throw new GithubError(400, 'Enter a GitHub repository URL or owner/repository')
  let name = raw.trim()
  if (name.startsWith('https://')) {
    let url: URL
    try { url = new URL(name) } catch { throw new GithubError(400, 'Invalid GitHub repository URL') }
    if (url.hostname.toLowerCase() !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) {
      throw new GithubError(400, 'Only GitHub repository URLs are supported')
    }
    name = url.pathname.replace(/^\//, '').replace(/\/$/, '')
  }
  name = name.replace(/\.git$/i, '')
  if (!/^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/i.test(name) || name.includes('..') || name.endsWith('/.')) {
    throw new GithubError(400, 'Enter owner/repository or https://github.com/owner/repository')
  }
  return name
}

async function actorFor(auth: StudioAuth, store: StudioDatabase, headers: Headers): Promise<Actor | Response> {
  const user = await requireUser(auth, headers)
  if (!user) return json({ error: 'Sign in required' }, 401)
  const token = await getRepositoryToken(auth, store, headers, 'github')
  if (!token) return json({ error: 'Connect your GitHub identity before adding repositories' }, 409)
  return { id: user.id, token }
}

async function github<T>(token: string, path: string): Promise<T> {
  // Paths are assembled here from validated numeric IDs, never an arbitrary URL.
  let response: Response
  try {
    response = await fetch('https://api.github.com' + path, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'NovelTea-Studio',
      },
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    })
  } catch {
    throw new GithubError(502, 'Could not contact GitHub. Try again.')
  }
  if (response.status === 401) throw new GithubError(409, 'GitHub authorization expired. Reconnect your GitHub account.')
  if (response.status === 403 || response.status === 429) throw new GithubError(503, 'GitHub denied or rate-limited the request. Check permissions and retry.')
  if (response.status === 404) throw new GithubError(404, 'GitHub installation or repository not accessible.')
  if (!response.ok) throw new GithubError(502, 'GitHub is temporarily unavailable. Try again.')
  try { return await response.json() as T } catch { throw new GithubError(502, 'GitHub returned an invalid response.') }
}

async function installations(token: string): Promise<Installation[]> {
  const result: Installation[] = []
  for (let page = 1; page <= 20; page++) {
    const body = await github<Page<Installation>>(token, `/user/installations?per_page=100&page=${page}`)
    if (!Array.isArray(body.installations) || !Number.isSafeInteger(body.total_count)) throw new GithubError(502, 'GitHub returned an invalid installation list')
    result.push(...body.installations)
    if (result.length >= body.total_count) return result
  }
  throw new GithubError(503, 'Too many installations to enumerate safely')
}

async function repositoryPage(token: string, installationId: number, page: number) {
  const body = await github<Page<GithubRepository>>(token, `/user/installations/${installationId}/repositories?per_page=100&page=${page}`)
  if (!Array.isArray(body.repositories) || !Number.isSafeInteger(body.total_count)) throw new GithubError(502, 'GitHub returned an invalid repository list')
  return { total: body.total_count, entries: body.repositories }
}

function usable(installation: Installation) {
  return !installation.suspended_at && installation.permissions?.contents === 'write'
}

async function matchingRepository(token: string, fullName: string, onlyInstallationId?: number) {
  const all = (await installations(token)).filter(usable)
  let forbidden = false
  for (const install of all) {
    if (onlyInstallationId && install.id !== onlyInstallationId) continue
    for (let page = 1; page <= 100; page++) {
      const result = await repositoryPage(token, install.id, page)
      for (const repo of result.entries) {
        if (repo.full_name.toLowerCase() !== fullName.toLowerCase()) continue
        if (!repo.permissions?.push) { forbidden = true; continue }
        return repo
      }
      if (page * 100 >= result.total) break
      if (page === 100) throw new GithubError(503, 'Repository listing is too large; narrow the installation')
    }
  }
  if (forbidden) throw new GithubError(403, 'You need push access to this repository')
  throw new GithubError(404, 'Repository not available through your GitHub App installations. Install or update the App to grant access.')
}

async function importRepository(store: StudioDatabase, actor: Actor, fullName: string, installationId?: number) {
  const repo = await matchingRepository(actor.token, fullName, installationId)
  const now = new Date().toISOString()
  const id = randomUUID()
  store.sqlite.prepare(`
    INSERT INTO repositories (id,owner_user_id,provider,provider_repository_id,name,created_at)
    VALUES (?,?,'github',?,?,?)
    ON CONFLICT(owner_user_id,provider,provider_repository_id) DO UPDATE SET name=excluded.name
  `).run(id, actor.id, String(repo.id), repo.full_name, now)
  const row = store.sqlite.prepare(`
    SELECT id, name, provider FROM repositories WHERE owner_user_id=? AND provider='github' AND provider_repository_id=?
  `).get(actor.id, String(repo.id)) as { id: string; name: string; provider: string }
  store.sqlite.prepare('DELETE FROM github_install_flows WHERE owner_user_id=? AND lower(desired_repository)=lower(?) AND status=?')
    .run(actor.id, repo.full_name, 'pending')
  return row
}

function sameOrigin(request: Request, options: Options) {
  return request.headers.get('origin') === options.baseURL
}

export async function githubRepositoryRequest(auth: StudioAuth, store: StudioDatabase, request: Request, options: Options): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (request.method === 'POST' && !sameOrigin(request, options)) return json({ error: 'Cross-origin write refused' }, 403)
  try {
    const actor = await actorFor(auth, store, request.headers)
    if (actor instanceof Response) return actor
    if (request.method === 'POST') {
      const body = await request.json().catch(() => null)
      const fullName = normalizeFullName(body?.fullName)
      return json({ repository: await importRepository(store, actor, fullName) })
    }
    const params = new URL(request.url).searchParams
    const all = await installations(actor.token)
    const chosen = params.get('installationId')
    const pageString = params.get('page') || '1'
    if (!/^[1-9]\d*$/.test(pageString) || Number(pageString) > 100) return json({ error: 'Invalid page' }, 400)
    const page = Number(pageString)
    const visible = all.map(i => ({
      id: i.id, account: i.account.login, accountType: i.account.type,
      selection: i.repository_selection, suspended: !!i.suspended_at,
      canImport: usable(i),
      // Only GitHub-owned, derived URLs, not provider-supplied links.
      settingsUrl: i.account.type === 'Organization'
        ? `https://github.com/organizations/${encodeURIComponent(i.account.login)}/settings/installations/${i.id}`
        : `https://github.com/settings/installations/${i.id}`,
    }))
    const pending = (store.sqlite.prepare(`SELECT desired_repository FROM github_install_flows
      WHERE owner_user_id=? AND status='pending' AND expires_at>? AND desired_repository IS NOT NULL
      ORDER BY created_at DESC`).all(actor.id, Date.now()) as Array<{ desired_repository: string }>).map(row => row.desired_repository)
    if (!chosen) return json({ installations: visible, pending })
    if (!/^[1-9]\d*$/.test(chosen) || !all.some(i => String(i.id) === chosen)) return json({ error: 'Installation not accessible' }, 404)
    const install = all.find(i => String(i.id) === chosen)!
    if (!usable(install)) return json({ error: 'Installation suspended or lacking Contents: write permission' }, 403)
    const result = await repositoryPage(actor.token, install.id, page)
    return json({ installations: visible, repositories: result.entries
      .filter(repo => repo.permissions?.push)
      .map(repo => ({ id: repo.id, fullName: repo.full_name, private: repo.private })),
      total: result.total, page, hasMore: page * 100 < result.total, pending })
  } catch (error) { return errorResponse(error) }
}

export async function githubInstallStart(auth: StudioAuth, store: StudioDatabase, request: Request, options: Options): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!sameOrigin(request, options)) return json({ error: 'Cross-origin write refused' }, 403)
  try {
    const actor = await actorFor(auth, store, request.headers)
    if (actor instanceof Response) return actor
    const body = await request.json().catch(() => null)
    const desired = body?.fullName ? normalizeFullName(body.fullName) : null
    store.sqlite.prepare('DELETE FROM github_install_flows WHERE expires_at < ?').run(Date.now())
    const state = randomBytes(32).toString('base64url')
    store.sqlite.prepare(`INSERT INTO github_install_flows
      (state_hash, owner_user_id, desired_repository, created_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, 'started')`)
      .run(createHash('sha256').update(state).digest('hex'), actor.id, desired, Date.now(), Date.now() + 20 * 60_000)
    const url = new URL(`https://github.com/apps/${options.appSlug}/installations/new`)
    url.searchParams.set('state', state)
    const response = json({ url: url.toString() })
    response.headers.set('Set-Cookie', `nt-gh-install-state=${state}; HttpOnly; SameSite=Lax; Path=/api/github/install/callback; Max-Age=1200${options.baseURL.startsWith('https:') ? '; Secure' : ''}`)
    return response
  } catch (error) { return errorResponse(error) }
}

export async function githubInstallCallback(auth: StudioAuth, store: StudioDatabase, request: Request, options: Options): Promise<Response> {
  const redirect = (result: string) => {
    return new Response(null, { status: 303, headers: {
      Location: `${options.baseURL}/repositories/add?result=${result}`,
      'Cache-Control': 'no-store',
      'Set-Cookie': `nt-gh-install-state=; HttpOnly; SameSite=Lax; Path=/api/github/install/callback; Max-Age=0${options.baseURL.startsWith('https:') ? '; Secure' : ''}`,
    } })
  }
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405)
  try {
    const actor = await actorFor(auth, store, request.headers)
    if (actor instanceof Response) return redirect('invalid')
    const params = new URL(request.url).searchParams
    const cookieState = request.headers.get('cookie')?.split(';').map(part => part.trim())
      .find(part => part.startsWith('nt-gh-install-state='))?.slice('nt-gh-install-state='.length)
    const state = params.get('state') || cookieState
    // An unsolicited GitHub setup/update redirect is navigation only.
    if (!state) return redirect('installed')
    if (!/^[a-zA-Z0-9_-]{43}$/.test(state)) return redirect('invalid')
    const digest = createHash('sha256').update(state).digest('hex')
    // Consume atomically, bound to this authenticated actor and single use.
    const row = store.sqlite.prepare(`UPDATE github_install_flows SET status='used'
      WHERE state_hash=? AND owner_user_id=? AND status='started' AND expires_at>?
      RETURNING desired_repository`).get(digest, actor.id, Date.now()) as { desired_repository: string | null } | undefined
    if (!row) return redirect('invalid')
    const installId = params.get('installation_id')
    if (!installId || !/^[1-9]\d*$/.test(installId)) {
      store.sqlite.prepare("UPDATE github_install_flows SET status='pending', expires_at=? WHERE state_hash=?")
        .run(Date.now() + 24 * 60 * 60_000, digest)
      return redirect('pending')
    }
    const found = (await installations(actor.token)).some(install => String(install.id) === installId && usable(install))
    if (!found) {
      store.sqlite.prepare(`UPDATE github_install_flows SET status='pending', expires_at=? WHERE state_hash=?`)
        .run(Date.now() + 24 * 60 * 60_000, digest)
      return redirect('pending')
    }
    if (!row.desired_repository) return redirect('installed')
    try {
      await importRepository(store, actor, row.desired_repository, Number(installId))
      return redirect('added')
    } catch (error) {
      if (error instanceof GithubError && [403, 404, 503].includes(error.status)) {
        store.sqlite.prepare(`UPDATE github_install_flows SET status='pending', expires_at=? WHERE state_hash=?`)
          .run(Date.now() + 24 * 60 * 60_000, digest)
        return redirect('pending')
      }
      throw error
    }
  } catch { return redirect('pending') }
}
