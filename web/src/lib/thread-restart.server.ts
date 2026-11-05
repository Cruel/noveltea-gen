import { execFileSync } from 'node:child_process'
import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { getRepositoryToken, requireUser } from './access.server'
import { selectedJob, restoreJob, pinnedRequest } from './fixture-jobs.server'
import { acquireCachedStory, continueCachedStory, gitEnvironment, GitCacheError } from './git-cache.server'
import { github, matchingRepository } from './github-repositories.server'
import { gitlab, page, eligible } from './gitlab-repositories.server'
import { validateStoryJob } from '../../../src/validator'
import { canonicalExplorerIndex } from './story-explorer.server'
import { validateGenerationDraft, type GenerationDraft } from './generation-config.server'
import { parseGenerationContract, type GenerationRequest } from '../../../src/generation'
import { ensureRootThreads } from './threads.server'
import { readJsonInput, JsonInputError } from './json-input.server'

const SHA = /^[a-f0-9]{40}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const ID = /^[a-zA-Z0-9:_-]{1,128}$/
const reply = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } })

export class ThreadRestartError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
type Source = {
  threadId: string; conversationId: string; storyId: string; sourceJobId: string
  rootJobId: string; originalSha: string; task: string; contract: GenerationRequest['contract']
  sourceTitle: string; model: GenerationDraft['model']
  limits: GenerationDraft['limits']; repositoryId: string
  provider: 'github' | 'gitlab'; providerId: string; repository: string; directory: string
}
export type Upstream = { branch: string; sha: string; remoteUrl: string; token: string }
type RestartIntent = {
  owner: string; sourceThread: string; sourceJob: string; rootJob: string
  original: string; mode: 'original' | 'newer'; selected: string; branch: string | null
  draft: string; preparedAt: string | null
}
export type RestartSelection = {
  childId: string; sourceJobId: string; originalSha: string
  mode: 'original' | 'newer'; selectedSha: string; targetBranch: string | null
}

async function sourceFor(store: StudioDatabase, owner: string, threadId: string): Promise<Source> {
  let root: Awaited<ReturnType<typeof store.persistence.advancedThreads.ancestor>>
  try { root = await store.persistence.advancedThreads.ancestor(owner, threadId) }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Thread ancestry is unsafe.'
    throw new ThreadRestartError(409, message)
  }
  if (!root) throw new ThreadRestartError(404, 'Thread not found.')
  const member = await store.persistence.advancedThreads.identity(owner, threadId)
  if (!member || member.conversation !== root.conversation || member.story !== root.story)
    throw new ThreadRestartError(409, 'Thread belongs to a different Story or Conversation.')
  const latest = await store.persistence.advancedThreads.run(owner, threadId, 'last')
  const first = await store.persistence.advancedThreads.run(owner, root.id, 'first')
  if (!first || !latest) throw new ThreadRestartError(409, 'Thread has no pinned generation run.')
  const original = await selectedJob(store, owner, first.jobId)
  const current = await selectedJob(store, owner, latest.jobId)
  if (original.storyId !== member.story || current.storyId !== member.story)
    throw new ThreadRestartError(409, 'Run Story identity differs.')
  if (!original.commitSha || !SHA.test(original.commitSha))
    throw new ThreadRestartError(409, 'Original Story SHA is missing.')
  const config = original.configJson ? JSON.parse(original.configJson) as GenerationDraft : null
  const originalRequest = original.requestJson ? JSON.parse(original.requestJson) as GenerationRequest : null
  const task = originalRequest?.task ?? config?.task
  const priorContract = originalRequest?.contract ?? config?.contract
  if (typeof task !== 'string' || !task.trim() || !priorContract)
    throw new ThreadRestartError(409, 'Original generation request is unavailable.')
  let contract: GenerationRequest['contract']
  try { contract = parseGenerationContract(priorContract) }
  catch { throw new ThreadRestartError(409, 'Original generation scope or plan is invalid.') }
  const currentConfig = current.configJson ? JSON.parse(current.configJson) as GenerationDraft : null
  const repository = await store.persistence.advancedThreads.repository(owner, member.story)
  if (!repository || !['github', 'gitlab'].includes(repository.provider))
    throw new ThreadRestartError(409, 'Saved Story provider identity is invalid.')
  return { ...repository, threadId, conversationId: member.conversation, storyId: member.story,
    sourceJobId: latest.jobId, rootJobId: first.jobId, originalSha: original.commitSha!,
    task: task.trim(), contract, sourceTitle: member.title,
    model: currentConfig?.model ?? config?.model ?? null,
    limits: currentConfig?.limits ?? config?.limits ?? {} }
}

