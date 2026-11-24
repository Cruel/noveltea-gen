import type { StudioAuth } from './auth'
import type { StudioStore } from '../persistence/store'
import type { PiSelection } from './pi-credentials.server'
import { assertUserPiSelection } from './pi-credentials.server'
import { requireUser } from './access.server'
import { githubJobRequest } from './github-jobs.server'
import { isVerifiedInitializedDraft } from './cached-jobs.server'
import { gitlabJobRequest } from './gitlab-jobs.server'
import { generationConfigurationRequest } from './generation-config.server'
import { generationJobRequest, authorizedStoryJob, verifyWebExecution } from './fixture-jobs.server'
import { validatedExplorer } from './story-explorer.server'
import { interpretNaturalStoryPrompt } from './natural-story-plan'
import { isExistingStoryModificationRequest } from './story-revision-plan'
import { interpretFirstObjective } from './natural-story.server'
import { saveJobTurnPlan } from './turn-plan-receipt.server'
import { pinChatApprovedFoundation, readChatApprovedFoundation } from '../../../src/chat-approved-foundation'
import { pinReusedFoundation } from '../../../src/chat-reused-foundation'
import { runFoundationJob } from '../../../src/foundation'
import { trustedHead } from '../../../src/revision'
import { foundationOnlyObjective } from './foundation-intent'
import { parseCreativePolicy } from '../../../src/creative-policy'
import { verifiedReusableStoryFoundation } from './story-foundation-reuse.server'
import type { FoundationDraft } from '../../../src/foundation-record'
import { createHash } from 'node:crypto'
import { pinDiscoveryHandoff, readDiscoveryHandoff, sealDiscoveryHandoff, type DiscoveryHandoff } from '../../../src/discovery-generation-handoff'
import { pinnedRequest, selectedJob } from './fixture-jobs.server'
import { requireGenerationTurn } from '../../../src/generation'
import { handoffEffects } from './discovery-handoff-effects.server'

export type ApprovedChatContinuation = {
  chat: { storyId: string; firstTurnId: string; repositoryId: string; directory: string
    sourceSha: string; originalObjective: string }
  digest: string
  skillId: string
  model: PiSelection
  foundation: FoundationDraft
  proof: Pick<DiscoveryHandoff, 'owner' | 'graphEpoch' | 'approvalOperation' |
    'reviewedProposalDigest' | 'authorEvidenceDigest' | 'reviewDigest' | 'foundationDigest' |
    'limits' | 'usage' | 'usageEvidenceDigest'>
}

export type ContinuationStatus = { state: 'queued' | 'pending' | 'blocked' | 'completed'
  message?: string }
export type ProviderJobGateways = {
  github?: typeof githubJobRequest
  gitlab?: typeof gitlabJobRequest
}

function internalRequest(baseURL: string, headers: Headers, path: string,
  method: 'POST' | 'PUT', body: unknown) {
  const forwarded = new Headers(headers)
  forwarded.set('origin', baseURL)
  forwarded.set('content-type', 'application/json')
  return new Request(baseURL + path, {
    method, headers: forwarded, body: JSON.stringify(body),
  })
}
async function responseData(response: Response) {
  const data = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) throw new Error(typeof data?.error === 'string'
    ? data.error : 'Saved Story generation could not be admitted.')
  return data ?? {}
}

/** One shared durable admission, after the reviewed foundation is either
 * already native-verified or has been committed under this same job. A saved
 * config/queue from an interrupted response is reused; never replan an
 * alternative author request. */
