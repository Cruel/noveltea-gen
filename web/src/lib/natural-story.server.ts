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
import { planObjective, type TurnPlan } from './turn-plan'
import { inferStoryObjective, isWholeStoryCreationRequest, isExistingStoryModificationRequest } from './story-revision-plan'
import { validatedExplorer } from './story-explorer.server'
import type { NaturalStoryPlan } from './natural-story-plan'
import type { CanonicalScopeRecord } from '../../../src/focused-scope'
import { creativePolicy, validCreativeMode, type CreativeMode, type CreativePolicy } from '../../../src/creative-policy'
import { saveJobTurnPlan, readJobTurnPlan } from './turn-plan-receipt.server'

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
  creativeMode?: CreativeMode
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
/** Preparing an owner-bound root job is not permission to write Story files. */
async function prepareNaturalSource(auth: StudioAuth, store: StudioDatabase,
  owner: string, headers: Headers, baseURL: string,
  story: Awaited<ReturnType<typeof selectedStory>>, jobId: string) {
  if (!UUID.test(jobId)) throw new Error('Invalid prepared Story job ID.')
  const previous = await store.persistence.naturalStory.previousJob(owner, jobId)
  if (previous && (previous.storyId !== story.storyId ||
      previous.threadId && previous.threadId !== 'root:' + jobId))
    throw new Error('Prepared Story job belongs to another Story or Thread.')
  if (previous) {
    const job = await authorizedStoryJob(store, owner, jobId)
    if (job.baseSha !== story.headSha || job.headSha !== story.headSha)
      throw new Error('Existing prepared job differs from the selected Story source.')
    return job
  }
  const prepared = await responseJson(await (story.provider === 'github'
    ? githubJobRequest(auth, store,
      asRequest(baseURL, headers, '/api/github/jobs', 'POST',
        { storyId: story.storyId, jobId, commit: story.headSha }), baseURL)
    : gitlabJobRequest(auth, store,
      asRequest(baseURL, headers, '/api/gitlab/jobs', 'POST',
        { storyId: story.storyId, jobId, commit: story.headSha }), baseURL)))
  const job = prepared.job as { headSha?: string } | undefined
  if (job?.headSha !== story.headSha)
    throw new Error('Prepared Story differs from the approved source revision.')
  return authorizedStoryJob(store, owner, jobId)
}

/** Canonical native evidence is mandatory before a first Turn can grant
 * existing-record scope. The same source inspection is reused at admission. */
async function preparedNaturalCatalog(auth: StudioAuth, store: StudioDatabase,
  owner: string, headers: Headers, baseURL: string,
  story: Awaited<ReturnType<typeof selectedStory>>, jobId: string) {
  await prepareNaturalSource(auth, store, owner, headers, baseURL, story, jobId)
  const native = await validatedExplorer(auth, store, new Request(baseURL + '/api/story-explorer',
    { headers }), jobId, { storyBaseSha: story.headSha! })
  const report = native.result.report as { records?: CanonicalScopeRecord[];
    diagnostics?: unknown[]; protection?: { status?: string; base?: string;
      changes?: unknown[]; warnings?: unknown[] } } | undefined
  if (native.result.status !== 'passed' || !Array.isArray(report?.records) ||
      !Array.isArray(report.diagnostics) || report.diagnostics.length ||
      report.protection?.status !== 'checked' || report.protection.base !== story.headSha ||
      report.protection.changes?.length || report.protection.warnings?.length)
    throw new Error('Focused first Turn requires a clean, native-verified canonical Story and protected source.')
  return report.records
}

/** First and later Turns share inference against verified canon; the only
 * missing-canon fallback is a non-executable preview, never a full writer. */
