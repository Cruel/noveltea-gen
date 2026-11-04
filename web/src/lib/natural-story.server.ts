import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './access.server'
import { interpretNaturalStoryPrompt, type PlanEdits } from './natural-story-plan'
import { availableUserPiModels, assertUserPiSelection, validPiSelection, type PiSelection } from './pi-credentials.server'
import { readDefaultModel } from './settings.server'
import { githubJobRequest } from './github-jobs.server'
import { gitlabJobRequest } from './gitlab-jobs.server'
import { generationConfigurationRequest } from './generation-config.server'
import { generationJobRequest, verifyWebExecution } from './fixture-jobs.server'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{40}$/i
type Limits = { steps?: number; modelCalls?: number; costUsd?: number }
export type NaturalStoryInput = {
  conversationId: string
  jobId: string
  headSha: string
  prompt: string
  edits?: PlanEdits
  model?: PiSelection | null
  limits?: Limits
  fixture?: boolean
  approvedDigest?: string
}
type SelectedConversation = {
  id: string; storyId: string; provider: 'github' | 'gitlab'
  headSha: string | null
}
function selectedConversation(store: StudioDatabase, owner: string, conversationId: string): SelectedConversation {
  if (!UUID.test(conversationId)) throw new Error('Invalid Conversation ID.')
  const row = store.sqlite.prepare(`SELECT c.id,c.story_id AS storyId,
    s.source_commit_sha AS headSha,r.provider
    FROM story_conversations c JOIN stories s ON s.id=c.story_id
      AND s.owner_user_id=c.owner_user_id
    JOIN repositories r ON r.id=s.repository_id AND r.owner_user_id=s.owner_user_id
    WHERE c.id=? AND c.owner_user_id=?`).get(conversationId, owner) as SelectedConversation | undefined
  if (!row) throw new Error('Conversation not found.')
  if (!SHA.test(row.headSha ?? '')) throw new Error('Story has no verified source commit.')
  if (!['github', 'gitlab'].includes(row.provider)) throw new Error('Unsupported Story provider.')
  return row
}
async function modelOptions(store: StudioDatabase, owner: string) {
  const models = await availableUserPiModels(store, owner)
  const preferred = readDefaultModel(store, owner)
  // Never silently switch a default to an arbitrary connected, billable model.
  // The author can make an explicit alternative selection in advanced settings.
  const defaultModel = preferred && models.some(m =>
    m.provider === preferred.provider && m.id === preferred.id && (!preferred.thinking || m.reasoning))
    ? preferred : null
  return { models, defaultModel }
}
export async function previewNaturalStory(store: StudioDatabase, owner: string,
  conversationId: string, prompt: string, edits?: PlanEdits) {
  assertStudioSchemaCurrent(store)
  const conversation = selectedConversation(store, owner, conversationId)
  const plan = interpretNaturalStoryPrompt(prompt, edits)
  return { plan, storyId: conversation.storyId, headSha: conversation.headSha!,
    ...await modelOptions(store, owner) }
}
function checkLimits(limits: unknown): Limits {
  if (limits === undefined) return {}
  if (!limits || typeof limits !== 'object' || Array.isArray(limits) ||
      Object.keys(limits).some(key => !['steps', 'modelCalls', 'costUsd'].includes(key)))
    throw new Error('Invalid budget settings.')
  const value = limits as Record<string, unknown>
  for (const [key, amount] of Object.entries(value)) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 ||
        amount > 1_000_000 || (key !== 'costUsd' && !Number.isSafeInteger(amount)))
      throw new Error('Budget limits must be bounded nonnegative numbers.')
  }
  return value as Limits
}
function asRequest(baseURL: string, headers: Headers, path: string, method: 'POST' | 'PUT', body: unknown) {
  const forwarded = new Headers(headers)
  forwarded.set('origin', baseURL)
  forwarded.set('content-type', 'application/json')
  return new Request(baseURL + path, { method, headers: forwarded, body: JSON.stringify(body) })
}
async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const data = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) throw new Error(
    typeof data?.error === 'string' ? data.error : 'Generation could not be safely scheduled.')
  return data ?? {}
}

/** A prepared job already owns a root Thread. Rehome only that root into the
 * author's selected Conversation; never alter a fork or another owner/thread.
 * A failed acquisition remains inspectable rather than being silently retried. */
export function associateNaturalThread(store: StudioDatabase, owner: string,
  conversationId: string, jobId: string, title: string) {
  const threadId = 'root:' + jobId
  return store.sqlite.transaction(() => {
    const membership = selectedConversation(store, owner, conversationId)
    const row = store.sqlite.prepare(`SELECT t.conversation_id AS conversationId,
      t.parent_thread_id AS parentId
      FROM story_threads t JOIN story_thread_runs r ON r.thread_id=t.id
      JOIN studio_sessions j ON j.id=r.job_id AND j.owner_user_id=r.owner_user_id
      WHERE t.id=? AND t.owner_user_id=? AND r.job_id=? AND r.run_order=0
        AND j.story_id=?`).get(threadId, owner, jobId, membership.storyId) as
      { conversationId: string; parentId: string | null } | undefined
    if (!row || row.parentId ||
        (row.conversationId !== conversationId && row.conversationId !== 'legacy:' + jobId))
      throw new Error('Generation job already belongs to another Thread or Conversation.')
    const now = new Date().toISOString()
    store.sqlite.prepare(`UPDATE story_threads SET conversation_id=?, title=?, activity_at=?
      WHERE id=? AND owner_user_id=?`).run(conversationId, title.slice(0, 120), now, threadId, owner)
    store.sqlite.prepare(`UPDATE story_conversations SET updated_at=?
      WHERE id=? AND owner_user_id=?`).run(now, conversationId, owner)
    store.sqlite.prepare(`DELETE FROM story_conversations WHERE id=? AND owner_user_id=?
      AND NOT EXISTS (SELECT 1 FROM story_threads WHERE conversation_id=?)`)
      .run('legacy:' + jobId, owner, 'legacy:' + jobId)
    return threadId
  })()
}

