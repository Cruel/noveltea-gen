/** Git identities and Story onboarding persistence ports.
 * Authenticated owner identity scopes record access. OAuth state consumption
 * is single-use; initialization job lookup spans owners to detect collisions.
 * No caller needs a SQLite connection or database-specific result objects.
 */
export type GitProvider = 'github' | 'gitlab'
export type GitConnectionStatus = 'connected' | 'reauthorize' | 'disconnected'
export type GitConnectionRecord = {
  id: string; owner: string; provider: GitProvider; providerAccountId: string; login: string
  credentials: string; revision: number; accessExpiresAt: number | null; refreshExpiresAt: number | null
  refreshLeaseId: string | null; refreshLeaseUntil: number | null; status: GitConnectionStatus
}
export type GitConnectionSummary = {
  id: string; provider: GitProvider; accountId: string; login: string
  status: GitConnectionStatus; accessExpiresAt: number | null
}
export type RepositoryRecord = {
  id: string; provider: GitProvider; providerId: string; name: string; connectionId: string | null
}
export type StoryRecord = {
  id: string; directory: string; title: string; commitSha: string | null
}
export type StoryInput = {
  id: string; owner: string; repositoryId: string; directory: string; title: string
  createdAt: string; commitSha: string; contentSha256?: string
}
export interface GitIdentities {
  list(owner: string): Promise<GitConnectionSummary[]>
  read(owner: string, id: string): Promise<GitConnectionRecord | null>
  hasActive(owner: string, provider: GitProvider): Promise<boolean>
  legacyAccounts(owner: string, provider: GitProvider): Promise<string[]>
  startFlow(owner: string, provider: GitProvider, stateHash: string, verifier: string, expiresAt: number, now: number): Promise<void>
  consumeFlow(stateHash: string, provider: GitProvider, now: number): Promise<{ owner: string; verifier: string } | null>
  connect(record: {
    id: string; owner: string; provider: GitProvider; providerAccountId: string; login: string
    credentials: string; accessExpiresAt: number | null; refreshExpiresAt: number | null; now: string
  }): Promise<void>
  disconnect(owner: string, id: string, now: string): Promise<boolean>
  requireReauthorization(owner: string, id: string, revision: number, leaseId?: string): Promise<void>
  acquireRefreshLease(owner: string, id: string, revision: number, leaseId: string,
    leaseUntil: number, now: number): Promise<boolean>
  finishRefresh(owner: string, id: string, revision: number, leaseId: string, values: {
    credentials: string; accessExpiresAt: number | null; refreshExpiresAt: number | null; now: string
  }): Promise<boolean>
  failRefresh(owner: string, id: string, leaseId: string): Promise<void>
}
export interface RepositoryCatalogWrites {
  get(owner: string, id: string, provider?: GitProvider): Promise<RepositoryRecord | null>
  identities(owner: string): Promise<Array<{ provider: GitProvider; id: string }>>
  upsert(owner: string, provider: GitProvider, providerId: string, name: string,
    connectionId: string | null, id: string, now: string): Promise<RepositoryRecord>
  rebind(owner: string, repository: RepositoryRecord, connectionId: string | null): Promise<boolean>
  repositoryForStory(owner: string, storyId: string, provider: GitProvider): Promise<string | null>
  pendingInstallNames(owner: string, now: number): Promise<string[]>
  beginInstall(flow: {
    stateHash: string; owner: string; desired: string | null; createdAt: number
    expiresAt: number; connectionId: string | null
  }, now: number): Promise<void>
  consumeInstall(owner: string, hash: string, now: number): Promise<{
    desired: string | null; connectionId: string | null
  } | null>
  deferInstall(owner: string, hash: string, expiresAt: number): Promise<void>
  clearPendingInstall(owner: string, name: string): Promise<void>
}
export interface StoryOnboarding {
  conversation(owner: string, repositoryId: string, workspace: string): Promise<{ revision: number; state: string } | null>
  saveConversation(owner: string, repositoryId: string, workspace: string, revision: number,
    state: string, previousRevision: number | null, now: string): Promise<boolean>
  draft(owner: string, repositoryId: string, workspace: string): Promise<{ revision: number; draftJson: string } | null>
  saveDraft(owner: string, repositoryId: string, workspace: string, previousRevision: number,
    draftJson: string, now: string): Promise<boolean>
  story(owner: string, repositoryId: string, directory: string): Promise<{
    id: string; contentSha256: string | null
  } | null>
  initializationJob(jobId: string): Promise<{ storyId: string; ownerId: string; commitSha: string | null } | null>
  /** Story and its initialization session are committed atomically, synchronously in SQLite. */
  commitGithubInitialization(story: StoryInput, jobId: string): Promise<void>
  /** Preserve the existing import upsert, including the unique repository/directory identity. */
  importStory(story: StoryInput): Promise<StoryRecord>
  /** For GitLab initialization, fail on a duplicate instead of updating it. */
  createStory(story: StoryInput): Promise<StoryRecord>
}
export interface PiCredentialVault {
  read(owner: string, provider: string): Promise<{ ciphertext: string; revision: number } | null>
  list(owner: string): Promise<Array<{ provider: string; ciphertext: string }>>
  compareAndSwap(owner: string, provider: string, ciphertext: string, previousRevision: number | null): Promise<boolean>
  delete(owner: string, provider: string): Promise<void>
}
