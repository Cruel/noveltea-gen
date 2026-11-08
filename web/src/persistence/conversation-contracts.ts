/** Story-owned Thread catalog persistence.
 * All operations are owner-scoped and async at the service boundary. The SQLite
 * adapter keeps multi-table reconciliation and archive updates transactional.
 */
export type NavigationThreadRecord = {
  id: string
  storyId: string
  parentThreadId: string | null
  title: string
  activityAt: string
  archivedAt: string | null
  deletedAt: string | null
  deletionCompleteAt: string | null
  createdAt: string
  jobId: string | null
  needsAuthor: boolean | null
  jobStatus: string | null
  requestJson: string | null
  queuePhase: string | null
  queueAt: string | null
  queueUpdatedAt: string | null
  lastEventAt: string | null
  workingStage: string | null
  workingMilestone: string | null
}
export type ThreadDeletionRecord = {
  deletedAt: string | null
  completedAt: string | null
  planJson: string | null
  bytes: number | null
  children: number
  pendingForks: number
  externalPublications: number
  unsettledMessages: number
  runs: Array<{ id: string; status: string; queue: string | null }>
}
export type UsageRunRecord = {
  jobId: string; threadId: string; runOrder: number; status: string;
  requestJson: string | null; deletedAt: string | null; deletionPlanJson: string | null;
};
export interface ConversationCatalog {
  story(owner: string, storyId: string): Promise<{ id: string; title: string } | null>
  /** One owner-scoped row per actual run, including archived/deleted history.
   * Never flatten parent/child ancestry into model usage: only executions spend. */
  usageRuns(owner: string, storyId: string): Promise<UsageRunRecord[]>
  /** Import historical root sessions once; never synthesize checkpoint provenance. */
  reconcileRoots(owner: string, storyId: string): Promise<void>
  navigation(owner: string, storyId: string): Promise<{
    threads: NavigationThreadRecord[]
  }>
  create(owner: string, storyId: string, id: string, at: string): Promise<{ id: string; title: string }>
  renameThread(owner: string, id: string, title: string): Promise<boolean>
  /** Idempotent for own Threads, rejects foreign and unknown IDs. */
  archiveThread(owner: string, id: string, archived: boolean, at: string): Promise<boolean>
  deletion(owner: string, id: string): Promise<ThreadDeletionRecord | null>
  /** Atomically fence new work before physical cleanup, with an immutable trusted plan. */
  beginDeletion(owner: string, id: string, jobIds: string[], planJson: string, at: string): Promise<boolean>
  finishDeletion(owner: string, id: string, at: string, bytes: number): Promise<void>
  deletedJob(owner: string, jobId: string): Promise<boolean>
}
