/** Advanced author Thread lifecycle. The server owns Git and validator preflight;
 * persistence owns identity, idempotency, sequencing, and atomic registration.
 * No driver handles cross this port. */
export type ThreadIdentity = {
  id: string; parent: string | null; conversation: string; story: string; title: string
}
export type ForkIntent = {
  owner: string; source: string; base: string; commitSha: string; bundle: string; draft: string;
  sourceThreadId: string | null; proofDigest: string | null; guidance: string; history: string | null;
  editedMessageId: string | null; editedBody: string | null
}
export type ForkReservation = {
  childId: string; owner: string; sourceJobId: string; sourceBaseSha: string;
  commitSha: string; bundle: string; draft: string; sourceThreadId: string;
  proofDigest: string; guidance: string; history: string; at: string;
  editedMessageId?: string; editedBody?: string
}
export type RestartIntent = {
  owner: string; sourceThread: string; sourceJob: string; rootJob: string
  original: string; mode: 'original' | 'newer'; selected: string; branch: string | null
  draft: string; preparedAt: string | null
}
export type RestartReservation = {
  childId: string; owner: string; sourceThread: string; sourceJob: string; rootJob: string;
  original: string; selected: string; mode: 'original' | 'newer';
  branch: string | null; draft: string; at: string
}
export type HistoryMessage = {
  id: string; role: 'user' | 'assistant'; status: 'delivered' | 'queued'
  body: string; origin: string | null; verifiedSha: string | null; createdAt: string
}
export type JobInspection = {
  threadId: string | null
  messages: Array<{
    role: 'user' | 'assistant'; status: 'delivered' | 'queued'; body: string
    originMessageId: string | null; verifiedCommitSha: string | null; createdAt: string
  }>
  restart: {
    sourceThreadId: string; sourceJobId: string; originalJobId: string
    originalSha: string; selectedSha: string; mode: 'original' | 'newer'
    targetBranch: string | null
  } | null
}
export type ForkInheritedMessage = {
  role: 'user' | 'assistant'; body: string; originId: string; verifiedSha: string; createdAt: string
}
export type EditableMessage = {
  id: string; threadId: string; sequence: number; role: string; status: string; body: string;
  phase: string | null; jobId: string | null; sourceJobId: string | null; origin: string | null
}
export type NewThreadChild = {
  childId: string; owner: string; storyId: string; title: string; baseSha: string;
  conversationId: string; parentThreadId: string; threadId: string; draft: string; at: string;
  kind: 'fork' | 'restart' | 'edit'; history?: ForkInheritedMessage[]; guidance?: string;
  editedMessageId?: string; editedBody?: string
}
export type ChildRegistration = { inserted: boolean; storyId: string; commitSha: string | null }
export interface AdvancedThreadPersistence {
  /** Standalone import for verified fork history; child-registration imports atomically. */
  importHistory(owner: string, threadId: string, history: ForkInheritedMessage[],
    guidance: string, at: string): Promise<void>
  identity(owner: string, threadId: string): Promise<ThreadIdentity | null>
  ancestor(owner: string, threadId: string): Promise<ThreadIdentity | null>
  run(owner: string, threadId: string, position: 'first' | 'last'): Promise<{ jobId: string } | null>
  runOrder(owner: string, threadId: string, jobId: string): Promise<number | null>
  repository(owner: string, storyId: string): Promise<{
    repositoryId: string; provider: 'github' | 'gitlab'; providerId: string;
    repository: string; directory: string
  } | null>
  sourceThread(owner: string, jobId: string): Promise<{ id: string; conversation: string } | null>
  inspectJob(owner: string, jobId: string): Promise<JobInspection>
  forkDraft(owner: string, childId: string): Promise<{ bundle: string; original: string } | null>
  jobClaimed(childId: string): Promise<boolean>
  forkIntent(childId: string): Promise<ForkIntent | null>
  reserveFork(data: ForkReservation): Promise<ForkIntent>
  restartIntent(childId: string): Promise<RestartIntent | null>
  reserveRestart(data: RestartReservation): Promise<RestartIntent>
  preparedRestart(owner: string, childId: string, threadId: string): Promise<boolean>
  registerChild(data: NewThreadChild): Promise<ChildRegistration>
  history(owner: string, threadId: string, beforeSequence?: number, beforeRunOrder?: number): Promise<HistoryMessage[]>
  editable(owner: string, threadId: string, messageId: string): Promise<EditableMessage | null>
  origin(owner: string, messageId: string): Promise<EditableMessage | null>
  inheritedCount(owner: string, threadId: string, beforeSequence: number): Promise<number>
  runJobs(owner: string, threadId: string): Promise<string[]>
  importAppliedMessage(owner: string, threadId: string, messageId: string, body: string,
    originalId: string, jobId: string, at: string): Promise<void>
}
