import type { StudioDatabase } from '../db/connection'
import type { StudioAuth } from './auth'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser, getRepositoryToken } from './access.server'
import { authorizedStoryJob } from './fixture-jobs.server'
import { github, matchingRepository, GithubError, errorResponse, json } from './github-repositories.server'
import { withStoryJobLock } from '../../../src/job-lock'
import type { JobStartResult } from '../../../src/job'
import {
  PublicationFailure, reviewPublication, publicationDescription, pushVerifiedBranch,
  remotePublicationHead, readPublicationRequest, type PublicationPreview,
} from './publication-review.server'

type Row = { id: string; title: string; repository: string; providerId: string; baseSha: string;
  directory: string; initialContentSha256: string | null }
type Saved = { prNumber: number | null; prUrl: string | null; targetBranch: string; remoteBranch: string; headSha: string; phase: string }
type GithubPr = {
  number: number; html_url: string; state: string; draft: boolean
  head: { ref: string; sha: string; repo: { id: number } | null }
  base: { ref: string }
}
type Remote = { id: number; default_branch: string }
const SHA = /^[a-f0-9]{40}$/i

function savedPublication(store: StudioDatabase, id: string): Saved | undefined {
  return store.sqlite.prepare(`SELECT pr_number AS prNumber, pr_url AS prUrl,
    target_branch AS targetBranch, remote_branch AS remoteBranch, head_sha AS headSha, phase
    FROM github_publications WHERE job_id=?`).get(id) as Saved | undefined
}
function savePublication(store: StudioDatabase, owner: string, job: JobStartResult, target: string,
  head: string, pr?: GithubPr) {
  store.sqlite.prepare(`INSERT INTO github_publications
    (job_id,owner_user_id,target_branch,remote_branch,head_sha,phase,pr_number,pr_url,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(job_id) DO UPDATE SET
      head_sha=CASE WHEN excluded.phase='linked' THEN excluded.head_sha ELSE github_publications.head_sha END,
      phase=excluded.phase, pr_number=COALESCE(excluded.pr_number, github_publications.pr_number),
      pr_url=COALESCE(excluded.pr_url, github_publications.pr_url), updated_at=excluded.updated_at`)
    .run(job.jobId, owner, target, job.branch, head, pr ? 'linked' : 'pending',
      pr?.number ?? null, pr?.html_url ?? null, new Date().toISOString())
}

