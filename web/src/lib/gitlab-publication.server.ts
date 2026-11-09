import type { StudioStore as StudioDatabase } from '../persistence/store'
import { PublicationStateConflict } from '../persistence/publication-contracts'
import type { StudioAuth } from './auth'
import type { JobStartResult } from '../../../src/job'
import { resolveThreadPublication, type ThreadPublicationChoice,
  type ThreadPublicationSelection } from './thread-publication.server'
import { StudioSchemaError } from '../db/schema-error'
import { authorizedStoryJob } from './fixture-jobs.server'
import { actor, eligible, failure, gitlab, page, ProviderFailure, reply } from './gitlab-repositories.server'
import { requireUser } from './access.server'
import { withStoryJobLock } from '../../../src/job-lock'
import {
  PublicationFailure, reviewPublication, readPublicationRequest, publicationDescription,
  remotePublicationHead, pushVerifiedBranch, safeDefaultBranch,
  type PublicationPreview, type PublicationSource, type PublicationLink,
} from './publication-review.server'

type Row = { id: string; title: string; repository: string; repositoryId: string; projectId: string; baseSha: string; directory: string }
type Saved = { mrIid: number | null; mrUrl: string | null; targetBranch: string; remoteBranch: string; headSha: string; phase: string }
type Project = { id: number; path_with_namespace: string; default_branch: string | null; archived: boolean }
type Branch = { commit: { id: string } }
type MergeRequest = {
  iid: number; web_url: string; state: string; title: string; draft?: boolean; work_in_progress?: boolean
  source_branch: string; target_branch: string; source_project_id: number
  target_project_id: number; sha: string
}
const SHA = /^[a-f0-9]{40}$/i

async function catalogRow(store: StudioDatabase, owner: string, id: string): Promise<Row> {
  const row = await store.persistence.publications.job(owner, id, 'gitlab')
  if (!row) throw new ProviderFailure(404, 'GitLab job is not connected to this account.')
  const projectId = Number(row.providerId)
  if (!SHA.test(row.baseSha ?? '') || !Number.isSafeInteger(projectId) || projectId <= 0)
    throw new ProviderFailure(409, 'Saved GitLab job has invalid baseline or project identity.')
  return { ...row, baseSha: row.baseSha!, projectId: row.providerId }
}

/** Reconfirm writable membership and immutable provider identity, not just public visibility. */
async function remoteContext(token: string, row: Row) {
  const projectId = Number(row.projectId)
  let member: { id: number; path_with_namespace: string } | undefined
  for (let i = 1; i <= 100; i++) {
    const result = await page(token, i)
    member = result.data.find(item => item.id === projectId && eligible(item))
    if (member) break
    if (!result.next) break
    if (i === 100) throw new ProviderFailure(503, 'Too many GitLab projects to verify publication access.')
  }
  if (!member || member.path_with_namespace !== row.repository)
    throw new ProviderFailure(403, 'GitLab push permission or project identity changed. Reconnect; local work is preserved.')
  const project = (await gitlab<Project>(token, '/projects/' + projectId)).data
  if (project?.id !== projectId || project.path_with_namespace !== row.repository || project.archived)
    throw new ProviderFailure(409, 'GitLab project identity or status changed. Reconnect before publishing.')
  safeDefaultBranch(project.default_branch)
  const branch = (await gitlab<Branch>(token,
    '/projects/' + projectId + '/repository/branches/' + encodeURIComponent(project.default_branch))).data
  if (!SHA.test(branch?.commit?.id))
    throw new ProviderFailure(502, 'GitLab returned an invalid default-branch commit.')
  return { projectId, targetBranch: project.default_branch, targetSha: branch.commit.id,
    path: '/projects/' + projectId + '/merge_requests' }
}
async function savedPublication(store: StudioDatabase, owner: string, id: string): Promise<Saved | undefined> {
  const receipt = await store.persistence.publications.get(owner, id, 'gitlab')
  return receipt ? {
    mrIid: receipt.number, mrUrl: receipt.url, targetBranch: receipt.targetBranch,
    remoteBranch: receipt.remoteBranch, headSha: receipt.headSha, phase: receipt.phase,
  } : undefined
}
async function savePublication(store: StudioDatabase, owner: string, job: JobStartResult,
  target: string, head: string, mr?: MergeRequest, selection?: ThreadPublicationSelection): Promise<void> {
  try {
    await store.persistence.publications.save(owner, selection?.recordJobId ?? job.jobId, 'gitlab', {
      targetBranch: target, remoteBranch: selection?.remoteBranch ?? job.branch, headSha: head,
      phase: mr ? 'linked' : 'pending', number: mr?.iid ?? null, url: mr?.web_url ?? null,
    }, new Date().toISOString())
  } catch (error) {
    if (error instanceof PublicationStateConflict) throw new ProviderFailure(409, error.message)
    throw error
  }
}

