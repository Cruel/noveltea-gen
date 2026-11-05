/** Durable generation persistence. All application consumers use asynchronous,
 * owner-scoped ports. The SQLite adapter alone chooses its transaction model.
 * A PostgreSQL implementation must serialize capacity and claim with row locks.
 */
export type QueueIntent = 'start' | 'resume'
export type QueuePhase = 'queued' | 'running' | 'finished' | 'interrupted'
export type QueueRecord = {
  jobId: string; ownerId: string; intent: QueueIntent; phase: QueuePhase
  workerId: string | null; sequence: number
}
export type JobState = {
  status: 'running' | 'paused' | 'blocked' | 'completed' | 'cancelled'
  requestJson: string | null; threadId: string | null; configJson: string | null
}
export type SavedGenerationJob = JobState & {
  id: string; storyId: string; title: string; commitSha: string | null
  provider: string; providerId: string; directory: string
  createdAt: string
}
export type CatalogStoryForJob = {
  id: string; directory: string; title: string; commitSha: string | null
  contentSha256: string | null; repository: string; providerId: string
}
export type ProgressRow = {
  id: number; kind: 'started' | 'working' | 'verified' | 'finished' | 'interrupted'
  stage: string | null; milestone: string | null; filesJson: string
  status: string | null; createdAt: string
}
export interface GenerationQueueStore {
  /** Single SQLite BEGIN IMMEDIATE operation; limit and oldest claim share one lock. */
  claim(workerId: string, limit: number, now: string): Promise<QueueRecord | null>
  record(jobId: string): Promise<QueueRecord | null>
  enqueue(owner: string, jobId: string, intent: QueueIntent, expected: 'prepared' | 'paused',
    now: string, requestJson?: string, threadId?: string): Promise<void>
  finish(jobId: string, workerId: string, succeeded: boolean, now: string): Promise<boolean>
  foreignRunning(workerId: string): Promise<Array<{ jobId: string; worker: string | null }>>
  interrupt(jobId: string, worker: string | null, now: string): Promise<boolean>
  dequeue(owner: string, jobId: string): Promise<boolean>
  reconcileAndEnqueue(owner: string, jobId: string, intent: QueueIntent,
    saved: { status: string; request: string; thread: string },
    interrupted: boolean, now: string): Promise<void>
}
export interface GenerationJobs {
  selected(owner: string, jobId: string): Promise<SavedGenerationJob | null>
  state(owner: string, jobId: string): Promise<JobState | null>
  catalogStory(owner: string, storyId: string, provider: 'github' | 'gitlab'):
    Promise<CatalogStoryForJob | null>
  /** Global ID lookup is required to detect conflicting cross-owner retries. */
  identity(jobId: string): Promise<{ storyId: string; ownerId: string; commitSha: string | null } | null>
  register(owner: string, jobId: string, storyId: string, title: string,
    commitSha: string, now: string): Promise<boolean>
  saveConfiguration(owner: string, jobId: string, configJson: string, now: string): Promise<boolean>
  increaseBudget(owner: string, jobId: string, oldJson: string, newJson: string, now: string): Promise<boolean>
  cancel(owner: string, jobId: string, now: string): Promise<void>
  authorDecision(owner: string, jobId: string, status: JobState['status'], now: string): Promise<void>
  start(owner: string, jobId: string, threadId: string, expectedRequest: string,
    workerId: string, now: string): Promise<boolean>
  finish(owner: string, jobId: string, threadId: string,
    status: JobState['status'], needsAuthor: boolean, workerId: string, now: string): Promise<boolean>
}
export interface GenerationProgress {
  append(owner: string, jobId: string, row: Omit<ProgressRow, 'id'>): Promise<void>
  after(owner: string, jobId: string, after: number, limit: number): Promise<ProgressRow[]>
  recent(owner: string, jobId: string, before: number, limit: number): Promise<ProgressRow[]>
  hasAfter(owner: string, jobId: string, after: number): Promise<boolean>
}
export interface GenerationPersistence {
  queue: GenerationQueueStore
  jobs: GenerationJobs
  events: GenerationProgress
}
