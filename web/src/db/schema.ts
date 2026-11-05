import { sql } from 'drizzle-orm'
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { betterAuthUser } from './auth-reference'

export const piCredentials = sqliteTable('pi_credentials', {
  ownerUserId: text('owner_user_id').notNull(),
  provider: text('provider').notNull(),
  ciphertext: text('ciphertext').notNull(),
  revision: integer('revision').notNull().default(1),
}, table => [
  primaryKey({ columns: [table.ownerUserId, table.provider] }),
  foreignKey({ columns: [table.ownerUserId], foreignColumns: [betterAuthUser.id] }).onDelete('cascade'),
])

export const userPreferences = sqliteTable('user_preferences', {
  ownerUserId: text('owner_user_id').primaryKey(),
  defaultModelJson: text('default_model_json'),
  updatedAt: text('updated_at').notNull(),
}, table => [
  foreignKey({ columns: [table.ownerUserId], foreignColumns: [betterAuthUser.id] }).onDelete('cascade'),
])

export const gitConnections = sqliteTable('git_connections', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  provider: text('provider', { enum: ['github', 'gitlab'] }).notNull(),
  providerAccountId: text('provider_account_id').notNull(),
  login: text('login').notNull(),
  credentials: text('credentials').notNull(),
  revision: integer('revision').notNull().default(1),
  refreshLeaseId: text('refresh_lease_id'),
  refreshLeaseUntil: integer('refresh_lease_until'),
  accessExpiresAt: integer('access_expires_at'),
  refreshExpiresAt: integer('refresh_expires_at'),
  status: text('status', { enum: ['connected', 'reauthorize', 'disconnected'] }).notNull().default('connected'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  foreignKey({ columns: [table.ownerUserId], foreignColumns: [betterAuthUser.id] }).onDelete('cascade'),
  check('git_connections_provider_check', sql`${table.provider} in ('github', 'gitlab')`),
  check('git_connections_status_check', sql`${table.status} in ('connected', 'reauthorize', 'disconnected')`),
  uniqueIndex('git_connections_owner_identity').on(table.ownerUserId, table.provider, table.providerAccountId),
  uniqueIndex('git_connections_owner_pair').on(table.id, table.ownerUserId),
  index('git_connections_owner_idx').on(table.ownerUserId, table.provider),
])

export const gitConnectionFlows = sqliteTable('git_connection_flows', {
  stateHash: text('state_hash').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  provider: text('provider', { enum: ['github', 'gitlab'] }).notNull(),
  verifier: text('verifier').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, table => [
  foreignKey({ columns: [table.ownerUserId], foreignColumns: [betterAuthUser.id] }).onDelete('cascade'),
  check('git_connection_flows_provider_check', sql`${table.provider} in ('github', 'gitlab')`),
])

export const repositories = sqliteTable('repositories', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  provider: text('provider', { enum: ['github', 'gitlab'] }).notNull(),
  providerRepositoryId: text('provider_repository_id').notNull(),
  connectionId: text('connection_id').references(() => gitConnections.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  foreignKey({ columns: [table.ownerUserId], foreignColumns: [betterAuthUser.id] }).onDelete('cascade'),
  check('repositories_provider_check', sql`${table.provider} in ('github', 'gitlab')`),
  uniqueIndex('repositories_identity').on(table.ownerUserId, table.provider, table.providerRepositoryId),
  uniqueIndex('repositories_owner_pair').on(table.id, table.ownerUserId),
  index('repositories_owner_idx').on(table.ownerUserId),
])

export const stories = sqliteTable('stories', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  repositoryId: text('repository_id').notNull(),
  directory: text('directory').notNull(),
  title: text('title').notNull(),
  createdAt: text('created_at').notNull(),
  sourceCommitSha: text('source_commit_sha'),
  initialContentSha256: text('initial_content_sha256'),
}, (table) => [
  foreignKey({ columns: [table.repositoryId, table.ownerUserId], foreignColumns: [repositories.id, repositories.ownerUserId] }).onDelete('cascade'),
  uniqueIndex('stories_owner_pair').on(table.id, table.ownerUserId),
  uniqueIndex('stories_directory').on(table.repositoryId, table.directory),
  index('stories_owner_idx').on(table.ownerUserId),
])

