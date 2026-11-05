import type { CatalogProvider } from './contracts'

export class PublicationStateConflict extends Error {}

export type PublicationJob = {
  id: string
  title: string
  repository: string
  repositoryId: string
  providerId: string
  baseSha: string | null
  directory: string
  initialContentSha256: string | null
}

export type PublicationReceipt = {
  targetBranch: string
  remoteBranch: string
  headSha: string
  phase: 'pending' | 'linked'
  number: number | null
  url: string | null
}

/** A pending receipt is written before the remote branch push. A linked
 * receipt follows provider verification; retries must not create a second PR/MR. */
export interface PublicationRecords {
  job(owner: string, jobId: string, provider: CatalogProvider): Promise<PublicationJob | null>
  get(owner: string, jobId: string, provider: CatalogProvider): Promise<PublicationReceipt | null>
  save(owner: string, jobId: string, provider: CatalogProvider,
    receipt: PublicationReceipt, updatedAt: string): Promise<void>
}

export type ApprovalJob = {
  directory: string
  provider: CatalogProvider
  providerId: string
  baseSha: string | null
}

export interface ApprovalJobCatalog {
  /** The principal comes from the authenticated request, not the payload. */
  job(owner: string, jobId: string): Promise<ApprovalJob | null>
}

export type ProtectedDecisionReceipt = {
  messageId: string
  owner: string
  threadId: string
  sourceJobId: string
  sourceSha: string
  digest: string
  changeJson: string
  nonce: string
  decision: 'approved' | 'rejected'
  principal: string
  recordedAt: string
  consumedSha: string | null
}

export type ProtectedDecisionGrant = Omit<ProtectedDecisionReceipt, 'consumedSha'>

export interface ProtectedDecisionRecords {
  get(owner: string, messageId: string): Promise<ProtectedDecisionReceipt | null>
  record(owner: string, data: ProtectedDecisionGrant, request: string): Promise<ProtectedDecisionReceipt>
  /** Exactly one controller-approved consumption, even across worker restarts. */
  consume(owner: string, messageId: string, sha: string): Promise<boolean>
  /** No awaits inside a better-sqlite3 transaction. Advanced Thread operations
   * use these atomic bridges until their separate migration. */
  sqliteBridge: {
    get(owner: string, messageId: string): ProtectedDecisionReceipt | null
    record(owner: string, data: ProtectedDecisionGrant, request: string): ProtectedDecisionReceipt
    consume(owner: string, messageId: string, sha: string): boolean
  }
}

export type RevisionQueueHead = { id: string; content: string; phase: string }
export type RevisionRun = { jobId: string; status: string; queuePhase: string | null }
export type RevisionGrantResult = 'granted' | 'already' | 'stale'
export interface RevisionRecords {
  head(owner: string, threadId: string): Promise<RevisionQueueHead | null>
  latestRun(owner: string, threadId: string): Promise<RevisionRun | null>
  scope(owner: string, threadId: string, messageId: string): Promise<string | null>
  redirected(owner: string, threadId: string, messageId: string): Promise<boolean>
  grant(owner: string, threadId: string, messageId: string, content: string,
    source: RevisionRun, receiptJson: string): Promise<RevisionGrantResult>
}
