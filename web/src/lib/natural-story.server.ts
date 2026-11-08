import type { StudioAuth } from './auth'
import type { StudioStore as StudioDatabase } from '../persistence/store'
import { requireUser } from './access.server'
import { interpretNaturalStoryPrompt, type PlanEdits } from './natural-story-plan'
import { availableUserPiModels, assertUserPiSelection, validPiSelection, type PiSelection } from './pi-credentials.server'
import { readDefaultModel } from './settings.server'
import { githubJobRequest } from './github-jobs.server'
import { gitlabJobRequest } from './gitlab-jobs.server'
import { generationConfigurationRequest } from './generation-config.server'
import { generationJobRequest, verifyWebExecution } from './fixture-jobs.server'
import { parseJobLimits, type JobLimits } from '../../../src/job-limits'
import { authorizedStoryJob } from './fixture-jobs.server'
import { planWholeStory } from './turn-plan'
import { saveJobTurnPlan } from './turn-plan-receipt.server'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{40}$/i
type Limits = JobLimits
export type NaturalStoryInput = {
  storyId: string
  jobId: string
  headSha: string
  prompt: string
  edits?: PlanEdits
  model?: PiSelection | null
  limits?: Limits
  fixture?: boolean
  approvedDigest?: string
}
async function selectedStory(store: StudioDatabase, owner: string, storyId: string) {
  if (!UUID.test(storyId)) throw new Error('Invalid Story ID.')
  const row = await store.persistence.naturalStory.story(owner, storyId)
  if (!row) throw new Error('Story not found.')
  if (!SHA.test(row.headSha ?? '')) throw new Error('Story has no verified source commit.')
  return row
}
async function modelOptions(store: StudioDatabase, owner: string) {
  const models = await availableUserPiModels(store, owner)
  const preferred = await readDefaultModel(store.persistence.settings, owner)
  // Never silently switch a default to an arbitrary connected, billable model.
  // The author can make an explicit alternative selection in advanced settings.
  const defaultModel = preferred && models.some(m =>
    m.provider === preferred.provider && m.id === preferred.id && (!preferred.thinking || m.reasoning))
    ? preferred : null
  return { models, defaultModel }
}
export async function previewNaturalStory(store: StudioDatabase, owner: string,
  storyId: string, prompt: string, edits?: PlanEdits) {
  await store.assertReady()
  const story = await selectedStory(store, owner, storyId)
  const plan = interpretNaturalStoryPrompt(prompt, edits)
  return { plan, turnPlan: planWholeStory(plan.task, plan.contract, story.headSha!),
    storyId: story.storyId, headSha: story.headSha!,
    ...await modelOptions(store, owner) }
}
function checkLimits(limits: unknown): Limits {
  return parseJobLimits(limits ?? {})
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

/** A prepared job owns a Story-scoped root Thread. Validate that identity;
 * a failed acquisition remains inspectable rather than silently retried. */
export async function associateNaturalThread(store: StudioDatabase, owner: string,
  storyId: string, jobId: string, title: string) {
  return store.persistence.naturalStory.associateRoot(owner, storyId, jobId,
    title, new Date().toISOString())
}

/** One trusted admission path: provider-pinned acquisition -> typed canonical
 * draft validation -> existing owner/validator/graph gate -> durable queue.
 * The browser supplies a creative brief, never a Graph/Pi write grant. */
export async function launchNaturalStory(auth: StudioAuth, store: StudioDatabase,
  headers: Headers, baseURL: string, input: NaturalStoryInput) {
  await store.assertReady()
  const actor = await requireUser(auth, headers)
  if (!actor) throw new Error('Sign in required.')
  const origin = headers.get('origin')
  if (origin && origin !== baseURL) throw new Error('Cross-origin write refused.')
  if (!input || !UUID.test(input.jobId)) throw new Error('Invalid idempotent job ID.')
  const story = await selectedStory(store, actor.id, input.storyId)
  if (input.headSha !== story.headSha)
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

  const previous = await store.persistence.naturalStory.previousJob(actor.id, input.jobId)
  if (previous && (previous.storyId !== story.storyId ||
      previous.threadId !== 'root:' + input.jobId))
    throw new Error('Job ID already belongs to a different Story or Thread.')
  const draft = { version: 1 as const, task: plan.task, contract: plan.contract, limits, model }
  if (previous?.configJson) {
    const saved = JSON.parse(previous.configJson) as Record<string, unknown>
    if (JSON.stringify({ version: saved.version, task: saved.task, contract: saved.contract,
      limits: saved.limits, model: saved.model }) !== JSON.stringify(draft))
      throw new Error('Job ID was already submitted with different generation settings.')
  }
  if (previous?.requestJson) {
    const request = JSON.parse(previous.requestJson) as Record<string, unknown>
    if (request.task !== plan.task || JSON.stringify(request.contract) !== JSON.stringify(plan.contract))
      throw new Error('Job ID was already admitted with a different request.')
    return { jobId: input.jobId, threadId: 'root:' + input.jobId, plan }
  }
  const prepared = await responseJson(await (story.provider === 'github'
    ? githubJobRequest(auth, store,
      asRequest(baseURL, headers, '/api/github/jobs', 'POST',
        { storyId: story.storyId, jobId: input.jobId, commit: story.headSha }), baseURL)
    : gitlabJobRequest(auth, store,
      asRequest(baseURL, headers, '/api/gitlab/jobs', 'POST',
        { storyId: story.storyId, jobId: input.jobId, commit: story.headSha }), baseURL)))
  const job = prepared.job as { headSha?: string } | undefined
  if (!job?.headSha || !SHA.test(job.headSha)) throw new Error('Provider did not return a pinned job revision.')
  if (job.headSha !== story.headSha) throw new Error('Acquired Story differs from the approved source revision.')
  await saveJobTurnPlan(await authorizedStoryJob(store, actor.id, input.jobId),
    planWholeStory(plan.task, plan.contract, story.headSha!))
  const threadId = await associateNaturalThread(store, actor.id, input.storyId,
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