function linkedRecord(saved: Saved | undefined): PublicationLink | null {
  return saved?.phase === 'linked' && saved.mrIid && saved.mrUrl
    ? { number: saved.mrIid, url: saved.mrUrl, targetBranch: saved.targetBranch, headSha: saved.headSha }
    : null
}
async function checkSaved(store: StudioDatabase, owner: string,
  job: JobStartResult, target: string, selection?: ThreadPublicationSelection) {
  const saved = await savedPublication(store, owner, selection?.recordJobId ?? job.jobId)
  if (saved && (saved.targetBranch !== target || saved.remoteBranch !== (selection?.remoteBranch ?? job.branch)))
    throw new ProviderFailure(409, 'Saved publication targets a different GitLab branch. Manual reconciliation required.')
  return saved
}
async function preview(store: StudioDatabase, owner: string, job: JobStartResult, row: Row, token: string,
  remote: Awaited<ReturnType<typeof remoteContext>>, selection?: ThreadPublicationSelection) {
  const saved = await checkSaved(store, owner, job, remote.targetBranch, selection)
  const source: PublicationSource = { repository: row.repository, directory: row.directory,
    initialContentSha256: null, remoteUrl: 'https://gitlab.com/' + row.repository + '.git' }
  const view = await reviewPublication(store, job, source, token,
    remote.targetBranch, remote.targetSha, linkedRecord(saved), selection ? {
      id: selection.threadId, rootBaseSha: selection.rootBaseSha,
      passedReviews: selection.review.passed,
      skippedReviews: selection.review.skipped, branch: selection.remoteBranch,
    } : undefined)
  return { view, source }
}

