/** Owner-scoped, transaction-safe steering and checkpoint attribution.
 * Every port is Promise-returning. The Pi SDK lifecycle waits for durable
 * ownership registration before exposing an active turn, and all writer
 * fences remain atomic inside each backend adapter. */
import type { SteeringInput, SteeringBoundaryDecision } from "../../../src/steering-boundary";

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
  amendmentSha: string | null
  amendmentDigest: string | null
}
export interface SteeringPersistence {
  registerTurn(jobId: string, piToken: string, piSessionId: string,
    workItem: string, expectedHead: string | null, at: string): Promise<void>
  closeTurn(jobId: string, piToken: string): Promise<void>
  recoverOrphaned(): Promise<void>
  dispatchable(): Promise<PendingPiInput[]>
  turn(jobId: string, piToken: string): Promise<{ sessionId: string } | null>
  claim(item: PendingPiInput, token: string, sessionId: string): Promise<boolean>
  deferUnsent(messageId: string, token: string): Promise<void>
  accepted(messageId: string, token: string): Promise<void>
  blocked(messageId: string, owner: string, token: string, attempted: boolean): Promise<void>
  settling(jobId: string, token: string): Promise<ClaimedPiInput[]>
  settle(row: ClaimedPiInput, token: string, delivered: boolean, workItem: string,
    disposition: SteeringDisposition, at: string): Promise<void>
  deferTurn(jobId: string, token: string): Promise<void>
  review(owner: string, threadId: string, messageId: string, reviewer: string,
    evidence: string, at: string): Promise<void>
  deferUndelivered(owner: string, jobId: string): Promise<void>
  consider(messageId: string, owner: string, threadId: string, jobId: string,
    content: string, workItem: string | null, disposition: SteeringDisposition, at: string): Promise<void>
  attribute(owner: string, jobId: string, checkpoint: SteeringCheckpoint, at: string): Promise<number>
  approvedReplan(owner: string, jobId: string, point: SteeringCheckpoint,
    files: string[], at: string): Promise<number>
  boundaryReviews(owner: string, jobId: string, threadId: string, verifiedHead: string, at: string): Promise<number>
  pendingBoundary(owner: string, jobId: string, threadId: string): Promise<SteeringInput[]>
  boundaryReceipts(owner: string, jobId: string, threadId: string): Promise<Array<{
    messageId: string; sourceSha: string; amendmentDigest: string }>>
  settleBoundary(owner: string, jobId: string, threadId: string,
    decision: SteeringBoundaryDecision, at: string): Promise<void>
  activity(owner: string, threadId: string): Promise<SteeringActivity[]>
}
