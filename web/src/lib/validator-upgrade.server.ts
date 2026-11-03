import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './access.server'
import { authorizedStoryJob } from './fixture-jobs.server'
import { queueRecord } from './generation-queue.server'
import { withStoryJobLock } from '../../../src/job-lock'
import { inspectValidatorUpgrade, approveValidatorUpgrade } from '../../../src/validator-upgrade'

const reply = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } })

/** Read-only proposal and authenticated approval of the selected deployment's
 * replacement native validator. Never accepts an executable path from HTTP. */
export async function validatorUpgradeRequest(auth: StudioAuth, store: StudioDatabase,
  request: Request, id: string, baseURL: string): Promise<Response> {
  if (!['GET', 'POST'].includes(request.method)) return reply({ error: 'Method not allowed' }, 405)
  if (request.method === 'POST' && request.headers.get('origin') !== baseURL)
    return reply({ error: 'Cross-origin write refused' }, 403)
  try {
    assertStudioSchemaCurrent(store)
    const user = await requireUser(auth, request.headers)
    if (!user) return reply({ error: 'Sign in required' }, 401)
    const job = await authorizedStoryJob(store, user.id, id)
    const row = store.sqlite.prepare(`SELECT status, generation_request_json AS request
      FROM studio_sessions WHERE id=? AND owner_user_id=?`).get(id, user.id) as
      { status: string; request: string | null } | undefined
    if (!row?.request || row.status !== 'paused' || queueRecord(store, id)?.phase !== 'finished')
      return reply({ error: 'Validator replacement requires a paused, settled generation.' }, 409)
    if (request.method === 'GET') {
      const review = await inspectValidatorUpgrade(job)
      return reply(review)
    }
    const reader = request.body?.getReader()
    if (!reader) return reply({ error: 'Missing validator review request' }, 400)
    let total = 0
    const chunks: Uint8Array[] = []
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > 1500) return reply({ error: 'Validator review request too large' }, 413)
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    let input: Record<string, unknown>
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { return reply({ error: 'Invalid validator review JSON' }, 400) }
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'action,proposalSha256,rationale' ||
      input.action !== 'approve' ||
      typeof input.proposalSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.proposalSha256) ||
      typeof input.rationale !== 'string' || input.rationale.trim().length < 12 ||
      input.rationale.length > 1000) return reply({ error: 'Exact proposal and author rationale required' }, 400)
    const receipt = await withStoryJobLock(job, 'native-validator-upgrade', () =>
      approveValidatorUpgrade(job, input.proposalSha256 as string,
        input.rationale as string, 'user:' + user.id))
    return reply({ phase: receipt.phase, proposal: receipt })
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Validator review failed'
    return reply({ error: reason }, 409)
  }
}
