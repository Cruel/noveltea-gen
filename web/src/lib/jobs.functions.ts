import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { readAuthConfig } from './auth'
import { generationJobRequest } from './fixture-jobs.server'
import { generationControlRequest } from './generation-controls.server'

export type JobOverview = {
  id: string; storyId: string; title: string; provider: string; baseSha: string; headSha: string
  status: string; threadId: string | null; fixture: boolean; task: string | null
  contract: object | null; reason: string | null; completedStages: Array<{ stage: string; status: string }>
  revisionVerified?: boolean
  recovery?: {
    kind: 'manual-specialist' | 'operator-reconciliation'
    stage: string; workItem: string | null; files: string[]
    candidateDigest: string | null; guidance: string
  } | null
}
export type BudgetLimits = { steps?: number; modelCalls?: number; costUsd?: number }
export type JobControls = {
  control: string; queue: string | null
  limits: BudgetLimits
  budget: { steps: number; modelCalls: number; costUsd: number; pause?: { reason: string } }
}
export type JobControlAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'budget'

async function result<T>(response: Response) {
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error || 'Job request failed.')
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

export const getJobControls = createServerFn({ method: 'GET' })
  .validator((jobId: string) => jobId)
  .handler(async ({ data }) =>
    result<JobControls>(await generationControlRequest(auth, database,
      request(data, '/control'), data, readAuthConfig().baseURL)))

export const updateJobControl = createServerFn({ method: 'POST' })
  .validator((data: { jobId: string; action: JobControlAction; limits?: BudgetLimits }) => data)
  .handler(async ({ data }) => result<{ status?: string }>(
    await generationControlRequest(auth, database,
      request(data.jobId, '/control', { action: data.action, ...(data.limits ? { limits: data.limits } : {}) }),
      data.jobId, readAuthConfig().baseURL)))
