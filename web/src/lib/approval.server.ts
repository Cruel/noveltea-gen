import { createHash } from 'node:crypto'
import { isAbsolute, join, relative } from 'node:path'
import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { requireUser } from './access.server'
import { startStoryJob } from '../../../src/job'
import { inspectTrustedApproval, requestTrustedApproval, recordTrustedControllerDecision } from '../../../src/trusted-approval'

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })

/** Authenticated human controller, NOT an Agent Protocol tool. Job ownership
 * comes from the app store, never repository membership or browser paths. No
 * Git/provider token is required for consent; remote operations check their own capabilities. */
export async function approvalRequest(auth: StudioAuth, store: StudioDatabase, request: Request, baseURL: string): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (request.headers.get('origin') !== baseURL) return json({ error: 'Cross-origin write refused' }, 403)
  const user = await requireUser(auth, request.headers)
  if (!user) return json({ error: 'Unauthorized' }, 401)
  const input = await request.json().catch(() => null)
  const common = ['action', 'jobId', 'id']
  const fields = input?.action === 'request' ? [...common, 'kind', 'workItemId', 'changeId', 'payload'] :
    input?.action === 'decide' ? [...common, 'nonce', 'proposalSha256', 'decision'] : common
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !['request', 'inspect', 'decide'].includes(input.action) ||
      Object.keys(input).some(key => !fields.includes(key)) ||
      typeof input.jobId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.jobId) ||
      typeof input.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(input.id) ||
      (input.action === 'decide' && (typeof input.nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(input.nonce) ||
        typeof input.proposalSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.proposalSha256) ||
        !['approved', 'rejected'].includes(input.decision)))) {
    return json({ error: 'Invalid typed approval command; principal, paths and inline consent are not accepted.' }, 400)
  }
  const row = store.sqlite.prepare(`SELECT s.directory, r.provider, r.provider_repository_id AS providerId,
    j.source_commit_sha AS baseSha FROM studio_sessions j
    JOIN stories s ON s.id=j.story_id AND s.owner_user_id=j.owner_user_id
    JOIN repositories r ON r.id=s.repository_id AND r.owner_user_id=j.owner_user_id
    WHERE j.id=? AND j.owner_user_id=?`).get(input.jobId, user.id) as
      { directory: string; provider: string; providerId: string; baseSha: string } | undefined
  if (!row) return json({ error: 'Job not found.' }, 404)
  const cache = process.env.NT_GIT_CACHE_DIR
  if (!cache || !isAbsolute(cache)) return json({ error: 'Trusted Git cache is not configured.' }, 503)
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const base = join(cache, hash(user.id), hash(row.provider + ':' + row.providerId), 'base')
  const story = join(base, row.directory), rel = relative(base, story)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) return json({ error: 'Invalid saved Story identity.' }, 409)
  try {
    // Reopen only. Missing cache/manifest must not create a new job or run a writer.
    const job = await startStoryJob({ story, job: input.jobId }, false)
    if (job.baseSha !== row.baseSha || job.storyRoot !== story) throw new Error('Saved job baseline or Story identity differs.')
    const receipt = input.action === 'request' ? await requestTrustedApproval(job, {
      id: input.id, kind: input.kind ?? input.payload?.kind,
      workItemId: input.workItemId ?? input.payload?.workItemId,
      changeId: input.changeId ?? input.payload?.changeId, payload: input.payload,
    }) : input.action === 'inspect' ? await inspectTrustedApproval(job, input.id) :
      await recordTrustedControllerDecision(job, input, input.decision, { source: 'trusted-web', principal: 'user:' + user.id })
    return json(receipt)
  } catch {
    return json({ error: 'Approval is stale, conflicting, or unavailable. Inspect the exact saved proposal and preserved job state.' }, 409)
  }
}