export const generationEvents = sqliteTable('generation_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: text('job_id').notNull(),
  ownerUserId: text('owner_user_id').notNull(),
  kind: text('kind', { enum: ['started', 'working', 'verified', 'finished', 'interrupted'] }).notNull(),
  stage: text('stage'),
  milestone: text('milestone'),
  filesJson: text('files_json').notNull().default('[]'),
  status: text('status'),
  createdAt: text('created_at').notNull(),
}, table => [
  foreignKey({ columns: [table.jobId, table.ownerUserId], foreignColumns: [sessions.id, sessions.ownerUserId] }).onDelete('cascade'),
  check('generation_events_kind_check', sql`${table.kind} in ('started','working','verified','finished','interrupted')`),
  index('generation_events_job_idx').on(table.ownerUserId, table.jobId, table.id),
])

export const generationRunQueue = sqliteTable('generation_run_queue', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  jobId: text('job_id').notNull().unique(),
  ownerUserId: text('owner_user_id').notNull(),
  intent: text('intent', { enum: ['start', 'resume'] }).notNull(),
  phase: text('phase', { enum: ['queued', 'running', 'finished', 'interrupted'] }).notNull(),
  workerId: text('worker_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  foreignKey({ columns: [table.jobId, table.ownerUserId],
    foreignColumns: [sessions.id, sessions.ownerUserId] }).onDelete('cascade'),
  check('generation_run_queue_intent_check', sql`${table.intent} in ('start','resume')`),
  check('generation_run_queue_phase_check', sql`${table.phase} in ('queued','running','finished','interrupted')`),
  index('generation_run_queue_order').on(table.phase, table.sequence),
])

export const githubPublications = sqliteTable('github_publications', {
  jobId: text('job_id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  targetBranch: text('target_branch').notNull(),
  remoteBranch: text('remote_branch').notNull(),
  headSha: text('head_sha').notNull(),
  phase: text('phase', { enum: ['pending', 'linked'] }).notNull(),
  prNumber: integer('pr_number'),
  prUrl: text('pr_url'),
  updatedAt: text('updated_at').notNull(),
}, table => [
  foreignKey({ columns: [table.jobId, table.ownerUserId],
    foreignColumns: [sessions.id, sessions.ownerUserId] }).onDelete('cascade'),
  check('github_publications_phase_check', sql`${table.phase} in ('pending','linked')`),
])

export const gitlabPublications = sqliteTable('gitlab_publications', {
  jobId: text('job_id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  targetBranch: text('target_branch').notNull(),
  remoteBranch: text('remote_branch').notNull(),
  headSha: text('head_sha').notNull(),
  phase: text('phase', { enum: ['pending', 'linked'] }).notNull(),
  mrIid: integer('mr_iid'),
  mrUrl: text('mr_url'),
  updatedAt: text('updated_at').notNull(),
}, table => [
  foreignKey({ columns: [table.jobId, table.ownerUserId],
    foreignColumns: [sessions.id, sessions.ownerUserId] }).onDelete('cascade'),
  check('gitlab_publications_phase_check', sql`${table.phase} in ('pending','linked')`),
])

export const storyConversations = sqliteTable('story_conversations', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  storyId: text('story_id').notNull(),
  title: text('title').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  foreignKey({ columns: [table.storyId, table.ownerUserId], foreignColumns: [stories.id, stories.ownerUserId] }).onDelete('cascade'),
  uniqueIndex('story_conversations_owner_pair').on(table.id, table.ownerUserId),
  index('story_conversations_story_idx').on(table.ownerUserId, table.storyId),
])

export const storyThreads = sqliteTable('story_threads', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  conversationId: text('conversation_id').notNull(),
  parentThreadId: text('parent_thread_id'),
  title: text('title').notNull(),
  activityAt: text('activity_at').notNull(),
  archivedAt: text('archived_at'),
  createdAt: text('created_at').notNull(),
}, table => [
  foreignKey({ columns: [table.conversationId, table.ownerUserId],
    foreignColumns: [storyConversations.id, storyConversations.ownerUserId] }).onDelete('cascade'),
  foreignKey({ columns: [table.parentThreadId, table.ownerUserId, table.conversationId],
    foreignColumns: [table.id, table.ownerUserId, table.conversationId] }),
  check('story_threads_parent_not_self', sql`${table.parentThreadId} is null or ${table.parentThreadId} <> ${table.id}`),
  uniqueIndex('story_threads_owner_pair').on(table.id, table.ownerUserId),
  uniqueIndex('story_threads_owner_conversation').on(table.id, table.ownerUserId, table.conversationId),
  index('story_threads_conversation_idx').on(table.ownerUserId, table.conversationId),
])