export function interpretFirstObjective(prompt: string, edits: PlanEdits | undefined,
  base: string, catalog?: CanonicalScopeRecord[], jobId?: string,
  policy: CreativePolicy = creativePolicy('autonomous')) {
  const initial = interpretNaturalStoryPrompt(prompt, edits)
  if (!catalog && !isWholeStoryCreationRequest(initial.task)) {
    if (isExistingStoryModificationRequest(initial.task)) return {
      plan: { ...initial, stages: [], reviewRequired: true,
        clarification: 'Inspect the existing canonical Story before selecting a focused first-Turn scope.' },
      turnPlan: null as TurnPlan | null,
    }
    // A bare creative brief with no modification intent is an initial Story;
    // no existing-record writing authority is inferred from the blank catalog.
    return { plan: initial, turnPlan: planObjective({ kind: 'full-story',
      request: initial.task, contract: initial.contract, base, policy }) as TurnPlan | null }
  }
  const inferred = inferStoryObjective(initial.task, catalog ?? [], base, initial.contract)
  const clarification = inferred.protectedChange
    ? 'Protected decisions require an existing Thread and a separately approved exact amendment.'
    : inferred.clarification
  const stages: NaturalStoryPlan['stages'] = inferred.contract.scope.kind === 'full-story'
    ? initial.stages : inferred.targets.length ? [
      { id: 'focus', dependsOn: [], description: 'Edit only the verified selected Story records' },
      { id: 'review', dependsOn: ['focus'], description: 'Independently review the focused changes' },
    ] : []
  const plan: NaturalStoryPlan = { task: inferred.request, contract: inferred.contract, stages,
    reviewRequired: (catalog?.length ? inferred.reviewRequired : initial.reviewRequired) || !!clarification,
    clarification,
    digest: inferred.digest }
  const turnPlan = clarification ? null : inferred.contract.scope.kind === 'full-story'
    ? planObjective({ kind: 'full-story', request: inferred.request,
        contract: inferred.contract, base, policy })
    : planObjective({ kind: 'revision', request: inferred.request,
        contract: inferred.contract, base, sourceJobId: jobId!, catalog: catalog!,
        targetIds: inferred.targets, allowedPaths: inferred.writePaths, policy })
  return { plan, turnPlan }
}

