import { createHash } from 'node:crypto'
import type { StudioAuth } from './auth'
import type { StudioStore as StudioDatabase } from '../persistence/store'
import { requireUser } from './access.server'
import { authorizedStoryJob } from './fixture-jobs.server'
import { inspectAuthorUpdates } from '../../../src/author-updates'
import { inspectTrustedApproval } from '../../../src/trusted-approval'
import { inspectFoundationConflict } from '../../../src/foundation-conflict'
import { inspectAuthorDecisions, decideAuthorDecision, isRecoveryDecisionKind, statusAfterAuthorDecision } from '../../../src/author-decisions'
import { withStoryJobLock } from '../../../src/job-lock'
import { queueRecord } from './generation-queue.server'
import { activeSpecialistChoice, answerSpecialistChoice } from '../../../src/specialist-choice'
import { parseAuthorAnswer } from '../../../src/author-question'
import { readSpecialistQuestionDraft, saveSpecialistQuestionDraft } from './specialist-question-drafts.server'
import { enqueueAnsweredSpecialistContinuation } from './generation-controls.server'
import type { JobStartResult } from '../../../src/job'
import { postAgentAuthorCommand } from './agent-rpc.server'
import { validAuthorCommand } from './agent-author-validation'

const json = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'private, no-store' },
})
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SHA = /^[a-f0-9]{64}$/
const NONCE = /^[0-9a-f-]{36}$/
const MAX_AUTHOR_COMMAND_BYTES = 8192
const MAX_QUESTION_COMMAND_BYTES = 20_000
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
      if (bytes > MAX_QUESTION_COMMAND_BYTES) throw new CommandError(413, 'Author command is too large')
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  return text
}

async function getRecords(job: JobStartResult, recoverable: boolean, owner: string) {
  const updates = await inspectAuthorUpdates(job)
  const decisions = recoverable ? await inspectAuthorDecisions(job) : []
  const choice = recoverable ? await activeSpecialistChoice(job) : null
  const items = await Promise.all(updates.records.map(async ({ message, acknowledgement }) => {
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
  }))
  const draft = choice?.phase === 'awaiting-author'
    ? await readSpecialistQuestionDraft(job, choice, owner) : null
  return { status: updates.status, items: items.filter(item => item !== null), decisions,
    choice: choice ? { id: choice.id, workItem: choice.workItem, phase: choice.phase,
      proposalSha256: choice.proposalSha256, delegationAllowed: choice.delegationAllowed === true,
      question: choice.question,
      ...(draft ? { draft } : {}),
      ...(choice.answer ? { answer: choice.answer } : {}) } : null }
}

/** Authenticated owner-only interaction with persisted author-update interrupts.
 * The browser never supplies paths, principal, review content or Pi commands. */
export async function authorInteractionRequest(auth: StudioAuth, store: StudioDatabase,
  request: Request, jobId: string, baseURL: string): Promise<Response> {
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405)
  if (request.method === 'POST' && request.headers.get('origin') !== baseURL)
    return json({ error: 'Cross-origin write refused' }, 403)
  try {
    await store.assertReady()
    const user = await requireUser(auth, request.headers)
    if (!user) return json({ error: 'Sign in required' }, 401)
    const job = await authorizedStoryJob(store, user.id, jobId)
    const saved = await store.persistence.generation.jobs.state(user.id, jobId)
    const row = saved ? { status: saved.status, request: saved.requestJson } : undefined
    const queue = (await queueRecord(store, jobId))
    const recoverable = !!row?.request && ['paused', 'blocked'].includes(row.status) &&
      queue?.phase === 'finished'
    if (request.method === 'GET') return json(await getRecords(job, recoverable, user.id))

    // Strict, bounded typed commands. Do not accept a caller-provided identity
    // or approval payload, and do not consume arbitrary controller references.
    const size = Number(request.headers.get('content-length') ?? 0)
    if (size > MAX_QUESTION_COMMAND_BYTES) return json({ error: 'Author command is too large' }, 413)
    const raw = await readCommand(request)
    let input: Record<string, unknown>
    try { input = JSON.parse(raw) } catch {
      return Buffer.byteLength(raw, 'utf8') > MAX_AUTHOR_COMMAND_BYTES
        ? json({ error: 'Author command is too large' }, 413)
        : json({ error: 'Invalid JSON' }, 400)
    }
    // Both a specialist draft and its final typed answer must fit the same
    // validated 4,000-character Unicode payload. Keep the smaller bound for
    // unrelated control/approval commands.
    if (input?.action !== 'choice-draft' && input?.action !== 'choice' &&
        Buffer.byteLength(raw, 'utf8') > MAX_AUTHOR_COMMAND_BYTES)
      return json({ error: 'Author command is too large' }, 413)
    if (input?.action === 'choice-draft') {
      if (!recoverable || row?.status !== 'paused' ||
          typeof input.id !== 'string' || !NONCE.test(input.id) ||
          typeof input.proposalSha256 !== 'string' || !SHA.test(input.proposalSha256) ||
          !Number.isSafeInteger(input.draftRevision) || (input.draftRevision as number) < 1 ||
          Object.keys(input).sort().join(',') !==
            'action,draftRevision,drafts,id,proposalSha256')
        return json({ error: 'Expected an exact, revisioned Question Set draft.' }, 409)
      const draft = await withStoryJobLock(job, 'specialist-question-draft', async () => {
        const active = await activeSpecialistChoice(job)
        if (!active || active.id !== input.id || active.phase !== 'awaiting-author' ||
            active.proposalSha256 !== input.proposalSha256)
          throw new Error('Specialist Question Set has changed.')
        return saveSpecialistQuestionDraft(job, active, user.id,
          input.draftRevision as number, input.drafts)
      })
      return json({ draft })
    }
    if (input?.action === 'choice') {
      if (!recoverable || row?.status !== 'paused' ||
          typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id) ||
          typeof input.proposalSha256 !== 'string' || !SHA.test(input.proposalSha256) ||
          !Number.isSafeInteger(input.draftRevision) || (input.draftRevision as number) < 1)
        return json({ error: 'Expected one exact pending author choice.' }, 409)
      const { action: _action, id: _id, proposalSha256: _hash,
        draftRevision: _revision, ...response } = input
      const completed = await withStoryJobLock(job, 'specialist-author-choice', async () => {
        const active = await activeSpecialistChoice(job)
        if (!active || active.id !== input.id || active.phase !== 'awaiting-author')
          throw new Error('Author choice has changed or was already answered.')
        const draft = await readSpecialistQuestionDraft(job, active, user.id)
        if (draft.revision !== input.draftRevision)
          throw new Error('Question Set draft changed in another browser.')
        const answer = parseAuthorAnswer(active.question, {
          ...response, ...(response.note === undefined ? { note: '' } : {}),
        }, active.delegationAllowed === true)
        return answerSpecialistChoice(job, active.id, input.proposalSha256 as string,
          answer, 'user:' + user.id)
      })
      // The answer is already durable. A rejected checkpoint/queue transition
      // cannot undo it or implicitly retry an uncertain specialist model call.
      let continuation: 'queued' | 'manual' = 'manual'
      try {
        await enqueueAnsweredSpecialistContinuation(store, user.id, job, jobId)
        continuation = 'queued'
      } catch { /* Keep the saved answer and the existing explicit Continue/recovery path. */ }
      return json({ choice: { id: completed.id, phase: completed.phase,
        proposalSha256: completed.proposalSha256 }, continuation })
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
        await store.persistence.generation.jobs.authorDecision(
          user.id, jobId, nextStatus, new Date().toISOString())
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