export const storyThreadRuns = sqliteTable('story_thread_runs', {
  jobId: text('job_id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  threadId: text('thread_id').notNull(),
  runOrder: integer('run_order').notNull(),
  needsAuthor: integer('needs_author', { mode: 'boolean' }).notNull().default(sql`0`),
}, table => [
  foreignKey({ columns: [table.threadId, table.ownerUserId], foreignColumns: [storyThreads.id, storyThreads.ownerUserId] }).onDelete('cascade'),
  foreignKey({ columns: [table.jobId, table.ownerUserId], foreignColumns: [sessions.id, sessions.ownerUserId] }).onDelete('cascade'),
  check('story_thread_runs_needs_author_check', sql`${table.needsAuthor} in (0, 1)`),
  uniqueIndex('story_thread_runs_order').on(table.threadId, table.runOrder),
  index('story_thread_runs_thread_idx').on(table.ownerUserId, table.threadId, table.runOrder),
])

/** Immutable author-visible fork history and sequential chat messages.
 * Phase/job metadata is nullable for messages outside an active run. */
export const storyThreadMessages = sqliteTable('story_thread_messages', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  threadId: text('thread_id').notNull(),
  sequence: integer('sequence').notNull(),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  status: text('status', { enum: ['delivered', 'queued'] }).notNull(),
  body: text('body').notNull(),
  originMessageId: text('origin_message_id'),
  verifiedCommitSha: text('verified_commit_sha'),
  phase: text('phase', { enum: ['queued', 'preparing', 'running', 'finished', 'blocked'] }),
  jobId: text('job_id'),
  sourceJobId: text('source_job_id'),
  createdAt: text('created_at').notNull(),
  revisionScopeJson: text('revision_scope_json'),
}, table => [
  foreignKey({ columns: [table.threadId, table.ownerUserId],
    foreignColumns: [storyThreads.id, storyThreads.ownerUserId] }).onDelete('cascade'),
  check('story_thread_messages_role_check', sql`${table.role} in ('user', 'assistant')`),
  check('story_thread_messages_status_check', sql`${table.status} in ('delivered', 'queued')`),
  check('story_thread_messages_phase_check', sql`${table.phase} is null or ${table.phase} in ('queued','preparing','running','finished','blocked')`),
  uniqueIndex('story_thread_messages_one_preparing').on(table.threadId).where(sql`${table.role}='user' and ${table.phase}='preparing'`),
  uniqueIndex('story_thread_messages_order').on(table.threadId, table.sequence),
  index('story_thread_messages_thread_idx').on(table.ownerUserId, table.threadId, table.sequence),
])

