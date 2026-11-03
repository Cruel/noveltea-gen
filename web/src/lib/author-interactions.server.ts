import { createHash } from 'node:crypto'
import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './access.server'
import { authorizedStoryJob } from './fixture-jobs.server'
import { inspectAuthorUpdates } from '../../../src/author-updates'
import { inspectTrustedApproval } from '../../../src/trusted-approval'
import { inspectFoundationConflict } from '../../../src/foundation-conflict'
import { inspectAuthorDecisions, decideAuthorDecision, isRecoveryDecisionKind, statusAfterAuthorDecision } from '../../../src/author-decisions'
import { withStoryJobLock } from '../../../src/job-lock'
import { queueRecord } from './generation-queue.server'
import { activeSpecialistChoice, answerSpecialistChoice } from '../../../src/specialist-choice'
import type { JobStartResult } from '../../../src/job'
import { postAgentAuthorCommand } from './agent-rpc.server'
import { validAuthorCommand } from './agent-author-validation'

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

async function getRecords(job: JobStartResult, recoverable: boolean) {
  const updates = await inspectAuthorUpdates(job)
  const decisions = recoverable ? await inspectAuthorDecisions(job) : []
  const choice = recoverable ? await activeSpecialistChoice(job) : null
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
  })).then(items => ({ status: updates.status, items: items.filter(item => item !== null), decisions,
    choice: choice ? { id: choice.id, workItem: choice.workItem, phase: choice.phase,
      proposalSha256: choice.proposalSha256, question: choice.question,
      ...(choice.answer ? { answer: choice.answer } : {}) } : null }))
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
    const row = store.sqlite.prepare(`SELECT status, generation_request_json AS request
      FROM studio_sessions WHERE id=? AND owner_user_id=?`).get(jobId, user.id) as
      { status: string; request: string | null } | undefined
    const queue = queueRecord(store, jobId)
    const recoverable = !!row?.request && ['paused', 'blocked'].includes(row.status) &&
      queue?.phase === 'finished'
    if (request.method === 'GET') return json(await getRecords(job, recoverable))

    // Strict, bounded typed commands. Do not accept a caller-provided identity
    // or approval payload, and do not consume arbitrary controller references.
    const size = Number(request.headers.get('content-length') ?? 0)
    if (size > 8192) return json({ error: 'Author command is too large' }, 413)
    const raw = await readCommand(request)
    let input: Record<string, unknown>
    try { input = JSON.parse(raw) } catch { return json({ error: 'Invalid JSON' }, 400) }
    if (input?.action === 'choice') {
      const keys = Object.keys(input).sort().join(',')
      if (!recoverable || row?.status !== 'paused' ||
          !['action,id,kind,optionId,proposalSha256', 'action,id,kind,optionId,proposalSha256,note',
            'action,id,kind,proposalSha256,text', 'action,id,kind,note,proposalSha256,text']
            .includes(keys) ||
          typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id) ||
          typeof input.proposalSha256 !== 'string' || !SHA.test(input.proposalSha256) ||
          !['option', 'custom'].includes(String(input.kind)) ||
          (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 1000)) ||
          (input.kind === 'option' && (typeof input.optionId !== 'string' ||
            input.optionId.length > 40 || 'text' in input)) ||
          (input.kind === 'custom' && (typeof input.text !== 'string' ||
            !input.text.trim() || input.text.length > 4000 || 'optionId' in input)))
        return json({ error: 'Expected one exact pending author choice and an optional note.' }, 409)
      const completed = await withStoryJobLock(job, 'specialist-author-choice', async () => {
        const active = await activeSpecialistChoice(job)
        if (!active || active.id !== input.id || active.phase !== 'awaiting-author')
          throw new Error('Author choice has changed or was already answered.')
        const answer = input.kind === 'option'
          ? { kind: 'option' as const, optionId: input.optionId as string, note: input.note as string ?? '' }
          : { kind: 'custom' as const, text: input.text as string, note: input.note as string ?? '' }
        return answerSpecialistChoice(job, active.id, input.proposalSha256 as string,
          answer, 'user:' + user.id)
      })
      return json({ choice: { id: completed.id, phase: completed.phase,
        proposalSha256: completed.proposalSha256 } })
    }
    if (input?.action === 'decision') {
      const fields = Object.keys(input).sort().join(',')
      if (!recoverable ||
          !['action,decision,id,proposalSha256', 'action,decision,id,note,proposalSha256'].includes(fields) ||
          !isRecoveryDecisionKind(input.id) ||
          !SHA.test(String(input.proposalSha256)) ||
          !['approved', 'rejected'].includes(String(input.decision)) ||
          (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 1000)))
        return json({ error: 'Expected a settled job and one exact, typed author decision.' }, 409)
      const conflict = await inspectFoundationConflict(job)
      if (!conflict || conflict.requestSha256 !== createHash('sha256').update(row!.request!).digest('hex'))
        return json({ error: 'Pinned request differs from the saved author-decision evidence.' }, 409)
      const decided = await withStoryJobLock(job, 'author-decision', () =>
        decideAuthorDecision(job, {
          id: input.id as 'foundation-conflict' | 'validator-upgrade',
          proposalSha256: input.proposalSha256 as string,
          decision: input.decision as 'approved' | 'rejected',
          principal: 'user:' + user.id,
          ...(input.note !== undefined ? { note: input.note as string } : {}),
        }))
      const nextStatus = statusAfterAuthorDecision(
        input.id as 'foundation-conflict' | 'validator-upgrade',
        input.decision as 'approved' | 'rejected')
      if (nextStatus) {
        store.sqlite.prepare(`UPDATE studio_sessions SET status=?, updated_at=?
          WHERE id=? AND owner_user_id=? AND status IN ('blocked','paused')`)
          .run(nextStatus, new Date().toISOString(), jobId, user.id)
      }
      return json({ decision: decided })
    }
    if (input?.action === 'send') {
      if (!validAuthorCommand(input)) return json({ error: 'Invalid typed author message' }, 400)
      return postAgentAuthorCommand(user.id, jobId, input)
    }
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

    // Do not reopen an author-update graph in the web service. Only the
    // dedicated agent may process the approved typed command.
    return postAgentAuthorCommand(user.id, jobId, input)
  } catch (error) {
    const status = error instanceof Error && 'status' in error &&
      typeof error.status === 'number' ? error.status : 409
    return json({ error: error instanceof CommandError ? error.message : status === 404 ? 'Job not found' :
      'Author response is stale, conflicting, or unavailable. Inspect its saved proposal and job checkpoint.' }, status)
  }
}
