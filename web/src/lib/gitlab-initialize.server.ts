import { randomUUID } from 'node:crypto'
import type { StudioAuth } from './auth'
import type { StudioStore as StudioDatabase } from '../persistence/store'
import { StudioSchemaError } from '../db/schema-error'
import { actor, eligible, failure, gitlab, page, ProviderFailure, reply } from './gitlab-repositories.server'
import { verifyGitlabStorySelection } from './gitlab-stories.server'
import { storyContentDirectory } from './story-discovery.shared'
import { assertApprovedPiFoundation } from './onboarding-pi.server'
import { candidate, validateNewStory, StoryBootstrapError } from './story-foundation.server'
export { validateNewStory } from './story-foundation.server'

type Project = {
  id: number; path_with_namespace: string; name_with_namespace: string; archived: boolean
  default_branch?: string | null; empty_repo?: boolean
}
type Commit = { id: string; parent_ids?: string[] }
type Initialization = {
  repositoryId: string
  directory: string
  expectedCommit?: string | null
  initialBranch?: string
  foundation: {
    id: string; title: string; premise: string; central_conflict: string
    genre: string; tone: string; player_experience: string; scope: string
    decision: string; body: string
  }
}

const SHA = /^[0-9a-f]{40}$/i
const BRANCH = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/
const STORY_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\\)[a-zA-Z0-9_./-]*$/

function directory(value: unknown) {
  if (value === '') return ''
  if (typeof value !== 'string' || value.length > 240 || !STORY_PATH.test(value) ||
      value.endsWith('/') || value.split('/').some(part => !part || part.startsWith('.'))) {
    throw new ProviderFailure(400, 'Choose a new Story directory without traversal or reserved components.')
  }
  return value
}
async function authorizedProject(token: string, projectId: number): Promise<Project> {
  for (let n = 1; n <= 100; n++) {
    const batch = await page(token, n)
    const project = batch.data.find(item => item.id === projectId && eligible(item))
    if (project) {
      const detail = (await gitlab<Project>(token, `/projects/${projectId}`)).data
      if (!detail || detail.id !== projectId ||
          detail.path_with_namespace !== project.path_with_namespace || detail.archived) {
        throw new ProviderFailure(409, 'GitLab project identity or permissions changed. Reconnect it.')
      }
      return detail
    }
    if (!batch.next) break
  }
  throw new ProviderFailure(403, 'GitLab project is no longer among your writable projects.')
}