export const threadRestarts = sqliteTable('thread_restarts', {
  childId: text('child_id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  sourceThreadId: text('source_thread_id').notNull(),
  sourceJobId: text('source_job_id').notNull(),
  rootJobId: text('root_job_id').notNull(),
  originalSha: text('original_sha').notNull(),
  mode: text('mode', { enum: ['original', 'newer'] }).notNull(),
  selectedSha: text('selected_sha').notNull(),
  targetBranch: text('target_branch'),
  draftJson: text('draft_json').notNull(),
  createdAt: text('created_at').notNull(),
  preparedAt: text('prepared_at'),
}, table => [
  foreignKey({ columns: [table.sourceThreadId, table.ownerUserId],
    foreignColumns: [storyThreads.id, storyThreads.ownerUserId] }),
  foreignKey({ columns: [table.sourceJobId, table.ownerUserId],
    foreignColumns: [sessions.id, sessions.ownerUserId] }),
  foreignKey({ columns: [table.ownerUserId], foreignColumns: [betterAuthUser.id] }),
  check('thread_restarts_mode_check', sql`${table.mode} in ('original','newer')`),
  index('thread_restarts_owner_source').on(table.ownerUserId, table.sourceThreadId),
])

export const storyThreadPreferences = sqliteTable('story_thread_preferences', {
  ownerUserId: text('owner_user_id').notNull(),
  storyId: text('story_id').notNull(),
  viewMode: text('view_mode', { enum: ['tree', 'flat'] }).notNull(),
  expandedIdsJson: text('expanded_ids_json').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  primaryKey({ columns: [table.ownerUserId, table.storyId] }),
  foreignKey({ columns: [table.storyId, table.ownerUserId], foreignColumns: [stories.id, stories.ownerUserId] }).onDelete('cascade'),
  check('story_thread_preferences_view_mode_check', sql`${table.viewMode} in ('tree','flat')`),
])

export const sessions = sqliteTable('studio_sessions', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  storyId: text('story_id').notNull(),
  title: text('title').notNull(),
  sourceCommitSha: text('source_commit_sha'),
  generationRequestJson: text('generation_request_json'),
  generationThreadId: text('generation_thread_id'),
  generationConfigJson: text('generation_config_json'),
  status: text('status', { enum: ['running', 'paused', 'blocked', 'completed', 'cancelled'] }).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  foreignKey({ columns: [table.storyId, table.ownerUserId], foreignColumns: [stories.id, stories.ownerUserId] }).onDelete('cascade'),
  check('studio_sessions_status_check', sql`${table.status} in ('running','paused','blocked','completed','cancelled')`),
  index('studio_sessions_owner_idx').on(table.ownerUserId, table.updatedAt),
  uniqueIndex('studio_sessions_owner_pair').on(table.id, table.ownerUserId),
])