async function admitWholeApprovedStory(auth: StudioAuth, store: StudioStore,
  owner: string, headers: Headers, baseURL: string,
  approval: ApprovedChatContinuation, creativePolicyJson: string): Promise<ContinuationStatus> {
  const { chat } = approval
  const job = await authorizedStoryJob(store, owner, chat.firstTurnId)
  const objective = interpretFirstObjective(chat.originalObjective, undefined, chat.sourceSha,
    undefined, undefined, parseCreativePolicy(creativePolicyJson))
  if (!objective.turnPlan || objective.turnPlan.kind !== 'full-story')
    throw new Error('An approved Foundation cannot grant a focused or protected Story writer.')
  await saveJobTurnPlan(job, objective.turnPlan)
  await store.persistence.naturalStory.associateRoot(owner, chat.storyId,
    chat.firstTurnId, chat.originalObjective.slice(0, 120), new Date().toISOString())
  await responseData(await generationConfigurationRequest(auth, store, internalRequest(
    baseURL, headers, '/api/jobs/' + chat.firstTurnId + '/configuration', 'PUT', {
      version: 1, headSha: job.headSha, task: objective.plan.task,
      contract: objective.plan.contract, limits: approval.proof.limits, model: approval.model,
    }), chat.firstTurnId, baseURL))
  await responseData(await generationJobRequest(auth, store, internalRequest(
    baseURL, headers, '/api/jobs/' + chat.firstTurnId, 'POST', {
      task: objective.plan.task, contract: objective.plan.contract,
    }), chat.firstTurnId, baseURL))
  await store.persistence.naturalStory.finishFirstTurn(owner,
    chat.storyId, chat.firstTurnId, true)
  return { state: 'queued' }
}

/** Reclaim only the saved first Turn, never create another one. The already
 * approved proposal remains immutable across failed admission or HTTP retries.
 * Once queued, the generation owner and the root-Thread transaction fence any
 * attempt to start another writer. */
