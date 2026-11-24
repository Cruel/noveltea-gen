import type { ThreadMessage } from '../lib/thread-chat.server'
import type { CreativeMode, CreativePolicy } from '../../../src/creative-policy'

export type ChatRun = { jobId: string; status: string; queuePhase: string | null; runOrder: number }
export type ChatEvidence = {
  jobId: string; kind: string; stage: string | null; milestone: string | null
  filesJson: string; status: string | null; createdAt: string
}
/** Controller receipts, not semantic-review approvals. A null validatedSha
 * means the execution has not produced an eligible final Story checkpoint. */
export type TurnExecutionReceipt = {
  jobId: string; inputSha: string; status: string; queuePhase: string | null
  validatedSha: string | null
}
export type TurnReceipt = {
  id: string; request: string; effectiveRequest: string
  outcome: ThreadMessage['phase']; inputSha: string | null
  creativePolicy: CreativePolicy
  executions: TurnExecutionReceipt[]
}
export type ChatReadModel = {
  messages: ThreadMessage[]
  turns: Array<{ id: string; executionIds: string[] }>
  turnReceipts: TurnReceipt[]
  runs: Array<ChatRun & { requestJson: string | null }>
  evidence: ChatEvidence[]
}
export class ThreadMessageConflict extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
export interface ThreadMessagePersistence {
  owned(owner: string, threadId: string, id: string): Promise<(ThreadMessage & { verifiedCommitSha: string | null }) | null>
  markAdmitted(owner: string, jobId: string): Promise<void>
  membership(owner: string, threadId: string): Promise<{ storyId: string; archivedAt: string | null; creativePolicyJson: string }>
  read(owner: string, threadId: string): Promise<ChatReadModel>
  enqueue(owner: string, threadId: string, id: string, body: string,
    mode: 'steer' | 'follow-up' | undefined, at: string,
    creativeMode?: CreativeMode): Promise<ThreadMessage>
  edit(owner: string, threadId: string, id: string, requestId: string,
    expected: string, replacement: string, at: string): Promise<ThreadMessage>
  cancel(owner: string, threadId: string, id: string, at: string): Promise<ThreadMessage>
}