function assertSafeBranch(branch: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,190}$/.test(branch) ||
      branch.split('/').some(part => !part || part === '.' || part === '..' || part.endsWith('.lock')) ||
      branch.endsWith('.') || branch.includes('..') || branch.includes('@{'))
    throw new GithubError(409, 'GitHub default branch is not a safe Git ref.')
}
async function remoteContext(token: string, row: Row) {
  const matching = await matchingRepository(token, row.repository)
  if (String(matching.id) !== row.providerId)
    throw new GithubError(409, 'Repository identity has changed; reconnect before publishing.')
  const path = '/repos/' + row.repository.split('/').map(encodeURIComponent).join('/')
  const repo = await github<Remote>(token, path)
  if (String(repo.id) !== row.providerId) throw new GithubError(409, 'Repository identity changed.')
  assertSafeBranch(repo.default_branch)
  const branch = await github<{ commit: { sha: string } }>(token, path + '/branches/' +
    encodeURIComponent(repo.default_branch))
  if (!SHA.test(branch.commit?.sha)) throw new GithubError(502, 'GitHub returned an invalid upstream revision.')
  return { path, target: repo.default_branch, targetSha: branch.commit.sha }
}
function readRow(store: StudioDatabase, owner: string, id: string): Row {
  const row = store.sqlite.prepare(`SELECT j.id, j.title, r.name AS repository,
    r.provider_repository_id AS providerId, j.source_commit_sha AS baseSha,
    s.directory, s.initial_content_sha256 AS initialContentSha256
    FROM studio_sessions j JOIN stories s ON j.story_id=s.id AND j.owner_user_id=s.owner_user_id
    JOIN repositories r ON s.repository_id=r.id AND s.owner_user_id=r.owner_user_id
    WHERE j.id=? AND j.owner_user_id=? AND r.provider='github'`).get(id, owner) as Row | undefined
  if (!row) throw new GithubError(404, 'GitHub job is not connected to this account.')
  if (!SHA.test(row.baseSha)) throw new GithubError(409, 'Missing pinned Story baseline.')
  return row
}
async function preview(store: StudioDatabase, owner: string, row: Row, job: JobStartResult,
  token: string, target: string, targetSha: string): Promise<PublicationPreview> {
  const saved = savedPublication(store, job.jobId)
  if (saved && (saved.targetBranch !== target || saved.remoteBranch !== job.branch))
    throw new GithubError(409, 'Saved publication targets a different upstream branch. Operator reconciliation required.')
  return reviewPublication(store, job, {
    repository: row.repository, directory: row.directory, initialContentSha256: row.initialContentSha256,
    remoteUrl: `https://github.com/${row.repository}.git`,
  }, token, target, targetSha, saved?.phase === 'linked' && saved.prNumber && saved.prUrl
    ? { number: saved.prNumber, url: saved.prUrl, headSha: saved.headSha, targetBranch: saved.targetBranch }
    : null)
}
async function writeGithub(token: string, path: string, method: 'POST' | 'PATCH', body: unknown): Promise<GithubPr> {
  let response: Response
  try {
    response = await fetch('https://api.github.com' + path, {
      method, headers: {
        Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'NovelTea-Studio',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000),
    })
  } catch { throw new GithubError(502, 'GitHub PR operation failed; retry to reconcile the existing remote PR.') }
  if (!response.ok) throw new GithubError(response.status === 401 ? 409 : 503,
    'GitHub rejected PR publication. Recheck authorization and retry; the branch is preserved.')
  const pr = await response.json().catch(() => null) as GithubPr | null
  if (!pr || !Number.isSafeInteger(pr.number) || typeof pr.html_url !== 'string')
    throw new GithubError(502, 'GitHub PR response could not be verified. Retry to reconcile.')
  return pr
}
function verifyPr(pr: GithubPr, repoId: string, branch: string, target: string) {
  if (String(pr.head?.repo?.id) !== repoId || pr.head.ref !== branch || pr.base?.ref !== target)
    throw new GithubError(409, 'Existing PR points to a different repository, branch or target. Reconcile manually.')
  if (pr.state !== 'open' || !pr.draft)
    throw new GithubError(409, 'Linked PR is closed or no longer a draft. Reconcile it on GitHub.')
}
async function findPr(token: string, path: string, repo: string, repoId: string,
  job: JobStartResult, target: string) {
  const owner = repo.split('/')[0]!
  const query = new URLSearchParams({ state: 'all', head: owner + ':' + job.branch, per_page: '100' })
  const pulls = await github<GithubPr[]>(token, path + '/pulls?' + query)
  if (!Array.isArray(pulls)) throw new GithubError(502, 'GitHub returned an invalid PR list.')
  const matches = pulls.filter(pr => pr.head?.ref === job.branch)
  if (matches.length > 1) throw new GithubError(409, 'More than one PR uses this job branch. Reconcile manually.')
  if (matches[0]) verifyPr(matches[0], repoId, job.branch, target)
  return matches[0] ?? null
}
async function publish(store: StudioDatabase, owner: string, row: Row, job: JobStartResult,
  token: string, expected: { headSha?: string; targetSha?: string; allowPartial?: boolean }) {
  return withStoryJobLock(job, 'github-draft-publication', async () => {
    const remote = await remoteContext(token, row)
    const view = await preview(store, owner, row, job, token, remote.target, remote.targetSha)
    if (expected.headSha !== view.headSha || expected.targetSha !== view.targetSha)
      throw new GithubError(409, 'Publication preview is stale. Refresh validation and upstream state.')
    if (!view.canPublish) throw new GithubError(422, 'Canonical validation or worktree safety blocks publication.')
    if (view.blockers.length && expected.allowPartial !== true)
      throw new GithubError(409, 'This is a partial or divergent draft. Explicitly confirm its listed blockers.')
    const existing = savedPublication(store, job.jobId)
    // An intent receipt precedes both the push and PR creation. Crash recovery
    // always reconciles remote refs and PRs before performing any new write.
    if (!existing) savePublication(store, owner, job, remote.target, view.headSha)
    const source = { repository: row.repository, directory: row.directory,
      initialContentSha256: row.initialContentSha256,
      remoteUrl: 'https://github.com/' + row.repository + '.git' }
    pushVerifiedBranch(job, source, token, view.headSha)
    savePublication(store, owner, job, remote.target, view.headSha)
    const targetAgain = await remoteContext(token, row)
    if (targetAgain.target !== remote.target || targetAgain.targetSha !== remote.targetSha)
      throw new GithubError(409, 'Upstream changed after push. Branch is preserved; refresh the publication preview.')
    const path = remote.path
    const saved = savedPublication(store, job.jobId)
    let pr: GithubPr | null = null
    if (saved?.prNumber) {
      pr = await github<GithubPr>(token, path + '/pulls/' + saved.prNumber)
      verifyPr(pr, row.providerId, job.branch, remote.target)
    } else pr = await findPr(token, path, row.repository, row.providerId, job, remote.target)
    const body = publicationDescription(job, view)
    if (!pr) {
      try {
        pr = await writeGithub(token, path + '/pulls', 'POST', {
          title: 'NovelTea Story: ' + row.title.slice(0, 120),
          head: job.branch, base: remote.target, draft: true, body,
        })
      } catch (error) {
        // A timeout or GitHub's 422 can mean CREATE succeeded remotely.
        pr = await findPr(token, path, row.repository, row.providerId, job, remote.target).catch(() => null)
        if (!pr) throw error
      }
    } else {
      pr = await writeGithub(token, path + '/pulls/' + pr.number, 'PATCH', { body })
    }
    verifyPr(pr, row.providerId, job.branch, remote.target)
    if (pr.head.sha !== view.headSha || remotePublicationHead(job, source, token, job.branch) !== view.headSha)
      throw new GithubError(409, 'GitHub PR or remote branch moved from the verified job HEAD. Reconcile before linking.')
    savePublication(store, owner, job, remote.target, view.headSha, pr)
    return { ...view, linked: { number: pr.number, url: pr.html_url,
      headSha: view.headSha, targetBranch: remote.target } }
  })
}