export async function continueApprovedStoryChat(auth: StudioAuth, store: StudioStore,
  headers: Headers, baseURL: string, approval: ApprovedChatContinuation,
  gateways: ProviderJobGateways = {}): Promise<ContinuationStatus> {
  const actor = await requireUser(auth, headers)
  if (!actor) return { state: 'blocked', message: 'Sign in again to continue the approved Story.' }
  const { chat } = approval
  if (approval.proof.owner !== actor.id ||
      approval.proof.foundationDigest !== createHash('sha256').update(JSON.stringify(approval.foundation)).digest('hex'))
    return { state: 'blocked', message: 'The authenticated Discovery approval changed.' }
  const first = await store.persistence.messages.owned(actor.id,
    'root:' + chat.firstTurnId, chat.firstTurnId)
  const story = await store.persistence.naturalStory.story(actor.id, chat.storyId)
  if (!story || !first || story.repositoryId !== chat.repositoryId ||
      story.directory !== chat.directory || story.headSha !== chat.sourceSha ||
      first.content !== chat.originalObjective || first.role !== 'user' ||
      first.phase === 'cancelled' || first.jobId && first.jobId !== chat.firstTurnId)
    return { state: 'blocked', message: 'The pinned Story or first Turn changed. Inspect its saved revision.' }
  const foundationOnly = foundationOnlyObjective(chat.originalObjective)
  const objective = interpretFirstObjective(chat.originalObjective, undefined, chat.sourceSha,
    undefined, undefined, parseCreativePolicy(first.creativePolicyJson))
  const receipt = sealDiscoveryHandoff({
    ...approval.proof, ...chat, threadId: 'root:' + chat.firstTurnId,
    approvedProposalDigest: approval.digest, skillId: approval.skillId,
    model: approval.model, turnPlanDigest: foundationOnly ? null : objective.turnPlan?.digest ?? null,
  })
  const effects = await handoffEffects(store, receipt)
  const verifyHandoff = async () => {
    const job = await authorizedStoryJob(store, actor.id, chat.firstTurnId)
    if ((await readDiscoveryHandoff(job))?.digest !== receipt.digest)
      throw Error('The original Discovery-to-Generation handoff differs.')
    return job
  }
  if (first.phase === 'finished') {
    try { await verifyHandoff(); return { state: 'completed' } }
    catch { return { state: 'blocked', message: 'Completed Turn handoff evidence is missing or changed.' } }
  }
  const queued = await store.persistence.generation.queue.record(chat.firstTurnId)
  if (queued) {
    try {
      const job = await verifyHandoff()
      const request = pinnedRequest(await selectedJob(store, actor.id, chat.firstTurnId), job)
      if (queued.ownerId !== actor.id || !request) throw Error('Original queue identity changed.')
      await requireGenerationTurn(job, request, true)
    } catch { return { state: 'blocked', message: 'The original queued handoff cannot be authenticated.' } }
    if (queued.phase === 'interrupted')
      return { state: 'blocked', message: 'The original writer was interrupted. Inspect its saved execution before recovery.' }
    if (first.phase !== 'running') {
      try { await store.persistence.naturalStory.finishFirstTurn(
        actor.id, chat.storyId, chat.firstTurnId, true) } catch {
        return { state: 'blocked', message: 'The queued execution needs first-Turn reconciliation.' }
      }
    }
    return { state: 'queued' }
  }
  if (first.phase === 'preparing')
    return { state: 'pending', message: 'Admission is already reserved at ' +
      ((await effects.read())?.stage ?? 'first-Turn reservation') + '. Inspect its original effect; an uncertain writer is never replayed.' }
  if (!foundationOnly && isExistingStoryModificationRequest(chat.originalObjective))
    return { state: 'blocked', message:
      'A request to revise existing canon needs a native-verified focused Turn, not an approved whole-Story Foundation continuation.' }
  // A foundation-only Turn uses the already reviewed proposal: no second Pi
  // model or generation controller is necessary. Full Stories require both.
  if (!foundationOnly) {
    try {
      await assertUserPiSelection(store, actor.id, approval.model)
      verifyWebExecution(false)
    } catch {
      return { state: 'blocked', message: 'Connect your model and configure the rootless generation controller in Settings, then continue this approved Turn.' }
    }
  }
  const plan = interpretNaturalStoryPrompt(chat.originalObjective)
  if (!foundationOnly && plan.reviewRequired)
    return { state: 'blocked', message: plan.clarification ??
      'Review the original Story scope before authorizing full-Story generation.' }
  const claim = await store.persistence.naturalStory.beginFirstTurn(actor.id,
    chat.storyId, chat.firstTurnId, chat.originalObjective, new Date().toISOString())
  if (claim.state === 'admitted') return { state: 'queued' }
  if (claim.state === 'pending')
    return { state: 'pending', message: 'Another admission request owns this first Turn.' }
  try {
    const prior = await effects.read()
    await effects.advance('prepared')
    const identity = await store.persistence.generation.jobs.identity(chat.firstTurnId)
    if (identity && (identity.ownerId !== actor.id || identity.storyId !== chat.storyId ||
        identity.commitSha !== chat.sourceSha))
      throw Error('The original job registration differs from the approved source.')
    // A lost response after registration must use the original worktree, not
    // rerun provider initialization. Before registration, a started worktree
    // effect without a receipt is ambiguous and may not be recreated.
    if (!identity && prior && !['prepared', 'provider-started', 'provider-verified'].includes(prior.stage))
      throw Error('Original worktree acquisition is unresolved.')
    let providerHead: string | undefined
    if (!identity || !prior) {
      await effects.advance('provider-started')
      const prepared = await responseData(await (story.provider === 'github'
        ? (gateways.github ?? githubJobRequest)(auth, store, internalRequest(baseURL, headers,
          '/api/github/jobs', 'POST', { storyId: chat.storyId, jobId: chat.firstTurnId,
            commit: chat.sourceSha }), baseURL, effects.advance)
        : (gateways.gitlab ?? gitlabJobRequest)(auth, store, internalRequest(baseURL, headers,
          '/api/gitlab/jobs', 'POST', { storyId: chat.storyId, jobId: chat.firstTurnId,
            commit: chat.sourceSha }), baseURL, effects.advance)))
      providerHead = (prepared.job as { headSha?: string } | undefined)?.headSha
      if (!providerHead) throw Error('Missing original provider acquisition result.')
    }
    const job = await authorizedStoryJob(store, actor.id, chat.firstTurnId)
    const earlierApproval = await readChatApprovedFoundation(job)
    const inheritedInitialization = await isVerifiedInitializedDraft(job)
    if (providerHead && providerHead !== job.headSha ||
        (!earlierApproval && job.headSha !== chat.sourceSha && !inheritedInitialization) ||
        await trustedHead(job) !== job.headSha)
      throw Error('The provider acquired a different or untrusted Story revision.')
    await effects.advance('worktree-settled')
    await pinDiscoveryHandoff(job, receipt)
    await effects.advance('foundation-started')
    const explorer = await validatedExplorer(auth, store,
      new Request(baseURL + '/api/story-explorer', { headers }), chat.firstTurnId)
    const existingFoundation = await verifiedReusableStoryFoundation(job, explorer.result)
    if (earlierApproval || !existingFoundation) {
      if (!approval.digest || !approval.skillId)
        throw new Error('The exact Chat foundation approval is missing.')
      await pinChatApprovedFoundation(job, {
        jobId: chat.firstTurnId, sourceSha: chat.sourceSha, firstTurnId: chat.firstTurnId,
        scope: foundationOnly ? 'foundation-only' : 'whole-story',
        originalObjective: chat.originalObjective, proposalDigest: approval.digest,
        skillId: approval.skillId, foundation: approval.foundation,
        creativeMode: parseCreativePolicy(first.creativePolicyJson).mode,
        provider: approval.model.provider, model: approval.model.id,
      })
    } else if (foundationOnly) {
      await pinReusedFoundation(job, chat.originalObjective)
    }
    if (earlierApproval || !existingFoundation) {
      const completed = await runFoundationJob({
        story: job.storyRoot, job: job.jobId, task: chat.originalObjective,
        envelope: JSON.stringify(plan.contract.envelope),
        ...(process.env.NT_STUDIO_SKILLS_SOURCE ? { skillsSource: process.env.NT_STUDIO_SKILLS_SOURCE } : {}),
        provider: approval.model.provider, model: approval.model.id,
      })
      if (completed.status !== 'committed')
        throw new Error('The approved foundation did not reach a verified commit.')
    }
    await effects.advance('foundation-settled')
    if (foundationOnly) {
      await store.persistence.naturalStory.associateRoot(actor.id, chat.storyId,
        chat.firstTurnId, chat.originalObjective.slice(0, 120), new Date().toISOString())
      await store.persistence.naturalStory.finishFoundationOnly(
        actor.id, chat.storyId, chat.firstTurnId)
      return { state: 'completed' }
    }
    await effects.advance('queue-started')
    const admitted = await admitWholeApprovedStory(auth, store, actor.id, headers,
      baseURL, approval, first.creativePolicyJson)
    await effects.advance('queue-settled')
    return admitted
  } catch {
    const finished = await store.persistence.messages.owned(actor.id,
      'root:' + chat.firstTurnId, chat.firstTurnId)
    if (finished?.phase === 'finished') return { state: 'completed' }
    // The durable queue might already have won before a response was lost.
    // Never convert admitted work back into a blocked re-runnable message.
    if (await store.persistence.generation.queue.record(chat.firstTurnId)) {
      try {
        const job = await verifyHandoff()
        const request = pinnedRequest(await selectedJob(store, actor.id, chat.firstTurnId), job)
        if (!request) throw Error('Missing queued handoff request.')
        await requireGenerationTurn(job, request, true)
        await effects.advance('queue-settled')
        await store.persistence.naturalStory.finishFirstTurn(
          actor.id, chat.storyId, chat.firstTurnId, true)
        return { state: 'queued' }
      } catch { /* Show the original reservation for explicit reconciliation. */ }
    } else {
      try {
        await store.persistence.naturalStory.finishFirstTurn(
          actor.id, chat.storyId, chat.firstTurnId, false)
      } catch { /* Preserve the actual durable status. */ }
    }
    return { state: 'blocked', message:
      'Generation setup stopped at ' + ((await effects.read().catch(() => null))?.stage ?? 'handoff verification') +
      '. Inspect the original effect and saved job; the approved Turn is preserved.' }
  }
}