/** One trusted admission path: provider-pinned acquisition -> typed canonical
 * draft validation -> existing owner/validator/graph gate -> durable queue.
 * The browser supplies a creative brief, never a Graph/Pi write grant. */
export async function launchNaturalStory(auth: StudioAuth, store: StudioDatabase,
  headers: Headers, baseURL: string, input: NaturalStoryInput) {
  assertStudioSchemaCurrent(store)
  const actor = await requireUser(auth, headers)
  if (!actor) throw new Error('Sign in required.')
  const origin = headers.get('origin')
  if (origin && origin !== baseURL) throw new Error('Cross-origin write refused.')
  if (!input || !UUID.test(input.jobId)) throw new Error('Invalid idempotent job ID.')
  const conversation = selectedConversation(store, actor.id, input.conversationId)
  if (input.headSha !== conversation.headSha)
    throw new Error('The Story base revision changed. Review the refreshed plan before starting.')
  const plan = interpretNaturalStoryPrompt(input.prompt, input.edits)
  if (plan.reviewRequired && input.approvedDigest !== plan.digest)
    throw new Error(plan.clarification ?? 'Review the interpreted plan before starting.')
  if (input.approvedDigest && input.approvedDigest !== plan.digest)
    throw new Error('The interpreted plan changed. Review it again before starting.')
  const limits = checkLimits(input.limits)
  const available = await modelOptions(store, actor.id)
  const model = input.model === undefined ? available.defaultModel : input.model
  if (model !== null && !validPiSelection(model)) throw new Error('Invalid Pi model selection.')
  if (input.fixture === true && model !== null)
    throw new Error('Fixture execution cannot select a real Pi model.')
  if (model === null && input.fixture !== true)
    throw new Error('Connect a Pi model in Settings, or explicitly choose a fixture test run.')
  if (model) await assertUserPiSelection(store, actor.id, model)
  verifyWebExecution(!model)

  const previous = store.sqlite.prepare(`SELECT j.story_id AS storyId,
    j.generation_request_json AS requestJson,j.generation_config_json AS configJson,
    t.conversation_id AS conversationId
    FROM studio_sessions j LEFT JOIN story_thread_runs r ON r.job_id=j.id
    LEFT JOIN story_threads t ON t.id=r.thread_id
    WHERE j.id=? AND j.owner_user_id=?`).get(input.jobId, actor.id) as {
      storyId: string; requestJson: string | null; configJson: string | null
      conversationId: string | null
    } | undefined
  if (previous && (previous.storyId !== conversation.storyId ||
      !['legacy:' + input.jobId, input.conversationId].includes(previous.conversationId ?? '')))
    throw new Error('Job ID already belongs to a different Story or Conversation.')
  const draft = { version: 1 as const, task: plan.task, contract: plan.contract, limits, model }
  if (previous?.configJson) {
    const saved = JSON.parse(previous.configJson) as Record<string, unknown>
    if (JSON.stringify({ version: saved.version, task: saved.task, contract: saved.contract,
      limits: saved.limits, model: saved.model }) !== JSON.stringify(draft))
      throw new Error('Job ID was already submitted with different generation settings.')
  }
  if (previous?.requestJson) {
    if (previous.conversationId !== input.conversationId)
      throw new Error('Job ID already belongs to a different Conversation.')
    const request = JSON.parse(previous.requestJson) as Record<string, unknown>
    if (request.task !== plan.task || JSON.stringify(request.contract) !== JSON.stringify(plan.contract))
      throw new Error('Job ID was already admitted with a different request.')
    return { jobId: input.jobId, threadId: 'root:' + input.jobId, plan }
  }
  const prepared = await responseJson(await (conversation.provider === 'github'
    ? githubJobRequest(auth, store,
      asRequest(baseURL, headers, '/api/github/jobs', 'POST',
        { storyId: conversation.storyId, jobId: input.jobId, commit: conversation.headSha }), baseURL)
    : gitlabJobRequest(auth, store,
      asRequest(baseURL, headers, '/api/gitlab/jobs', 'POST',
        { storyId: conversation.storyId, jobId: input.jobId, commit: conversation.headSha }), baseURL)))
  const job = prepared.job as { headSha?: string } | undefined
  if (!job?.headSha || !SHA.test(job.headSha)) throw new Error('Provider did not return a pinned job revision.')
  const threadId = associateNaturalThread(store, actor.id, input.conversationId,
    input.jobId, plan.task.slice(0, 120))
  await responseJson(await generationConfigurationRequest(auth, store,
    asRequest(baseURL, headers, '/api/jobs/' + input.jobId + '/configuration',
      'PUT', { ...draft, headSha: job.headSha }),
    input.jobId, baseURL))
  await responseJson(await generationJobRequest(auth, store,
    asRequest(baseURL, headers, '/api/jobs/' + input.jobId, 'POST',
      { task: plan.task, contract: plan.contract }), input.jobId, baseURL))
  return { jobId: input.jobId, threadId, plan }
}
