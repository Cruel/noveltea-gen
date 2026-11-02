import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StudioDatabase } from '../db/connection'
import type { StudioAuth } from './auth'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser, getRepositoryToken } from './access.server'
import { authorizedStoryJob } from './fixture-jobs.server'
import { queueRecord } from './generation-queue.server'
import { gitEnvironment } from './git-cache.server'
import { github, matchingRepository, GithubError, errorResponse, json } from './github-repositories.server'
import { withStoryJobLock } from '../../../src/job-lock'
import { trustedHead } from '../../../src/revision'
import { validateStoryJob } from '../../../src/validator'
import type { JobStartResult } from '../../../src/job'

type Linked = { number: number; url: string; headSha: string; targetBranch: string }
type Row = { id: string; title: string; repository: string; providerId: string; baseSha: string;
  directory: string; initialContentSha256: string | null }
type Saved = { prNumber: number | null; prUrl: string | null; targetBranch: string; remoteBranch: string; headSha: string; phase: string }
type GithubPr = {
  number: number; html_url: string; state: string; draft: boolean
  head: { ref: string; sha: string; repo: { id: number } | null }
  base: { ref: string }
}
type Remote = { id: number; default_branch: string }
type Preview = {
  jobId: string; headSha: string; baseSha: string; branch: string
  targetBranch: string; targetSha: string; validation: string
  diagnostics: unknown[]; protection: string; merge: 'clean' | 'conflicts' | 'not-assessed'
  blockers: string[]; canPublish: boolean; linked: Linked | null
}
const SHA = /^[a-f0-9]{40}$/i
const forbiddenEnv = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']

/** Never copy Git stderr: authentication headers can be printed by transport helpers. */
function git(job: JobStartResult, token: string, args: string[], allowNonzero = false): { output: string; code: number } {
  const url = `https://github.com/${jobRemote(job)}.git`
  const env = gitEnvironment(url, token)
  for (const key of forbiddenEnv) delete env[key]
  const run = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: job.worktreeRoot, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (run.error || run.signal || (run.status !== 0 && !allowNonzero))
    throw new GithubError(409, 'Git publication operation failed. Check upstream access and preserve the job branch for inspection.')
  return { output: run.stdout.trim(), code: run.status ?? 1 }
}

