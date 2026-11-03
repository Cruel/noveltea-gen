import { createHash } from 'node:crypto'
import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { requireUser } from './access.server'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { authorizedStoryJob } from './fixture-jobs.server'
import { queueRecord } from './generation-queue.server'
import { withStoryJobLock } from '../../../src/job-lock'
import { decideFoundationConflict, inspectFoundationConflict, recordFoundationConflict } from '../../../src/foundation-conflict'

const reply = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } })
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const publicConflict = (value: Awaited<ReturnType<typeof inspectFoundationConflict>>) => value ? ({
  digest: value.digest, explanation: value.explanation, headSha: value.headSha,
  sourceExcerpt: value.sourceExcerpt, status: value.status, retryUsed: !!value.retryUsed,
  ...(value.authorization ? { authorization: { reason: value.authorization.reason } } : {}),
}) : null

/** Controller-only decision on a completed no-write Foundation conflict.
 * No model text is ever accepted as human consent and no Story bytes are edited. */
export async function foundationReviewRequest(auth: StudioAuth, store: StudioDatabase,
  request: Request, id: string, baseURL: string) {
  if (!['GET', 'POST'].includes(request.method)) return reply({ error: 'Method not allowed' }, 405)
  if (request.method === 'POST' && request.headers.get('origin') !== baseURL)
    return reply({ error: 'Cross-origin write refused' }, 403)
  try {
    assertStudioSchemaCurrent(store)
    const user = await requireUser(auth, request.headers)
    if (!user) return reply({ error: 'Sign in required' }, 401)
    const job = await authorizedStoryJob(store, user.id, id)
    const row = store.sqlite.prepare(`SELECT status, generation_request_json AS request
      FROM studio_sessions WHERE id=? AND owner_user_id=?`)
      .get(id, user.id) as { status: string; request: string | null } | undefined
    if (!row?.request) return reply({ error: 'Job has no pinned generation request' }, 409)
    if (request.method === 'GET') {
      const conflict = await inspectFoundationConflict(job)
      if (conflict && conflict.requestSha256 !== sha(row.request))
        return reply({ error: 'Pinned job request differs from the original Foundation authorization.' }, 409)
      return reply({ conflict: publicConflict(conflict) })
    }
    if (!['blocked', 'paused'].includes(row.status) || queueRecord(store, id)?.phase !== 'finished')
      return reply({ error: 'The writer must be settled before author review.' }, 409)
    const reader = request.body?.getReader()
    if (!reader) return reply({ error: 'Missing review request' }, 400)
    let size = 0
    const chunks: Uint8Array[] = []
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 2400) return reply({ error: 'Review request too large' }, 413)
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    let input: Record<string, unknown>
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { return reply({ error: 'Invalid review JSON' }, 400) }
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !['prepare', 'approve', 'reject'].includes(String(input.action)) ||
      Object.keys(input).some(key => !['action', ...(input.action === 'prepare'
        ? [] : ['digest', 'reason'])].includes(key))) return reply({ error: 'Invalid review request' }, 400)
    const conflict = await withStoryJobLock(job, 'foundation-author-review', async () => {
      if (input.action === 'prepare') return recordFoundationConflict(job)
      if (typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/.test(input.digest) ||
          typeof input.reason !== 'string') throw new Error('Expected an exact digest and author rationale.')
      return decideFoundationConflict(job, input.action as 'approve' | 'reject',
        input.digest, input.reason, 'user:' + user.id)
    })
    if (!conflict || conflict.requestSha256 !== sha(row.request))
      return reply({ error: 'No matching, completed Foundation authorization handoff exists.' }, 409)
    if (input.action === 'approve') {
      store.sqlite.prepare(`UPDATE studio_sessions SET status='paused', updated_at=?
        WHERE id=? AND owner_user_id=? AND status IN ('blocked','paused')`)
        .run(new Date().toISOString(), id, user.id)
    }
    if (input.action === 'reject') {
      store.sqlite.prepare(`UPDATE studio_sessions SET status='blocked', updated_at=?
        WHERE id=? AND owner_user_id=? AND status IN ('blocked','paused')`)
        .run(new Date().toISOString(), id, user.id)
    }
    return reply({ conflict: publicConflict(conflict) })
  } catch (error) {
    console.error('[Foundation author review] Rejected unsafe or stale request',
      error instanceof Error ? error.name : 'Unknown')
    return reply({ error: 'Foundation conflict is stale or not safely recoverable. Inspect the saved writer and Git revision.' }, 409)
  }
}