/** A fresh authenticated provider lookup, not a cached Git ref or caller URL. */
export async function currentRestartUpstream(auth: StudioAuth, store: StudioDatabase,
  headers: Headers, source: Source): Promise<Upstream> {
  const token = await getRepositoryToken(auth, store, headers, source.provider, source.repositoryId)
  if (!token) throw new ThreadRestartError(409, 'Reconnect the repository provider to select a newer revision.')
  const branchRef = (branch: string) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,190}$/.test(branch) ||
        branch.includes('..') || branch.includes('@{') || branch.endsWith('.') ||
        branch.split('/').some(s => !s || s === '.' || s === '..' || s.endsWith('.lock')))
      throw new ThreadRestartError(409, 'Upstream default branch is unsafe.')
    return branch
  }
  if (source.provider === 'github') {
    const matching = await matchingRepository(token, source.repository)
    if (String(matching.id) !== source.providerId) throw new ThreadRestartError(409, 'GitHub repository identity changed.')
    const path = '/repos/' + source.repository.split('/').map(encodeURIComponent).join('/')
    const repo = await github<{ id: number; default_branch: string }>(token, path)
    if (String(repo.id) !== source.providerId) throw new ThreadRestartError(409, 'GitHub repository identity changed.')
    const branch = branchRef(repo.default_branch)
    const data = await github<{ commit: { sha: string } }>(token, path + '/branches/' + encodeURIComponent(branch))
    if (!SHA.test(data.commit?.sha)) throw new ThreadRestartError(502, 'GitHub returned an invalid commit.')
    return { branch, sha: data.commit.sha.toLowerCase(), token,
      remoteUrl: 'https://github.com/' + source.repository + '.git' }
  }
  const id = Number(source.providerId)
  if (!Number.isSafeInteger(id) || id < 1)
    throw new ThreadRestartError(409, 'GitLab project identity is invalid.')
  let member = false
  for (let n = 1; n <= 100; n++) {
    const listing = await page(token, n)
    member = listing.data.some(p => p.id === id && p.path_with_namespace === source.repository && eligible(p))
    if (member || !listing.next) break
  }
  if (!member) throw new ThreadRestartError(403, 'GitLab repository access or identity changed.')
  const project = (await gitlab<{ id: number; path_with_namespace: string; archived: boolean; default_branch: string }>(
    token, '/projects/' + id)).data
  if (project?.id !== id || project.path_with_namespace !== source.repository || project.archived)
    throw new ThreadRestartError(409, 'GitLab repository identity changed.')
  const branch = branchRef(project.default_branch)
  const revision = (await gitlab<{ commit: { id: string } }>(
    token, '/projects/' + id + '/repository/branches/' + encodeURIComponent(branch))).data
  if (!SHA.test(revision?.commit?.id)) throw new ThreadRestartError(502, 'GitLab returned an invalid commit.')
  return { branch, sha: revision.commit.id.toLowerCase(), token,
    remoteUrl: 'https://gitlab.com/' + source.repository + '.git' }
}

export type RestartPreview = {
  threadId: string; sourceJobId: string; originalSha: string; originalJobId: string
  provider: 'github' | 'gitlab'; repository: string; title: string
  upstream: { branch: string; sha: string } | null; upstreamError: string | null
}
export async function previewThreadRestart(auth: StudioAuth, store: StudioDatabase,
  request: Request, threadId: string, lookup = currentRestartUpstream): Promise<RestartPreview> {
  assertStudioSchemaCurrent(store)
  const actor = await requireUser(auth, request.headers)
  if (!actor) throw new ThreadRestartError(401, 'Sign in required.')
  const source = await sourceFor(store, actor.id, threadId)
  let upstream: RestartPreview['upstream'] = null
  let upstreamError: string | null = null
  try {
    const remote = await lookup(auth, store, request.headers, source)
    upstream = { branch: remote.branch, sha: remote.sha }
  } catch {
    upstreamError = 'Upstream revision unavailable; reconnect or refresh to compare before selecting it.'
  }
  return { threadId, sourceJobId: source.sourceJobId, originalSha: source.originalSha,
    originalJobId: source.rootJobId, title: source.sourceTitle, provider: source.provider,
    repository: source.repository, upstream, upstreamError }
}

function requestBody(value: unknown): RestartSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ThreadRestartError(400, 'Invalid restart selection.')
  const item = value as Record<string, unknown>
  if (Object.keys(item).sort().join(',') !== 'childId,mode,originalSha,selectedSha,sourceJobId,targetBranch' ||
      typeof item.childId !== 'string' || !UUID.test(item.childId) ||
      typeof item.sourceJobId !== 'string' || !UUID.test(item.sourceJobId) ||
      typeof item.originalSha !== 'string' || !SHA.test(item.originalSha) ||
      typeof item.selectedSha !== 'string' || !SHA.test(item.selectedSha) ||
      (item.mode !== 'original' && item.mode !== 'newer') ||
      (item.mode === 'original' && (item.selectedSha !== item.originalSha || item.targetBranch !== null)) ||
      (item.mode === 'newer' && (item.selectedSha === item.originalSha ||
        typeof item.targetBranch !== 'string' || item.targetBranch.length > 200))) {
    throw new ThreadRestartError(400, 'Select the exact original or explicitly checked upstream revision.')
  }
  return item as RestartSelection
}