// Remote is bound to the authorized catalog selection, never inferred from the Git config.
const remoteByJob = new WeakMap<JobStartResult, string>()
function jobRemote(job: JobStartResult) {
  const name = remoteByJob.get(job)
  if (!name) throw new GithubError(409, 'Publication repository identity is missing.')
  return name
}
function remoteRef(job: JobStartResult, token: string, branch: string) {
  const result = git(job, token, ['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/' + branch], true)
  if (result.code === 2) return null
  if (result.code !== 0) throw new GithubError(409, 'Unable to inspect remote job branch.')
  const match = /^([a-f0-9]{40})\s+refs\/heads\/(.+)$/.exec(result.output)
  if (!match || match[2] !== branch) throw new GithubError(409, 'Unexpected remote branch identity.')
  return match[1]!
}
function gitLocal(job: JobStartResult, token: string, args: string[]) {
  return git(job, token, args).output
}
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
function ensureNotRunning(store: StudioDatabase, id: string) {
  const q = queueRecord(store, id)
  if (q && ['queued', 'running', 'interrupted'].includes(q.phase))
    throw new GithubError(409, 'Generation is queued, running, or interrupted. Inspect/reconcile the writer before publication.')
}
function assertRemoteIdentity(job: JobStartResult, token: string, row: Row) {
  const actual = gitLocal(job, token, ['config', '--local', '--get', 'remote.origin.url'])
  if (actual !== 'https://github.com/' + row.repository + '.git')
    throw new GithubError(409, 'Cached Git origin differs from the authorized GitHub repository.')
}
function cleanWorktree(job: JobStartResult, token: string) {
  return !gitLocal(job, token, ['status', '--porcelain=v1', '--untracked-files=all'])
}
async function publicationHead(job: JobStartResult, token: string, row: Row) {
  try { return await trustedHead(job) } catch {
    // A saved onboarding initialization commit predates generation receipts.
    // Require its exact sole changed path and controller-pinned content digest.
    if (!row.initialContentSha256 || !/^[a-f0-9]{64}$/.test(row.initialContentSha256) ||
        existsSync(join(job.stateDir, 'revisions', 'verified-head.json')) ||
        existsSync(join(job.stateDir, 'foundation.json')))
      throw new GithubError(409, 'Job HEAD lacks trusted revision evidence.')
    const head = gitLocal(job, token, ['rev-parse', 'HEAD'])
    const path = [row.directory, 'creative-direction/foundation.md'].filter(Boolean).join('/')
    const changed = gitLocal(job, token, ['diff', '--name-only', job.baseSha, head])
    const baseFoundation = gitLocal(job, token, ['ls-tree', '--name-only', job.baseSha, '--', path])
    if (baseFoundation || gitLocal(job, token, ['rev-list', '--count', job.baseSha + '..' + head]) !== '1' || changed !== path)
      throw new GithubError(409, 'Initialization differs from its saved single-commit draft.')
    const file = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'show', 'HEAD:' + path], {
      cwd: job.worktreeRoot, env: gitEnvironment('https://github.com/' + row.repository + '.git', token),
      maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (file.status !== 0 || createHash('sha256').update(file.stdout).digest('hex') !== row.initialContentSha256)
      throw new GithubError(409, 'Initialization content differs from the saved digest.')
    return head
  }
}
async function completedReview(job: JobStartResult, head: string) {
  try {
    const review = JSON.parse(await readFile(join(job.stateDir, 'narrative-review.json'), 'utf8')) as {
      version?: number; jobId?: string; branch?: string; headSha?: string; phase?: string
    }
    return review.version === 1 && review.jobId === job.jobId &&
      review.branch === job.branch && review.headSha === head && review.phase === 'completed'
  } catch { return false }
}
async function preview(store: StudioDatabase, owner: string, row: Row, job: JobStartResult,
  token: string, target: string, targetSha: string): Promise<Preview> {
  ensureNotRunning(store, job.jobId)
  const saved = savedPublication(store, job.jobId)
  if (saved && (saved.targetBranch !== target || saved.remoteBranch !== job.branch))
    throw new GithubError(409, 'Saved publication targets a different upstream branch. Operator reconciliation required.')
  assertRemoteIdentity(job, token, row)
  if (gitLocal(job, token, ['rev-parse', 'HEAD']) !== job.headSha)
    throw new GithubError(409, 'Job HEAD changed during publication inspection. Refresh the job before retrying.')
  const head = await publicationHead(job, token, row)
  const blockers: string[] = []
  if (!cleanWorktree(job, token)) blockers.push('Uncommitted changes remain in the job worktree.')
  if (head === job.baseSha) blockers.push('No committed Story changes to publish.')
  let validation = 'not-run'
  let protection = 'unverified'
  let diagnostics: unknown[] = []
  if (!blockers.length) {
    const result = await validateStoryJob(job, process.env.NT_STUDIO_SKILLS_SOURCE)
    validation = result.status
    protection = (result.report?.protection as { status?: string } | undefined)?.status ?? 'unverified'
    diagnostics = Array.isArray(result.report?.diagnostics) ? result.report.diagnostics : []
    const originalStory = gitLocal(job, token,
      ['ls-tree', '-r', '--name-only', job.baseSha, '--', job.storyRelativePath || '.'])
    const emptyBase = !originalStory.split('\n').some(path => path.endsWith('.md'))
    const hasErrors = diagnostics.some(d => d && typeof d === 'object' &&
      'severity' in d && (d as { severity: unknown }).severity === 'error')
    if (result.status !== 'passed' &&
        !(emptyBase && result.status === 'unverified' && !hasErrors && result.report)) {
      blockers.push('Canonical Story validation did not pass; resolve diagnostics before publication.')
    }
    if (protection !== 'checked') {
      if (emptyBase && result.status === 'unverified' && !hasErrors)
        blockers.push('The pinned baseline has no Story Markdown; protected decisions cannot be compared.')
      else blockers.push('Canonical protected-decision verification is not checked.')
    }
  }
  if (!await completedReview(job, head)) blockers.push('Full scoped completion review is absent or stale; draft is partial.')
  if (targetSha !== job.baseSha) {
    blockers.push('Upstream changed since the pinned job baseline; no automatic merge or rebase.')
    blockers.push('Merged Story semantics and canonical protection against the new upstream have not been certified.')
  }
  let merge: Preview['merge'] = 'clean'
  if (targetSha !== job.baseSha) {
    try {
      gitLocal(job, token, ['fetch', '--no-tags', '--filter=blob:none', 'origin', 'refs/heads/' + target])
      const fetched = gitLocal(job, token, ['rev-parse', 'FETCH_HEAD'])
      if (fetched !== targetSha) throw new Error('Upstream changed during fetch')
      const probe = git(job, token, ['merge-tree', '--write-tree', targetSha, head], true)
      merge = probe.code === 0 ? 'clean' : probe.code === 1 ? 'conflicts' : 'not-assessed'
    } catch { merge = 'not-assessed' }
    if (merge !== 'clean') blockers.push(merge === 'conflicts'
      ? 'Git merge conflicts need author reconciliation before merge.'
      : 'Git merge compatibility could not be assessed.')
  }
  const hard = blockers.some(x => x.startsWith('Uncommitted') || x.startsWith('No committed') ||
    x.startsWith('Canonical Story validation') || x.startsWith('Canonical protected-decision'))
  return { jobId: job.jobId, headSha: head, baseSha: job.baseSha, branch: job.branch,
    targetBranch: target, targetSha, validation, diagnostics, protection, merge,
    blockers, canPublish: !hard, linked: saved?.phase === 'linked' && saved.prNumber && saved.prUrl
      ? { number: saved.prNumber, url: saved.prUrl, headSha: saved.headSha, targetBranch: saved.targetBranch } : null }
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
    const remoteHead = remoteRef(job, token, job.branch)
    if (remoteHead && remoteHead !== view.headSha) {
      const ancestor = git(job, token, ['merge-base', '--is-ancestor', remoteHead, view.headSha], true)
      if (ancestor.code !== 0)
        throw new GithubError(409, 'Remote job branch diverged. Never force-push or overwrite it.')
    }
    if (remoteHead !== view.headSha) {
      gitLocal(job, token, ['push', 'origin', 'HEAD:refs/heads/' + job.branch])
      if (remoteRef(job, token, job.branch) !== view.headSha)
        throw new GithubError(409, 'Remote push result is uncertain; retry to reconcile without force.')
    }
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
    const body = [
      'NovelTea Story draft generated from a pinned, verified job revision.',
      '', 'Job: `' + job.jobId + '`', 'Base commit: `' + job.baseSha + '`',
      'Verified head: `' + view.headSha + '`',
      'Canonical validation: ' + view.validation + ' (protection: ' + view.protection + ')',
      'Merge preview: ' + view.merge, '', 'Outstanding blockers / review obligations:',
      ...(view.blockers.length ? view.blockers.map(s => '- ' + s) : ['- None reported; human review is still required.']),
      '', 'Draft only. No automatic merge, rebase or protected-decision approval.',
    ].join('\n')
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
    if (pr.head.sha !== view.headSha || remoteRef(job, token, job.branch) !== view.headSha)
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
    remoteByJob.set(job, row.repository)
    if (request.method === 'POST') {
      const reader = request.body?.getReader()
      if (!reader) throw new GithubError(400, 'Missing publication request.')
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > 2048) throw new GithubError(413, 'Publication request is too large.')
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const raw = Buffer.concat(chunks).toString('utf8')
      let expected: { headSha?: string; targetSha?: string; allowPartial?: boolean }
      try { expected = JSON.parse(raw) as typeof expected }
      catch { throw new GithubError(400, 'Invalid publication request.') }
      if (!SHA.test(expected?.headSha ?? '') || !SHA.test(expected?.targetSha ?? '') ||
          (expected.allowPartial !== undefined && typeof expected.allowPartial !== 'boolean'))
        throw new GithubError(400, 'Provide the exact preview HEADs and confirmation.')
      return json({ publication: await publish(store, actor.id, row, job, token, expected) })
    }
    const remote = await remoteContext(token, row)
    return json({ publication: await withStoryJobLock(job, 'github-publication-preview',
      () => preview(store, actor.id, row, job, token, remote.target, remote.targetSha)) })
  } catch (error) { return errorResponse(error) }
}
