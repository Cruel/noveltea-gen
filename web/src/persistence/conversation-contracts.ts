/** Core Conversation and Thread catalog persistence.
 * All operations are owner-scoped and async at the service boundary. The SQLite
 * adapter keeps multi-table reconciliation and archive updates transactional.
 */
export type ConversationRecord = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}
export type NavigationThreadRecord = {
  id: string
  conversationId: string
  parentThreadId: string | null
  title: string
  activityAt: string
  archivedAt: string | null
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
export interface ConversationCatalog {
  story(owner: string, storyId: string): Promise<{ id: string; title: string } | null>
  /** Import historical root sessions once; never synthesize checkpoint provenance. */
  reconcileRoots(owner: string, storyId: string): Promise<void>
  navigation(owner: string, storyId: string): Promise<{
    conversations: ConversationRecord[]
    threads: NavigationThreadRecord[]
  }>
  create(owner: string, storyId: string, id: string, at: string): Promise<{ id: string; title: string }>
  renameConversation(owner: string, id: string, title: string, at: string): Promise<boolean>
  renameThread(owner: string, id: string, title: string): Promise<boolean>
  /** Idempotent for own Threads, rejects foreign and unknown IDs. */
  archiveThread(owner: string, id: string, archived: boolean, at: string): Promise<boolean>
}