async function verifyNewerStory(child: Awaited<ReturnType<typeof acquireCachedStory>>,
  originalSha: string, draft: GenerationDraft, upstream: Upstream) {
  const env = gitEnvironment(upstream.remoteUrl, upstream.token)
  // The repository cache fetches pinned revisions with --depth=1. A valid
  // descendant can appear unrelated until that exact commit's Git ancestry
  // is deepened. Fetch bounded history without checking out or resetting any
  // existing branch/worktree; refuse genuinely unrelated or excessively deep
  // histories rather than guessing based on matching paths.
  let ancestor = false
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', originalSha, child.baseSha],
        { cwd: child.worktreeRoot, env, stdio: 'ignore' })
      ancestor = true
      break
    } catch { /* Need to distinguish shallow from genuinely unrelated. */ }
    const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: child.worktreeRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (shallow !== 'true') break
    try {
      execFileSync('git', ['fetch', '--no-tags', '--filter=blob:none', '--deepen=32',
        'origin', child.baseSha], {
        cwd: child.worktreeRoot, env, timeout: 120_000, stdio: 'ignore',
      })
    } catch {
      throw new ThreadRestartError(409, 'Could not safely verify selected upstream ancestry.')
    }
  }
  if (!ancestor) throw new ThreadRestartError(409, 'Selected upstream is unrelated to the original Story revision.')
  const validation = await validateStoryJob(child)
  if (validation.status !== 'passed' || !validation.report ||
      (validation.report.diagnostics as unknown[])?.length)
    throw new ThreadRestartError(409, 'New upstream Story canon failed native validation. Preserve the old Thread.')
  const index = canonicalExplorerIndex(validation.report, child.baseSha, child.headSha, validation.status)
  validateGenerationDraft(draft, index, validation.report.records)
  // Validate protected decisions against the *original* Story, not against
  // the selected commit itself (which would conceal upstream retcons).
  const protection = await validateStoryJob(child, undefined, {
    worktreeRoot: child.worktreeRoot, worktreeStoryRoot: child.worktreeStoryRoot,
    baseSha: originalSha,
  })
  const report = protection.report as { protection?: {
    status?: string; base?: string; changes?: unknown[]; warnings?: unknown[]
  } } | undefined
  if (protection.status !== 'passed' || report?.protection?.status !== 'checked' ||
      report.protection.base !== originalSha ||
      !Array.isArray(report.protection.changes) || report.protection.changes.length ||
      !Array.isArray(report.protection.warnings) || report.protection.warnings.length)
    throw new ThreadRestartError(409,
      'New upstream changed or could not certify protected decisions against the original Story. Exact author review is required.')
}