async function createCommit(token: string, projectId: number, payload: object): Promise<Commit> {
  let result: Response
  try {
    result = await fetch(`https://gitlab.com/api/v4/projects/${projectId}/repository/commits`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch { throw new ProviderFailure(503, 'GitLab commit outcome is unknown; inspect remote branches before retrying. No automatic replay occurred.') }
  if (result.status === 401) throw new ProviderFailure(409, 'GitLab authorization expired. Reconnect GitLab.')
  if (result.status === 403) throw new ProviderFailure(403, 'GitLab refused permission to create this branch or initial commit.')
  if (result.status === 400 || result.status === 409) {
    throw new ProviderFailure(409, 'GitLab rejected the commit, likely due to a branch, file or upstream revision conflict. Refresh and retry with a new branch.')
  }
  if (!result.ok) throw new ProviderFailure(502, 'GitLab failed to create the Story commit. Inspect project state before retrying.')
  let commit: Commit
  try { commit = await result.json() as Commit } catch {
    throw new ProviderFailure(503, 'GitLab accepted a commit but returned no usable revision; inspect remote before retrying.')
  }
  if (!SHA.test(commit.id)) throw new ProviderFailure(503, 'GitLab commit reply is missing an immutable SHA; inspect remote before retrying.')
  return commit
}

export async function gitlabInitializeRequest(
  auth: StudioAuth, store: StudioDatabase, request: Request, origin: string,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405)
  if (request.method === 'POST' && request.headers.get('origin') !== origin) {
    return reply({ error: 'Cross-origin write refused' }, 403)
  }
  try {
    const candidateRepositoryId = request.method === 'GET' ? new URL(request.url).searchParams.get('repositoryId') :
      (await request.clone().json().catch(() => null))?.repositoryId
    if (typeof candidateRepositoryId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(candidateRepositoryId))
      throw new ProviderFailure(400, 'Select a connected GitLab project.')
    const current = await actor(auth, store, request.headers, candidateRepositoryId)
    const data = request.method === 'GET' ? Object.fromEntries(new URL(request.url).searchParams)
      : await request.json().catch(() => null) as Initialization | null
    if (!data || typeof data.repositoryId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(data.repositoryId)) {
      throw new ProviderFailure(400, 'Select a connected GitLab project.')
    }
    const row = await store.persistence.repositories.get(current.id, data.repositoryId, 'gitlab')
    if (!row) throw new ProviderFailure(404, 'GitLab project is not connected to this account.')
    const projectId = Number(row.providerId)
    if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new ProviderFailure(409, 'Invalid saved GitLab project ID.')
    const project = await authorizedProject(current.token, projectId)
    if (project.path_with_namespace !== row.name) {
      throw new ProviderFailure(409, 'GitLab project was renamed or replaced. Reconnect it.')
    }
    // GitLab may return empty_repo=true while still advertising its configured
    // (unborn) default_branch, such as "main". The empty_repo flag is the
    // authority: requesting a commit from that branch would incorrectly 404.
    const empty = project.empty_repo === true
    if (request.method === 'GET') {
      const snapshot = empty ? null : project.default_branch
        ? (await gitlab<Commit>(current.token,
          `/projects/${projectId}/repository/commits/${encodeURIComponent(project.default_branch)}`)).data.id
        : null
      if (!empty && (!snapshot || !SHA.test(snapshot))) {
        throw new ProviderFailure(409, 'GitLab repository is not initialized consistently. Check project status.')
      }
      return reply({ empty, defaultBranch: project.default_branch || null,
        commit: snapshot, repositoryId: data.repositoryId })
    }
    await store.assertReady()
    const input = data as Initialization
    const path = storyContentDirectory(directory(input.directory))
    const existing = await store.persistence.onboarding.story(current.id, data.repositoryId, path)
    if (existing) {
      throw new ProviderFailure(409, 'This Story directory is already registered. Open it instead of initializing a new Story.')
    }
    if ('discoveryApproval' in input) {
      try {
        await assertApprovedPiFoundation(store, current.id, input.repositoryId,
          directory(input.directory), (input as Initialization & { discoveryApproval: unknown }).discoveryApproval,
          input.foundation)
      } catch {
        throw new ProviderFailure(409, 'Pi discovery approval is stale or does not match this exact foundation.')
      }
    }
    const { file, title } = candidate(input.foundation)
    // Validate *before* any GitLab mutation. If unavailable, reject safely.
    await validateNewStory(file)
    let baseSha: string | null = null
    let branch: string
    if (empty) {
      if (input.expectedCommit !== null) throw new ProviderFailure(409, 'Project is empty; refresh the initialization form.')
      if (typeof input.initialBranch !== 'string' || !BRANCH.test(input.initialBranch) ||
          input.initialBranch.includes('..') || input.initialBranch.includes('//') ||
          input.initialBranch.endsWith('.') || input.initialBranch.endsWith('/')) {
        throw new ProviderFailure(400, 'Enter a safe initial GitLab default branch name.')
      }
      branch = input.initialBranch
      if (project.default_branch && branch !== project.default_branch) {
        throw new ProviderFailure(409,
          'The empty GitLab project already specifies a default branch; use that exact branch for the initial commit.')
      }
    } else {
      if (!project.default_branch || project.empty_repo === true ||
          !SHA.test(input.expectedCommit || '')) {
        throw new ProviderFailure(409, 'Existing repository needs an exact starting commit; refresh before initializing.')
      }
      const original = (await gitlab<Commit>(current.token,
        `/projects/${projectId}/repository/commits/${encodeURIComponent(project.default_branch)}`)).data
      if (!SHA.test(original?.id) || original.id.toLowerCase() !== input.expectedCommit!.toLowerCase()) {
        throw new ProviderFailure(409, 'GitLab default branch moved; refresh before creating a Story.')
      }
      baseSha = original.id
      // Only a new review branch is written. The default branch is immutable
      // for this operation, including when upstream advances concurrently.
      branch = 'noveltea/story-' + randomUUID()
      const listing = await gitlab<Array<{ name: string }>>(current.token,
        `/projects/${projectId}/repository/tree?ref=${baseSha}&path=${encodeURIComponent(path)}&per_page=1`)
        .catch(error => {
          if (error instanceof ProviderFailure && error.status === 404) return { data: [] }
          throw error
        })
      if (!Array.isArray(listing.data) || listing.data.length || project.default_branch === branch) {
        throw new ProviderFailure(409, 'Selected Story directory is not empty at the pinned revision.')
      }
    }
    const filePath = path ? path + '/creative-direction/foundation.md' : 'creative-direction/foundation.md'
    const action = { action: 'create', file_path: filePath, content: file }
    const created = await createCommit(current.token, projectId, {
      branch, ...(baseSha ? { start_sha: baseSha } : {}),
      commit_message: 'Initialize NovelTea Story: ' + title.slice(0, 100),
      actions: [action],
    })
    if (baseSha && (!Array.isArray(created.parent_ids) || created.parent_ids[0]?.toLowerCase() !== baseSha.toLowerCase())) {
      throw new ProviderFailure(503, 'GitLab created a commit with unexpected ancestry; inspect the branch before proceeding.')
    }
    // An empty project must have acquired this exact initial default branch,
    // not merely an unrelated branch created by the API.
    if (empty) {
      const after = (await gitlab<Project>(current.token, `/projects/${projectId}`)).data
      if (after.default_branch !== branch || after.empty_repo) {
        throw new ProviderFailure(503, `Initial commit exists on ${branch} at ${created.id}, but the project's default branch is not confirmed. Inspect GitLab before retrying.`)
      }
    }
    // Reconfirm that GitLab exposes exactly the canonical Story at the
    // committed revision (rather than trusting the mutation response).
    try {
      await verifyGitlabStorySelection(current.token, projectId, row.name, created.id, path)
    } catch {
      throw new ProviderFailure(503, `Story commit was created on ${branch} at ${created.id}, but provider preflight failed. Inspect that branch before retrying; no catalog record was written.`)
    }
    const now = new Date().toISOString()
    let story
    try {
      story = await store.persistence.onboarding.createStory({
        id: randomUUID(), owner: current.id, repositoryId: data.repositoryId,
        directory: path, title, createdAt: now, commitSha: created.id,
      })
    } catch {
      throw new ProviderFailure(409, `Story commit exists on ${branch} at ${created.id}, but catalog registration conflicted. Reconcile it before retrying.`)
    }
    return reply({ story, branch, mode: empty ? 'initial-default' : 'review-branch',
      baseSha, commit: created.id })
  } catch (error) {
    if (error instanceof StudioSchemaError) return reply({ error: error.message }, 503)
    return failure(error instanceof StoryBootstrapError ? new ProviderFailure(error.status, error.message) : error)
  }
}