function verifyMr(mr: MergeRequest, row: Row, branch: string, target: string) {
  const projectId = Number(row.projectId)
  if (!Number.isSafeInteger(mr?.iid) || mr.iid <= 0 ||
      mr.source_project_id !== projectId || mr.target_project_id !== projectId ||
      mr.source_branch !== branch || mr.target_branch !== target)
    throw new ProviderFailure(409, 'Existing GitLab MR has a different source, target or project. Reconcile manually.')
  if (mr.state !== 'opened' ||
      (mr.draft !== true && mr.work_in_progress !== true &&
        !/^(?:Draft:|\[Draft\]|\(Draft\))\s*/i.test(mr.title)))
    throw new ProviderFailure(409, 'Linked GitLab MR was closed, merged or marked ready. Reconcile it on GitLab.')
  if (mr.web_url !== 'https://gitlab.com/' + row.repository + '/-/merge_requests/' + mr.iid)
    throw new ProviderFailure(409, 'GitLab returned an unexpected MR URL or identity.')
}
async function findExisting(token: string, row: Row, branch: string,
  target: string, path: string): Promise<MergeRequest | null> {
  const query = new URLSearchParams({ state: 'all', source_branch: branch, per_page: '100' })
  const result = await gitlab<MergeRequest[]>(token, path + '?' + query)
  if (!Array.isArray(result.data) || result.next || result.data.length === 100)
    throw new ProviderFailure(409, 'GitLab MR listing could not be exhaustively reconciled. Do not create another MR.')
  const matches = result.data.filter(mr => mr.source_branch === branch &&
    mr.source_project_id === Number(row.projectId))
  if (matches.length > 1) throw new ProviderFailure(409, 'Multiple MRs use this job branch. Manual reconciliation required.')
  if (matches[0]) verifyMr(matches[0], row, branch, target)
  return matches[0] ?? null
}
async function writeMr(token: string, path: string, method: 'POST' | 'PUT',
  body: unknown): Promise<MergeRequest> {
  let response: Response
  try {
    response = await fetch('https://gitlab.com/api/v4' + path, {
      method, headers: { Authorization: 'Bearer ' + token, Accept: 'application/json',
        'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000),
    })
  } catch { throw new ProviderFailure(503, 'GitLab MR operation outcome is unknown. Retry to reconcile the remote branch and MR.') }
  if (response.status === 401) throw new ProviderFailure(409, 'GitLab authorization expired. Reconnect GitLab; local work is preserved.')
  if (response.status === 403) throw new ProviderFailure(403, 'GitLab MR permission was denied. Reconnect or obtain access; local work is preserved.')
  if (!response.ok) throw new ProviderFailure(response.status === 409 || response.status === 400 ? 409 : 503,
    'GitLab rejected MR publication. Refresh and retry; do not delete the local branch.')
  const mr = await response.json().catch(() => null) as MergeRequest | null
  if (!mr || !Number.isSafeInteger(mr.iid) || mr.iid <= 0)
    throw new ProviderFailure(503, 'GitLab MR response was incomplete. Retry to reconcile before creating another MR.')
  return mr
}
async function publish(store: StudioDatabase, owner: string, row: Row, job: JobStartResult,
  token: string, expected: { headSha?: string; targetSha?: string; allowPartial?: boolean },
  thread?: { choice: ThreadPublicationChoice; selection: ThreadPublicationSelection }) {
  return withStoryJobLock(job, 'gitlab-draft-publication', async () => {
    const selection = thread ? await resolveThreadPublication(store, owner, thread.choice) : undefined
    if (thread && (selection?.headSha !== thread.selection.headSha ||
        selection?.recordJobId !== thread.selection.recordJobId ||
        selection?.remoteBranch !== thread.selection.remoteBranch))
      throw new ProviderFailure(409, 'Thread publication selection changed. Refresh before publishing.')
    const remote = await remoteContext(token, row)
    const { view, source } = await preview(store, owner, job, row, token, remote, selection)
    if (expected.headSha !== view.headSha || expected.targetSha !== view.targetSha)
      throw new ProviderFailure(409, 'Publication preview is stale. Refresh job and upstream before publishing.')
    if (!view.canPublish) throw new ProviderFailure(422, 'Canonical validation or worktree safety blocks publication.')
    if (view.blockers.length && expected.allowPartial !== true)
      throw new ProviderFailure(409, 'Partial or divergent draft requires explicit confirmation of listed blockers.')
    if (!await savedPublication(store, owner, selection?.recordJobId ?? job.jobId))
      await savePublication(store, owner, job, remote.targetBranch, view.headSha, undefined, selection)
    if (selection?.linked) {
      const remoteHead = remotePublicationHead(job, source, token, selection.remoteBranch)
      if (remoteHead !== selection.linked.receipt.headSha && remoteHead !== view.headSha)
        throw new ProviderFailure(409, 'Linked draft branch changed outside this publication. Reconcile before updating.')
    }
    pushVerifiedBranch(job, source, token, view.headSha, selection?.remoteBranch)
    await savePublication(store, owner, job, remote.targetBranch, view.headSha, undefined, selection)
    const after = await remoteContext(token, row)
    if (after.targetBranch !== remote.targetBranch || after.targetSha !== remote.targetSha)
      throw new ProviderFailure(409, 'GitLab upstream changed after push. Branch preserved; refresh before publishing MR.')
    const saved = await savedPublication(store, owner, selection?.recordJobId ?? job.jobId)
    let mr: MergeRequest | null
    if (saved?.mrIid) {
      mr = (await gitlab<MergeRequest>(token, remote.path + '/' + saved.mrIid)).data
      verifyMr(mr, row, selection?.remoteBranch ?? job.branch, remote.targetBranch)
    } else {
      mr = await findExisting(token, row, selection?.remoteBranch ?? job.branch, remote.targetBranch, remote.path)
    }
    const description = publicationDescription(job, view)
    if (!mr) {
      try {
        mr = await writeMr(token, remote.path, 'POST', {
          source_branch: selection?.remoteBranch ?? job.branch, target_branch: remote.targetBranch,
          title: 'Draft: NovelTea Story: ' + row.title.slice(0, 110),
          description, remove_source_branch: false,
        })
      } catch (error) {
        // A timeout can follow a successfully created MR. If reconciliation is
        // unavailable or ambiguous, leave the intent pending for a later retry.
        const matched = await findExisting(token, row, selection?.remoteBranch ?? job.branch,
          remote.targetBranch, remote.path)
        if (!matched) throw error
        mr = matched
      }
    } else mr = await writeMr(token, remote.path + '/' + mr.iid, 'PUT', { description })
    verifyMr(mr, row, selection?.remoteBranch ?? job.branch, remote.targetBranch)
    if (mr.sha !== view.headSha || remotePublicationHead(job, source, token,
      selection?.remoteBranch ?? job.branch) !== view.headSha)
      throw new ProviderFailure(409, 'GitLab MR or remote job branch changed from verified HEAD; reconcile before linking.')
    await savePublication(store, owner, job, remote.targetBranch, view.headSha, mr, selection)
    return { ...view, linked: { number: mr.iid, url: mr.web_url, headSha: view.headSha,
      targetBranch: remote.targetBranch } } satisfies PublicationPreview
  })
}
export async function gitlabPublicationRequest(auth: StudioAuth, store: StudioDatabase,
  request: Request, id: string, baseURL: string,
  choice?: ThreadPublicationChoice): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST')
    return reply({ error: 'Method not allowed' }, 405)
  if (request.method === 'POST' && request.headers.get('origin') !== baseURL)
    return reply({ error: 'Cross-origin write refused' }, 403)
  try {
    await store.assertReady()
    const user = await requireUser(auth, request.headers)
    if (!user) return reply({ error: 'Sign in required.' }, 401)
    const selection = choice ? await resolveThreadPublication(store, user.id, choice) : undefined
    if (selection && (selection.job.jobId !== id || selection.provider !== 'gitlab'))
      throw new ProviderFailure(409, 'Selected Thread revision or provider changed.')
    if (!choice && await store.persistence.continuation.runThread(user.id, id))
      throw new ProviderFailure(409, 'Publish this Story through its owning Thread.')
    const row = await catalogRow(store, user.id, id)
    const current = await actor(auth, store, request.headers, row.repositoryId)
    const job = await authorizedStoryJob(store, current.id, id)
    if (job.baseSha !== row.baseSha)
      throw new ProviderFailure(409, 'Saved job baseline has changed.')
    if (request.method === 'POST') {
      const expected = await readPublicationRequest(request)
      return reply({ publication: await publish(store, current.id, row, job, current.token, expected,
        selection && choice ? { selection, choice } : undefined) })
    }
    // Hold the same serialized job lock as publish: the preview must never
    // race a writer, an ambiguous revision receipt, or another publication.
    return reply({ publication: await withStoryJobLock(job, 'gitlab-publication-preview', async () => {
      const remote = await remoteContext(current.token, row)
      const fresh = choice ? await resolveThreadPublication(store, current.id, choice) : undefined
      if (selection && (fresh?.headSha !== selection.headSha ||
          fresh?.recordJobId !== selection.recordJobId))
        throw new ProviderFailure(409, 'Thread advanced. Refresh publication preview.')
      return (await preview(store, current.id, job, row, current.token, remote, fresh)).view
    }) })
  } catch (error) {
    if (error instanceof StudioSchemaError) return reply({ error: error.message }, 503)
    if (error instanceof PublicationFailure) return reply({ error: error.message }, error.status)
    return failure(error)
  }
}
