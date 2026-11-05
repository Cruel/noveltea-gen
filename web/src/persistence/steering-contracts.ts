/** Owner-scoped, transaction-safe steering and checkpoint attribution.
 * Synchronous port methods are intentional: the Pi SDK lifecycle callbacks
 * require a synchronous writer fence, and never perform network IO in a DB
 * transaction. The SQLite adapter owns all driver and locking details. */
export type PendingPiInput = {
  id: string; owner: string; threadId: string; jobId: string; content: string;
  sequence: number; mode: 'steer' | 'follow-up'
}
export type ClaimedPiInput = PendingPiInput & { delivery: string }
export type SteeringDisposition = 'within-scope' | 'scope-review' | 'protected-review' | 'unresolved'
export type SteeringCheckpoint = {
  eligible: boolean; commitSha: string; parentSha: string; proofDigest: string; workItem: string
}
export type SteeringActivity = {
  messageId: string; disposition: SteeringDisposition; state: string
  reviewMessageId: string | null; sourceJobId: string
  checkpointSha: string | null; checkpointWorkItem: string | null
  checkpointProof: string | null; consideredAt: string
  verifiedEffectAt: string | null
  implementationSha: string | null
  implementationCount: number
}
export interface SteeringPersistence {
  registerTurn(jobId: string, piToken: string, piSessionId: string,
    workItem: string, expectedHead: string | null, at: string): void
  closeTurn(jobId: string, piToken: string): void
  recoverOrphaned(): void
  dispatchable(): PendingPiInput[]
  turn(jobId: string, piToken: string): { sessionId: string } | null
  claim(item: PendingPiInput, token: string, sessionId: string): boolean
  deferUnsent(messageId: string, token: string): void
  accepted(messageId: string, token: string): void
  blocked(messageId: string, owner: string, token: string, attempted: boolean): void
  settling(jobId: string, token: string): ClaimedPiInput[]
  settle(row: ClaimedPiInput, token: string, delivered: boolean, workItem: string,
    disposition: SteeringDisposition, at: string): void
  deferTurn(jobId: string, token: string): void
  review(owner: string, threadId: string, messageId: string, reviewer: string,
    evidence: string, at: string): void
  deferUndelivered(owner: string, jobId: string): void
  consider(messageId: string, owner: string, threadId: string, jobId: string,
    content: string, workItem: string | null, disposition: SteeringDisposition, at: string): void
  attribute(owner: string, jobId: string, checkpoint: SteeringCheckpoint, at: string): number
  approvedReplan(owner: string, jobId: string, point: SteeringCheckpoint,
    files: string[], at: string): number
  boundaryReviews(owner: string, jobId: string, threadId: string, verifiedHead: string, at: string): number
  activity(owner: string, threadId: string): SteeringActivity[]
}