export async function previewNaturalStory(store: StudioDatabase, owner: string,
  storyId: string, prompt: string, edits?: PlanEdits,
  prepared?: { auth: StudioAuth; headers: Headers; baseURL: string; jobId: string }) {
  await store.assertReady()
  const story = await selectedStory(store, owner, storyId)
  const catalog = prepared && isExistingStoryModificationRequest(prompt)
    ? await preparedNaturalCatalog(prepared.auth, store, owner,
        prepared.headers, prepared.baseURL, story, prepared.jobId) : undefined
  const { plan, turnPlan } = interpretFirstObjective(prompt, edits, story.headSha!,
    catalog, prepared?.jobId)
  return { plan, turnPlan, storyId: story.storyId, headSha: story.headSha!,
    jobId: prepared?.jobId,
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
  if (!input || !UUID.test(input.jobId) ||
      input.creativeMode !== undefined && !validCreativeMode(input.creativeMode))
    throw new Error('Invalid idempotent job ID or creative mode.')
  const story = await selectedStory(store, actor.id, input.storyId)
  if (input.headSha !== story.headSha)
    throw new Error('The Story base revision changed. Review the refreshed plan before starting.')
  // Validate the raw creative brief and limits before provisioning any job.
  const rawPlan = interpretNaturalStoryPrompt(input.prompt, input.edits)
  if (rawPlan.reviewRequired && !input.approvedDigest)
    throw new Error(rawPlan.clarification ?? 'Review the interpreted objective before starting.')
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
      previous.threadId && previous.threadId !== 'root:' + input.jobId))
    throw new Error('Job ID already belongs to a different Story or Thread.')
  // Once admitted, the exact pinned request is authoritative. A running job's
  // HEAD may have advanced, so never revalidate its old source as a new preview
  // or run an objective planner again just to answer an idempotent HTTP retry.
  if (previous?.requestJson) {
    const saved = JSON.parse(previous.requestJson) as { task?: string;
      contract?: NaturalStoryPlan['contract'] }
    const configured = previous.configJson ? JSON.parse(previous.configJson) as {
      limits?: Limits; model?: PiSelection | null } : null
    const job = await authorizedStoryJob(store, actor.id, input.jobId)
    const turn = await readJobTurnPlan(job)
    const expectedConstraints = [...new Set([
      ...rawPlan.contract.constraints,
      ...(turn?.kind === 'revision'
        ? ['Revision objective (only within the selected existing canonical records): ' + rawPlan.task]
        : isWholeStoryCreationRequest(rawPlan.task)
          ? ['Honor this author objective: ' + rawPlan.task] : []),
    ])]
    if (saved.task !== rawPlan.task || !saved.contract ||
        !turn || turn.originalRequest !== rawPlan.task ||
        turn.source.verifiedSha !== story.headSha ||
        JSON.stringify(saved.contract) !== JSON.stringify(turn.contract) ||
        JSON.stringify(turn.contract.envelope) !== JSON.stringify(rawPlan.contract.envelope) ||
        JSON.stringify(turn.contract.constraints) !== JSON.stringify(expectedConstraints) ||
        JSON.stringify(turn.creativePolicy) !==
          JSON.stringify(creativePolicy(input.creativeMode ?? 'autonomous')) ||
        configured && (JSON.stringify(configured.limits) !== JSON.stringify(limits) ||
          JSON.stringify(configured.model) !== JSON.stringify(model)))
      throw new Error('Job ID was already admitted with a different original objective or settings.')
    return { jobId: input.jobId, threadId: 'root:' + input.jobId,
      plan: { ...rawPlan, contract: turn.contract,
        stages: turn.kind === 'revision' ? [
          { id: 'focus' as const, dependsOn: [], description: 'Verified focused Story edit' },
          { id: 'review' as const, dependsOn: ['focus' as const], description: 'Independent review' },
        ] : rawPlan.stages, reviewRequired: turn.reviewRequired } }
  }
  let catalog: CanonicalScopeRecord[] | undefined
  if (isExistingStoryModificationRequest(input.prompt))
    catalog = await preparedNaturalCatalog(auth, store, actor.id, headers, baseURL,
      story, input.jobId)
  else await prepareNaturalSource(auth, store, actor.id, headers, baseURL,
    story, input.jobId)
  const { plan, turnPlan } = interpretFirstObjective(input.prompt, input.edits,
    story.headSha!, catalog, input.jobId, creativePolicy(input.creativeMode ?? 'autonomous'))
  if (!turnPlan || plan.clarification)
    throw new Error(plan.clarification ?? 'This Story objective has no verified writable target.')
  if (plan.reviewRequired && input.approvedDigest !== plan.digest)
    throw new Error('Review the interpreted plan before starting.')
  if (input.approvedDigest && input.approvedDigest !== plan.digest)
    throw new Error('The interpreted plan changed. Review it again before starting.')
  const draft = { version: 1 as const, task: plan.task, contract: plan.contract, limits, model }
  if (previous?.configJson) {
    const saved = JSON.parse(previous.configJson) as Record<string, unknown>
    if (JSON.stringify({ version: saved.version, task: saved.task, contract: saved.contract,
      limits: saved.limits, model: saved.model }) !== JSON.stringify(draft))
      throw new Error('Job ID was already submitted with different generation settings.')
  }
  await saveJobTurnPlan(await authorizedStoryJob(store, actor.id, input.jobId), turnPlan)
  const threadId = await associateNaturalThread(store, actor.id, input.storyId,
    input.jobId, plan.task.slice(0, 120))
  if (input.creativeMode && !await store.persistence.conversations.setCreativePolicy(
      actor.id, threadId, JSON.stringify(creativePolicy(input.creativeMode))))
    throw new Error('First Thread creative mode could not be pinned.')
  await responseJson(await generationConfigurationRequest(auth, store,
    asRequest(baseURL, headers, '/api/jobs/' + input.jobId + '/configuration',
      'PUT', { ...draft, headSha: story.headSha }),
    input.jobId, baseURL))
  await responseJson(await generationJobRequest(auth, store,
    asRequest(baseURL, headers, '/api/jobs/' + input.jobId, 'POST',
      { task: plan.task, contract: plan.contract }), input.jobId, baseURL))
  return { jobId: input.jobId, threadId, plan }
}
