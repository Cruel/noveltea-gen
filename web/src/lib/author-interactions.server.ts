import { createHash } from 'node:crypto'
import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './access.server'
import { authorizedStoryJob } from './fixture-jobs.server'
import { inspectAuthorUpdates, resumeAuthorUpdate } from '../../../src/author-updates'
import { inspectTrustedApproval, requestTrustedApproval, recordTrustedControllerDecision } from '../../../src/trusted-approval'
import type { JobStartResult } from '../../../src/job'

const json = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'private, no-store' },
})
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SHA = /^[a-f0-9]{64}$/
const NONCE = /^[0-9a-f-]{36}$/
const approvalId = (jobId: string, messageId: string) =>
  'author-' + createHash('sha256').update(jobId + ':' + messageId).digest('hex').slice(0, 40)

class CommandError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
/** Enforce body budget while reading; do not buffer unbounded browser input. */
async function readCommand(request: Request): Promise<string> {
  const reader = request.body?.getReader()
  if (!reader) throw new CommandError(400, 'Missing author command')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = '', bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 8192) throw new CommandError(413, 'Author command is too large')
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  return text
}

type AuthorRecord = Awaited<ReturnType<typeof inspectAuthorUpdates>>['records'][number]
function pendingApproval(record: AuthorRecord) {
  if (record.message.kind !== 'approval' ||
      !['awaiting-author', 'applied'].includes(record.acknowledgement.phase)) {
    throw new Error('This message does not have a pending approval interrupt.')
  }
  const payload = record.message.payload as {
    requestType?: unknown; proposalSha256?: unknown; workItemId?: unknown; changeId?: unknown
  }
  if (!['plan', 'decision'].includes(String(payload.requestType)) ||
      typeof payload.proposalSha256 !== 'string' || !SHA.test(payload.proposalSha256)) {
    throw new Error('Saved approval request is invalid.')
  }
  return payload as { requestType: 'plan' | 'decision'; proposalSha256: string;
    workItemId?: string; changeId?: string }
}
async function getRecords(job: JobStartResult) {
  const updates = await inspectAuthorUpdates(job)
  return Promise.all(updates.records.map(async ({ message, acknowledgement }) => {
    if (message.kind !== 'question' && message.kind !== 'approval') return null
    const payload = message.payload as Record<string, unknown>
    let approval: Awaited<ReturnType<typeof inspectTrustedApproval>> | null = null
    if (message.kind === 'approval') {
      try { approval = await inspectTrustedApproval(job, approvalId(job.jobId, message.id)) }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    return {
      id: message.id, kind: message.kind, phase: acknowledgement.phase,
      prompt: message.kind === 'question' ? payload.question : 'Review the exact protected proposal',
      ...(message.kind === 'approval' ? {
        requestType: payload.requestType, proposalSha256: payload.proposalSha256,
        workItemId: payload.workItemId ?? null, changeId: payload.changeId ?? null,
      } : {}),
      ...(acknowledgement.phase === 'applied' && message.kind === 'question'
        ? { answer: (acknowledgement.result as { answer?: string } | undefined)?.answer ?? null } : {}),
      approval,
    }
  })).then(items => ({ status: updates.status, items: items.filter(item => item !== null) }))
}

/** Authenticated owner-only interaction with persisted author-update interrupts.
 * The browser never supplies paths, principal, review content or Pi commands. */
export async function authorInteractionRequest(auth: StudioAuth, store: StudioDatabase,
  request: Request, jobId: string, baseURL: string): Promise<Response> {
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405)
  if (request.method === 'POST' && request.headers.get('origin') !== baseURL)
    return json({ error: 'Cross-origin write refused' }, 403)
  try {
    assertStudioSchemaCurrent(store)
    const user = await requireUser(auth, request.headers)
    if (!user) return json({ error: 'Sign in required' }, 401)
    const job = await authorizedStoryJob(store, user.id, jobId)
    if (request.method === 'GET') return json(await getRecords(job))

    // Strict, bounded typed commands. Do not accept a caller-provided identity
    // or approval payload, and do not consume arbitrary controller references.
    const size = Number(request.headers.get('content-length') ?? 0)
    if (size > 8192) return json({ error: 'Author command is too large' }, 413)
    const raw = await readCommand(request)
    let input: Record<string, unknown>
    try { input = JSON.parse(raw) } catch { return json({ error: 'Invalid JSON' }, 400) }
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        !['answer', 'prepare', 'decide'].includes(String(input.action)) ||
        typeof input.messageId !== 'string' || input.messageId.length > 64 || !ID.test(input.messageId)) {
      return json({ error: 'Invalid typed author command' }, 400)
    }
    const permitted = input.action === 'answer' ? ['action', 'messageId', 'answer'] :
      input.action === 'prepare' ? ['action', 'messageId'] :
        ['action', 'messageId', 'receiptId', 'nonce', 'proposalSha256', 'decision']
    if (Object.keys(input).some(key => !permitted.includes(key)) ||
        (input.action === 'answer' && (typeof input.answer !== 'string' || !input.answer.trim() ||
          input.answer.length > 4000)) ||
        (input.action === 'decide' && (typeof input.receiptId !== 'string' ||
          typeof input.nonce !== 'string' || !NONCE.test(input.nonce) ||
          typeof input.proposalSha256 !== 'string' || !SHA.test(input.proposalSha256) ||
          !['approved', 'rejected'].includes(String(input.decision))))) {
      return json({ error: 'Invalid typed author command' }, 400)
    }

    const updates = await inspectAuthorUpdates(job)
    const record = updates.records.find(r => r.message.id === input.messageId)
    if (!record) return json({ error: 'Author message not found' }, 404)
    const principal = 'user:' + user.id
    if (input.action === 'answer') {
      if (record.message.kind !== 'question') return json({ error: 'Not a question' }, 409)
      const receipt = await resumeAuthorUpdate(job,
        { type: 'answer', messageId: input.messageId, answer: input.answer }, principal)
      return json({ acknowledgement: receipt })
    }

    const payload = pendingApproval(record)
    const id = approvalId(job.jobId, record.message.id)
    if (input.action === 'prepare') {
      const approval = await requestTrustedApproval(job, {
        id, kind: payload.requestType, workItemId: payload.workItemId, changeId: payload.changeId,
      })
      if (approval.proposalSha256 !== payload.proposalSha256) throw new Error('Proposal digest changed')
      return json({ approval })
    }
    if (input.receiptId !== id || input.proposalSha256 !== payload.proposalSha256)
      return json({ error: 'Approval does not match the saved author interrupt' }, 409)
    const approval = await recordTrustedControllerDecision(job,
      { id, nonce: input.nonce as string, proposalSha256: input.proposalSha256 as string },
      input.decision as 'approved' | 'rejected', { source: 'trusted-web', principal })
    if (approval.phase !== 'recorded') throw new Error('Controller decision was not persisted')
    if (approval.decision === 'rejected') {
      // A rejection cannot authorize the protected revision; preserve its
      // unresolved author interrupt for explicit replanning/operator review.
      return json({ approval, acknowledgement: record.acknowledgement })
    }
    const acknowledgement = await resumeAuthorUpdate(job,
      { type: 'decision', messageId: record.message.id,
        approval: { receiptId: approval.id, nonce: approval.nonce } }, principal)
    return json({ approval, acknowledgement })
  } catch (error) {
    const status = error instanceof Error && 'status' in error &&
      typeof error.status === 'number' ? error.status : 409
    return json({ error: error instanceof CommandError ? error.message : status === 404 ? 'Job not found' :
      'Author response is stale, conflicting, or unavailable. Inspect its saved proposal and job checkpoint.' }, status)
  }
}