export async function githubPublicationRequest(auth: StudioAuth, store: StudioDatabase,
  request: Request, id: string, baseURL: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST')
    return json({ error: 'Method not allowed' }, 405)
  if (request.method === 'POST' && request.headers.get('origin') !== baseURL)
    return json({ error: 'Cross-origin write refused' }, 403)
  try {
    assertStudioSchemaCurrent(store)
    const actor = await requireUser(auth, request.headers)
    if (!actor) return json({ error: 'Sign in required' }, 401)
    const row = readRow(store, actor.id, id)
    const token = await getRepositoryToken(auth, store, request.headers, 'github')
    if (!token) throw new GithubError(409, 'Reconnect your GitHub account before publishing.')
    const job = await authorizedStoryJob(store, actor.id, id)
    if (job.baseSha !== row.baseSha) throw new GithubError(409, 'Saved job baseline has changed.')
    if (request.method === 'POST') {
      const expected = await readPublicationRequest(request)
      return json({ publication: await publish(store, actor.id, row, job, token, expected) })
    }
    const remote = await remoteContext(token, row)
    return json({ publication: await withStoryJobLock(job, 'github-publication-preview',
      () => preview(store, actor.id, row, job, token, remote.target, remote.targetSha)) })
  } catch (error) {
    if (error instanceof PublicationFailure) return json({ error: error.message }, error.status)
    return errorResponse(error)
  }
}
