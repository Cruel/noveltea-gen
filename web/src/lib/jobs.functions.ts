import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { readAuthConfig } from './auth'
import { generationJobRequest } from './fixture-jobs.server'
import { generationControlRequest } from './generation-controls.server'
import { checkpointForkRequest, checkpointContinueRequest } from './checkpoint-fork.server'

export type JobOverview = {
  id: string; storyId: string; title: string; provider: string; baseSha: string; headSha: string
  status: string; threadId: string | null; storyThreadId: string | null; fixture: boolean; task: string | null
  threadMessages: Array<{ role: 'user' | 'assistant'; status: 'delivered' | 'queued'; body: string;
    originMessageId: string | null; verifiedCommitSha: string | null; createdAt: string }>
  contract: object | null; reason: string | null; completedStages: Array<{ stage: string; status: string }>
  revisionVerified?: boolean
  savedPiSessions?: Array<{ group: string; sessionId: string; model: string;
    transcriptRetained: boolean }>
  restartSource: { sourceThreadId: string; sourceJobId: string; originalJobId: string;
    originalSha: string; selectedSha: string; mode: 'original' | 'newer'; targetBranch: string | null } | null
  forkSource: { jobId: string; commitSha: string; completedWorkItems: string[];
    remainingWorkItems: string[]; nextWorkItem: string | null; dependencies: Record<string, string[]> } | null
  recoveryCheckpoints: Array<{
    commitSha: string; parentSha: string; workItem: string; stage: string; eligible: boolean; reason: string | null
    planVersion: number | null; planDigest: string | null; proofDigest: string; source: string; snapshotId: string | null
    completedWorkItems: string[]; remainingWorkItems: string[]
    nextWorkItem: string | null; dependencies: Record<string, string[]>
    validation: { status: string; validatorVersion: string }
    semanticReview: 'untracked' | 'not-required' | 'required-pending' | 'passed' | 'failed'
    assurance: { assignmentId: string; changedPaths: string[]; changedRecordTypes: string[];
      reasons: string[]; diffDigest: string; assignmentDigest: string } | null
  }>
  recovery?: {
    kind: 'manual-specialist' | 'operator-reconciliation'
    stage: string; workItem: string | null; files: string[]
    candidateDigest: string | null; guidance: string
  } | null
}
export type BudgetLimits = { steps?: number; modelCalls?: number; costUsd?: number; activeSeconds?: number }
export type JobControls = {
  control: string; queue: string | null
  limits: BudgetLimits
  budget: { steps: number; modelCalls: number; costUsd: number; activeSeconds: number; unpricedCalls: number
    unknownTokenCalls: number; tokens: { input: number; output: number;
      cacheRead: number; cacheWrite: number; total: number }
    pause?: { reason: string } }
  repair: null | {
    attempts: number; limit: number
    findings: Array<{ id: string; type: string; specialist: string; outcome: string;
      paths: string[]; status: string; sourceSha: string; reviewDigest: string;
      attempts: number; allowance: number; message: string;
      requiredCorrection: string | null }>
    recent: Array<{ sourceSha: string; paths: string[]; outcome: string; successorSha: string | null }>
    prerequisites: Array<{ type: string; specialist: string; path: string;
      status: string; attempts: number }>
    continuation?: { sourceSha: string; rootSha: string; reviewedSha: string;
      remainingGrants: number; pendingGuidance?: string }
  }
}
export type JobControlAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'budget' | 'repair'

async function result<T>(response: Response) {
  const body = await response.json() as T
  if (!response.ok) {
    const failure = body as { error?: string; nextSteps?: unknown }
    const nextSteps = Array.isArray(failure.nextSteps)
      ? failure.nextSteps.filter((step): step is string => typeof step === 'string').slice(0, 3)
      : []
    throw new Error([failure.error || 'Job request failed.', ...nextSteps].join('\n'))
  }
  return body
}
function request(jobId: string, suffix: string, payload?: object) {
  const headers = new Headers(getRequestHeaders())
  if (payload) headers.set('content-type', 'application/json')
  const path = '/api/jobs/' + encodeURIComponent(jobId) + suffix
  return new Request(readAuthConfig().baseURL + path, {
    method: payload ? 'POST' : 'GET', headers,
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  })
}

export const getJob = createServerFn({ method: 'GET' })
  .validator((jobId: string) => jobId)
  .handler(async ({ data }) => {
    const body = await result<{ job: JobOverview }>(
      await generationJobRequest(auth, database, request(data, ''), data, readAuthConfig().baseURL))
    return body.job
  })

export const forkJobCheckpoint = createServerFn({ method: 'POST' })
  .validator((data: { jobId: string; childId: string; commitSha: string; sourceBaseSha: string;
    sourceThreadId: string; proofDigest: string; guidance: string }) => data)
  .handler(async ({ data }) => result<{ id: string }>(await checkpointForkRequest(auth, database,
    request(data.jobId, '/fork', { childId: data.childId, commitSha: data.commitSha, sourceBaseSha: data.sourceBaseSha,
      sourceThreadId: data.sourceThreadId, proofDigest: data.proofDigest, guidance: data.guidance }),
    data.jobId, readAuthConfig().baseURL)))

export const continueJobCheckpoint = createServerFn({ method: 'POST' })
  .validator((data: { jobId: string; childId: string; commitSha: string; sourceBaseSha: string;
    sourceThreadId: string; proofDigest: string; guidance: string;
    expectedLatestJobId?: string }) => data)
  .handler(async ({ data }) => result<{ id: string; started: boolean; warning?: string }>(
    await checkpointContinueRequest(auth, database,
      request(data.jobId, '/continue', { childId: data.childId, commitSha: data.commitSha,
        sourceBaseSha: data.sourceBaseSha, sourceThreadId: data.sourceThreadId,
        proofDigest: data.proofDigest, guidance: data.guidance,
        ...(data.expectedLatestJobId ? { expectedLatestJobId: data.expectedLatestJobId } : {}) }),
      data.jobId, readAuthConfig().baseURL)))

export const getJobControls = createServerFn({ method: 'GET' })
  .validator((jobId: string) => jobId)
  .handler(async ({ data }) =>
    result<JobControls>(await generationControlRequest(auth, database,
      request(data, '/control'), data, readAuthConfig().baseURL)))

export const updateJobControl = createServerFn({ method: 'POST' })
  .validator((data: { jobId: string; action: JobControlAction; limits?: BudgetLimits;
    sourceSha?: string; guidance?: string }) => data)
  .handler(async ({ data }) => result<{ status?: string }>(
    await generationControlRequest(auth, database,
      request(data.jobId, '/control', { action: data.action, ...(data.limits ? { limits: data.limits } : {}),
        ...(data.sourceSha ? { sourceSha: data.sourceSha } : {}),
        ...(data.guidance ? { guidance: data.guidance } : {}) }),
      data.jobId, readAuthConfig().baseURL)))
