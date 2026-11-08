import type { ThreadMessage } from '../lib/thread-chat.server'

export type ChatRun = { jobId: string; status: string; queuePhase: string | null; runOrder: number }
export type ChatEvidence = {
  jobId: string; kind: string; stage: string | null; milestone: string | null
  filesJson: string; status: string | null; createdAt: string
}
export type ChatReadModel = {
  messages: ThreadMessage[]
  turns: Array<{ id: string; executionIds: string[] }>
  runs: Array<ChatRun & { requestJson: string | null }>
  evidence: ChatEvidence[]
}
export class ThreadMessageConflict extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
export interface ThreadMessagePersistence {
  owned(owner: string, threadId: string, id: string): Promise<ThreadMessage | null>
  markAdmitted(owner: string, jobId: string): Promise<void>
  membership(owner: string, threadId: string): Promise<{ storyId: string; archivedAt: string | null }>
  read(owner: string, threadId: string): Promise<ChatReadModel>
  enqueue(owner: string, threadId: string, id: string, body: string,
    mode: 'steer' | 'follow-up' | undefined, at: string): Promise<ThreadMessage>
  edit(owner: string, threadId: string, id: string, requestId: string,
    expected: string, replacement: string, at: string): Promise<ThreadMessage>
  cancel(owner: string, threadId: string, id: string, at: string): Promise<ThreadMessage>
}