export async function prepareThreadRestart(auth: StudioAuth, store: StudioDatabase, request: Request,
  threadId: string, lookup = currentRestartUpstream): Promise<{ id: string; storyId: string; threadId: string }> {
  assertStudioSchemaCurrent(store)
  const actor = await requireUser(auth, request.headers)
  if (!actor) throw new ThreadRestartError(401, 'Sign in required.')
  const input = requestBody(await readJsonInput(request, 2048))
  // Owner and Thread lookup precedes all resource acquisition. A repeated
  // child ID can only refer to this exact operation, never a foreign claim.
  const source = await sourceFor(store, actor.id, threadId)
  const existing = () => store.persistence.advancedThreads.restartIntent(input.childId)
  const intentMatches = (saved: RestartIntent) => saved.owner === actor.id &&
    saved.sourceThread === threadId && saved.sourceJob === input.sourceJobId &&
    saved.rootJob === source.rootJobId && saved.original === input.originalSha &&
    saved.mode === input.mode && saved.selected === input.selectedSha &&
    saved.branch === input.targetBranch
  let intent = await existing()
  if (intent && !intentMatches(intent) ||
      !intent && await store.persistence.advancedThreads.jobClaimed(input.childId) ||
      !intent && await store.persistence.advancedThreads.forkIntent(input.childId))
    throw new ThreadRestartError(409, 'Child ID is already assigned to a different operation.')
  if (intent?.preparedAt) {
    const registered = await selectedJob(store, actor.id, input.childId)
    if (registered.storyId !== source.storyId || registered.commitSha !== intent.selected ||
        !await store.persistence.advancedThreads.preparedRestart(actor.id, input.childId,
          'restart:' + input.childId))
      throw new ThreadRestartError(409, 'Prepared restart registration differs from the saved intent.')
    return { id: input.childId, storyId: source.storyId, threadId: 'restart:' + input.childId }
  }
  if (input.sourceJobId !== source.sourceJobId || input.originalSha !== source.originalSha)
    throw new ThreadRestartError(409, 'Source Thread or original Story revision changed. Refresh before restarting.')
  // Verify that both saved execution identities remain recoverable. Do not
  // acquire a writer lock or touch either source worktree.
  await restoreJob(await selectedJob(store, actor.id, source.sourceJobId), actor.id)
  const original = await restoreJob(await selectedJob(store, actor.id, source.rootJobId), actor.id)
  const currentDraft: GenerationDraft = { version: 1, headSha: input.selectedSha,
    task: source.task, contract: source.contract, model: source.model, limits: source.limits }
  let upstream: Upstream | null = null
  if (input.mode === 'newer') {
    upstream = await lookup(auth, store, request.headers, source)
    if (upstream.sha !== input.selectedSha || upstream.branch !== input.targetBranch)
      throw new ThreadRestartError(409, 'Upstream moved since selection. Refresh and explicitly select its new SHA.')
  }
  if (!intent) {
    intent = await store.persistence.advancedThreads.reserveRestart({
      childId: input.childId, owner: actor.id, sourceThread: threadId,
      sourceJob: source.sourceJobId, rootJob: source.rootJobId,
      original: source.originalSha, selected: input.selectedSha,
      mode: input.mode, branch: input.targetBranch,
      draft: JSON.stringify(currentDraft), at: new Date().toISOString(),
    })
    if (!intentMatches(intent))
      throw new ThreadRestartError(409, 'Restart reservation changed concurrently.')
  }
  // The original Thread is NEVER used as a writer. All preflight files and
  // validator pins belong only to the new isolated job.
  const child = upstream ? await acquireCachedStory({
    cacheDirectory: process.env.NT_GIT_CACHE_DIR ?? '',
    ownerId: actor.id, repositoryId: source.provider + ':' + source.providerId,
    remoteUrl: upstream.remoteUrl, token: upstream.token, directory: source.directory,
    commit: input.selectedSha, jobId: input.childId,
  }) : await continueCachedStory(original, input.childId, source.originalSha)
  if (child.baseSha !== input.selectedSha || child.headSha !== input.selectedSha)
    throw new ThreadRestartError(409, 'Restart worktree does not match the selected Git revision.')
  if (upstream) {
    await verifyNewerStory(child, source.originalSha, JSON.parse(intent!.draft) as GenerationDraft, upstream)
    // The upstream branch may move during Git acquisition or native validation.
    const refreshed = await lookup(auth, store, request.headers, source)
    if (refreshed.sha !== input.selectedSha || refreshed.branch !== input.targetBranch)
      throw new ThreadRestartError(409, 'Upstream moved during restart preparation; no child was registered.')
  }
  await store.persistence.advancedThreads.registerChild({
    childId: input.childId, owner: actor.id, storyId: source.storyId,
    title: source.sourceTitle + ' (restart)', baseSha: child.baseSha,
    conversationId: source.conversationId, parentThreadId: threadId,
    threadId: 'restart:' + input.childId, draft: intent!.draft,
    at: new Date().toISOString(), kind: 'restart',
  })
  return { id: input.childId, storyId: source.storyId, threadId: 'restart:' + input.childId }
}

/** Authenticated adapter shared with ordinary TanStack server functions. */
export async function threadRestartRequest(auth: StudioAuth, store: StudioDatabase, request: Request,
  threadId: string, baseURL: string, lookup = currentRestartUpstream): Promise<Response> {
  if (!ID.test(threadId)) return reply({ error: 'Invalid Thread ID.' }, 400)
  if (!['GET', 'POST'].includes(request.method)) return reply({ error: 'Method not allowed.' }, 405)
  if (request.method === 'POST' && request.headers.get('origin') !== baseURL)
    return reply({ error: 'Cross-origin write refused.' }, 403)
  try {
    if (request.method === 'GET') return reply(await previewThreadRestart(auth, store, request, threadId, lookup))
    return reply(await prepareThreadRestart(auth, store, request, threadId, lookup))
  } catch (error) {
    if (error instanceof ThreadRestartError)
      return reply({ error: error.message }, error.status)
    if (error instanceof JsonInputError) return reply({ error: error.message }, error.statusCode)
    // Do not reflect file paths, provider credentials, receipts or Git errors.
    const status = error instanceof GitCacheError ? error.status :
      error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
        ? error.status : 409
    console.error('[Studio Thread restart] Preparation refused',
      error instanceof Error ? error.message : String(error))
    return reply({ error: status === 404 ? 'Thread or repository not found.' :
      'Restart could not be safely prepared. The original Thread is unchanged; inspect preserved evidence.' }, status)
  }
}