export const githubInstallFlows = sqliteTable('github_install_flows', {
  stateHash: text('state_hash').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  desiredRepository: text('desired_repository'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  status: text('status', { enum: ['started','used','pending'] }).notNull(),
  connectionId: text('connection_id').references(() => gitConnections.id, { onDelete: 'set null' }),
}, table => [
  foreignKey({ columns: [table.ownerUserId], foreignColumns: [betterAuthUser.id] }).onDelete('cascade'),
  check('github_install_flows_status_check', sql`${table.status} in ('started','used','pending')`),
  index('github_install_flows_owner').on(table.ownerUserId, table.status, table.expiresAt),
])

export const storyOnboardingDrafts = sqliteTable('story_onboarding_drafts', {
  ownerUserId: text('owner_user_id').notNull(),
  repositoryId: text('repository_id').notNull(),
  workspace: text('workspace').notNull(),
  revision: integer('revision').notNull(),
  draftJson: text('draft_json').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  primaryKey({ columns: [table.ownerUserId, table.repositoryId, table.workspace] }),
  foreignKey({ columns: [table.ownerUserId], foreignColumns: [betterAuthUser.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.repositoryId, table.ownerUserId],
    foreignColumns: [repositories.id, repositories.ownerUserId] }).onDelete('cascade'),
])

export const storyOnboardingConversations = sqliteTable('story_onboarding_conversations', {
  ownerUserId: text('owner_user_id').notNull(),
  repositoryId: text('repository_id').notNull(),
  workspace: text('workspace').notNull(),
  revision: integer('revision').notNull(),
  stateJson: text('state_json').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  primaryKey({ columns: [table.ownerUserId, table.repositoryId, table.workspace] }),
  foreignKey({ columns: [table.ownerUserId], foreignColumns: [betterAuthUser.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.repositoryId, table.ownerUserId],
    foreignColumns: [repositories.id, repositories.ownerUserId] }).onDelete('cascade'),
])

export const checkpointForks = sqliteTable('checkpoint_forks', {
  childId: text('child_id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  sourceJobId: text('source_job_id').notNull(),
  sourceBaseSha: text('source_base_sha').notNull(),
  commitSha: text('commit_sha').notNull(),
  bundleJson: text('bundle_json').notNull(),
  draftJson: text('draft_json').notNull(),
  createdAt: text('created_at').notNull(),
  sourceThreadId: text('source_thread_id'),
  proofDigest: text('proof_digest'),
  guidance: text('guidance').notNull().default(''),
  historyJson: text('history_json'),
  editedMessageId: text('edited_message_id'),
  editedBody: text('edited_body'),
}, table => [
  foreignKey({ columns: [table.ownerUserId], foreignColumns: [betterAuthUser.id] }),
])

export const storyThreadMessageCancellations = sqliteTable('story_thread_message_cancellations', {
  messageId: text('message_id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  threadId: text('thread_id').notNull(),
  cancelledAt: text('cancelled_at').notNull(),
}, table => [
  foreignKey({ columns: [table.messageId], foreignColumns: [storyThreadMessages.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.threadId, table.ownerUserId],
    foreignColumns: [storyThreads.id, storyThreads.ownerUserId] }).onDelete('cascade'),
])

export const threadProtectedDecisions = sqliteTable('thread_protected_decisions', {
  messageId: text('message_id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  threadId: text('thread_id').notNull(),
  sourceJobId: text('source_job_id').notNull(),
  sourceSha: text('source_sha').notNull(),
  proposalSha256: text('proposal_sha256').notNull(),
  changeJson: text('change_json').notNull(),
  nonce: text('nonce').notNull().unique(),
  decision: text('decision', { enum: ['approved','rejected'] }).notNull(),
  principal: text('principal').notNull(),
  recordedAt: text('recorded_at').notNull(),
  consumedSha: text('consumed_sha'),
}, table => [
  foreignKey({ columns: [table.messageId], foreignColumns: [storyThreadMessages.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.threadId, table.ownerUserId], foreignColumns: [storyThreads.id, storyThreads.ownerUserId] }),
  foreignKey({ columns: [table.sourceJobId, table.ownerUserId], foreignColumns: [sessions.id, sessions.ownerUserId] }),
  check('thread_protected_decisions_decision_check', sql`${table.decision} in ('approved','rejected')`),
])

export const threadLiveInputs = sqliteTable('thread_live_inputs', {
  messageId: text('message_id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  threadId: text('thread_id').notNull(),
  sourceJobId: text('source_job_id').notNull(),
  mode: text('mode', { enum: ['steer','follow-up'] }).notNull(),
  state: text('state', { enum: ['pending','dispatching','sdk-queued','delivered','deferred','blocked'] }).notNull(),
  piToken: text('pi_token'),
  piSessionId: text('pi_session_id'),
  deliveredAt: text('delivered_at'),
  createdAt: text('created_at').notNull(),
  targetPiToken: text('target_pi_token'),
  targetWorkItem: text('target_work_item'),
  submittedHead: text('submitted_head'),
}, table => [
  foreignKey({ columns: [table.messageId], foreignColumns: [storyThreadMessages.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.threadId, table.ownerUserId], foreignColumns: [storyThreads.id, storyThreads.ownerUserId] }),
  foreignKey({ columns: [table.sourceJobId, table.ownerUserId], foreignColumns: [sessions.id, sessions.ownerUserId] }),
  check('thread_live_inputs_mode_check', sql`${table.mode} in ('steer','follow-up')`),
  check('thread_live_inputs_state_check', sql`${table.state} in ('pending','dispatching','sdk-queued','delivered','deferred','blocked')`),
  index('thread_live_inputs_pending').on(table.sourceJobId, table.state),
])

export const threadActivePiTurns = sqliteTable('thread_active_pi_turns', {
  jobId: text('job_id').primaryKey().references(() => sessions.id, { onDelete: 'cascade' }),
  piToken: text('pi_token').notNull().unique(),
  piSessionId: text('pi_session_id').notNull(),
  workItem: text('work_item').notNull(),
  createdAt: text('created_at').notNull(),
  expectedHead: text('expected_head'),
})

export const threadQueuedMessageEdits = sqliteTable('thread_queued_message_edits', {
  requestId: text('request_id').primaryKey(),
  messageId: text('message_id').notNull().references(() => storyThreadMessages.id, { onDelete: 'cascade' }),
  ownerUserId: text('owner_user_id').notNull(),
  threadId: text('thread_id').notNull(),
  oldBody: text('old_body').notNull(),
  newBody: text('new_body').notNull(),
  editedAt: text('edited_at').notNull(),
}, table => [
  foreignKey({ columns: [table.threadId, table.ownerUserId], foreignColumns: [storyThreads.id, storyThreads.ownerUserId] }),
])

export const threadLiveEffectReviews = sqliteTable('thread_live_effect_reviews', {
  messageId: text('message_id').primaryKey().references(() => threadLiveInputs.messageId, { onDelete: 'cascade' }),
  ownerUserId: text('owner_user_id').notNull(),
  threadId: text('thread_id').notNull(),
  jobId: text('job_id').notNull(),
  commitSha: text('commit_sha').notNull(),
  reviewer: text('reviewer').notNull(),
  evidence: text('evidence').notNull(),
  verifiedAt: text('verified_at').notNull(),
})

export const threadSteeringIntents = sqliteTable('thread_steering_intents', {
  messageId: text('message_id').primaryKey().references(() => threadLiveInputs.messageId, { onDelete: 'cascade' }),
  ownerUserId: text('owner_user_id').notNull(),
  threadId: text('thread_id').notNull(),
  sourceJobId: text('source_job_id').notNull(),
  disposition: text('disposition', { enum: ['within-scope','scope-review','protected-review','unresolved'] }).notNull(),
  workItem: text('work_item'),
  consideredAt: text('considered_at').notNull(),
  checkpointSha: text('checkpoint_sha'),
  checkpointProof: text('checkpoint_proof'),
  reviewMessageId: text('review_message_id').unique().references(() => storyThreadMessages.id),
  reviewState: text('review_state', { enum: ['considered','pending-boundary','awaiting-review','approved-run','unresolved'] }).notNull(),
}, table => [
  foreignKey({ columns: [table.threadId, table.ownerUserId], foreignColumns: [storyThreads.id, storyThreads.ownerUserId] }),
  foreignKey({ columns: [table.sourceJobId, table.ownerUserId], foreignColumns: [sessions.id, sessions.ownerUserId] }),
  check('thread_steering_intents_disposition_check', sql`${table.disposition} in ('within-scope','scope-review','protected-review','unresolved')`),
  check('thread_steering_intents_review_state_check', sql`${table.reviewState} in ('considered','pending-boundary','awaiting-review','approved-run','unresolved')`),
  index('thread_steering_intents_source').on(table.sourceJobId, table.reviewState),
])

export const threadSteeringCheckpointLinks = sqliteTable('thread_steering_checkpoint_links', {
  messageId: text('message_id').notNull().references(() => threadLiveInputs.messageId, { onDelete: 'cascade' }),
  ownerUserId: text('owner_user_id').notNull(),
  threadId: text('thread_id').notNull(),
  sourceJobId: text('source_job_id').notNull(),
  checkpointSha: text('checkpoint_sha').notNull(),
  proofDigest: text('proof_digest').notNull(),
  workItem: text('work_item').notNull(),
  association: text('association', { enum: ['considered','verified-influence','pending-unresolved','verified-implementation'] }).notNull(),
  recordedAt: text('recorded_at').notNull(),
}, table => [
  primaryKey({ columns: [table.messageId, table.checkpointSha] }),
  check('thread_steering_checkpoint_links_association_check',
    sql`${table.association} in ('considered','verified-influence','pending-unresolved','verified-implementation')`),
])
