/** Durable same-Thread single-writer continuation and terminal reconciliation.
 * All methods are synchronous because the caller runs Git/native validation
 * outside each transaction. The adapter holds the SQLite writer lock. */
export type ContinuationRun = {
  jobId: string; status: string; queuePhase: string | null; runOrder: number
}
export type ContinuationAdmission = {
  id: string; content: string; scopeJson: string | null;
  source: string; runOrder: number
}
export type QueuedContinuation = { id: string; content: string; scope: string | null }
export type ContinuationRequest = {
  owner: string; threadId: string; claim: ContinuationAdmission
  sourceHead: string; generationThread: string
  draftJson: string; requestJson: string; at: string
}
export interface ContinuationSqliteBridge {
  current(owner: string, threadId: string): ContinuationRun | null
  pending(owner: string, threadId: string): QueuedContinuation | null
  claim(owner: string, threadId: string): ContinuationAdmission | null
  protectedFinish(data: ContinuationRequest, committedSha: string): void
  beginFollowUp(data: ContinuationRequest): void
  block(owner: string, threadId: string, claim: ContinuationAdmission, reason: string, at: string): void
  settledRuns(): Array<{ jobId: string; owner: string }>
  runThread(owner: string, jobId: string): string | null
  /** Checked terminalization; never invents a checkpoint or starts a writer. */
  settle(owner: string, jobId: string, verifiedCommit: string | null, at: string): string | null
}

/** Future PostgreSQL implementations provide async transactions; synchronous
 * SQLite callbacks exist only behind the adapter for current worker fences. */
export interface ContinuationPersistence {
  current(owner: string, threadId: string): Promise<ContinuationRun | null>
  pending(owner: string, threadId: string): Promise<QueuedContinuation | null>
  claim(owner: string, threadId: string): Promise<ContinuationAdmission | null>
  protectedFinish(data: ContinuationRequest, committedSha: string): Promise<void>
  beginFollowUp(data: ContinuationRequest): Promise<void>
  block(owner: string, threadId: string, claim: ContinuationAdmission, reason: string, at: string): Promise<void>
  settledRuns(): Promise<Array<{ jobId: string; owner: string }>>
  runThread(owner: string, jobId: string): Promise<string | null>
  settle(owner: string, jobId: string, verifiedCommit: string | null, at: string): Promise<string | null>
}
