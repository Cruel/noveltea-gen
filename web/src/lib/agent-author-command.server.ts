import { createHash } from 'node:crypto'
import { validAuthorCommand } from './agent-author-validation'
import type { JobStartResult } from '../../../src/job'
import { inspectAuthorUpdates, resumeAuthorUpdate, sendAuthorUpdate } from '../../../src/author-updates'
import { inspectTrustedApproval, requestTrustedApproval, recordTrustedControllerDecision } from '../../../src/trusted-approval'

const SHA = /^[a-f0-9]{64}$/
const reply = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'private, no-store' },
})


/** The agent alone processes author-update graph interrupts. Only an already
 * authenticated Studio controller can reach this through private RPC. */
export async function executeAuthorCommand(job: JobStartResult, principal: string,
  input: Record<string, unknown>): Promise<Response> {
  if (!validAuthorCommand(input)) return reply({ error: 'Invalid author command' }, 400)
  if (input.action === 'send') {
    const acknowledgement = await sendAuthorUpdate(job, input.message)
    return reply({ acknowledgement }, 202)
  }
  const updates = await inspectAuthorUpdates(job)
  const record = updates.records.find(r => r.message.id === input.messageId)
  if (!record) return reply({ error: 'Author message not found' }, 404)
  if (input.action === 'answer') {
    if (record.message.kind !== 'question') return reply({ error: 'Not a question' }, 409)
    const acknowledgement = await resumeAuthorUpdate(job,
      { type: 'answer', messageId: input.messageId as string, answer: input.answer as string }, principal)
    return reply({ acknowledgement })
  }
  if (record.message.kind !== 'approval' ||
      !['awaiting-author', 'applied'].includes(record.acknowledgement.phase))
    return reply({ error: 'No pending approval interrupt' }, 409)
  const payload = record.message.payload as Record<string, unknown>
  if (!['plan', 'decision'].includes(String(payload.requestType)) ||
      typeof payload.proposalSha256 !== 'string' || !SHA.test(payload.proposalSha256))
    return reply({ error: 'Invalid saved approval' }, 409)
  const id = 'author-' + createHash('sha256')
    .update(job.jobId + ':' + record.message.id).digest('hex').slice(0, 40)
  if (input.action === 'prepare') {
    const approval = await requestTrustedApproval(job, {
      id, kind: payload.requestType as 'plan' | 'decision',
      workItemId: payload.workItemId as string | undefined,
      changeId: payload.changeId as string | undefined,
    })
    if (approval.proposalSha256 !== payload.proposalSha256)
      throw new Error('Proposal digest changed')
    return reply({ approval })
  }
  if (input.receiptId !== id || input.proposalSha256 !== payload.proposalSha256)
    return reply({ error: 'Approval does not match saved interrupt' }, 409)
  const approval = await recordTrustedControllerDecision(job, {
    id, nonce: input.nonce as string, proposalSha256: input.proposalSha256 as string,
  }, input.decision as 'approved' | 'rejected', { source: 'trusted-web', principal })
  if (approval.phase !== 'recorded') throw new Error('Controller decision was not persisted')
  if (approval.decision === 'rejected')
    return reply({ approval, acknowledgement: record.acknowledgement })
  const acknowledgement = await resumeAuthorUpdate(job, {
    type: 'decision', messageId: record.message.id,
    approval: { receiptId: approval.id, nonce: approval.nonce },
  }, principal)
  return reply({ approval, acknowledgement })
}
