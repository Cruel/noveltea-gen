import { foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const piCredentials = sqliteTable('pi_credentials', {
  ownerUserId: text('owner_user_id').notNull(),
  provider: text('provider').notNull(),
  ciphertext: text('ciphertext').notNull(),
  revision: integer('revision').notNull().default(1),
}, table => [
  primaryKey({ columns: [table.ownerUserId, table.provider] }),
])

export const userPreferences = sqliteTable('user_preferences', {
  ownerUserId: text('owner_user_id').primaryKey(),
  defaultModelJson: text('default_model_json'),
  updatedAt: text('updated_at').notNull(),
})

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
})

export const repositories = sqliteTable('repositories', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  provider: text('provider', { enum: ['github', 'gitlab'] }).notNull(),
  providerRepositoryId: text('provider_repository_id').notNull(),
  connectionId: text('connection_id').references(() => gitConnections.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
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
  foreignKey({ columns: [table.repositoryId, table.ownerUserId], foreignColumns: [repositories.id, repositories.ownerUserId] }),
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
  foreignKey({ columns: [table.jobId, table.ownerUserId], foreignColumns: [sessions.id, sessions.ownerUserId] }),
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
    foreignColumns: [sessions.id, sessions.ownerUserId] }),
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
    foreignColumns: [sessions.id, sessions.ownerUserId] }),
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
    foreignColumns: [sessions.id, sessions.ownerUserId] }),
])

export const storyConversations = sqliteTable('story_conversations', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  storyId: text('story_id').notNull(),
  title: text('title').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  foreignKey({ columns: [table.storyId, table.ownerUserId], foreignColumns: [stories.id, stories.ownerUserId] }),
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
    foreignColumns: [storyConversations.id, storyConversations.ownerUserId] }),
  foreignKey({ columns: [table.parentThreadId, table.ownerUserId, table.conversationId],
    foreignColumns: [table.id, table.ownerUserId, table.conversationId] }),
  uniqueIndex('story_threads_owner_pair').on(table.id, table.ownerUserId),
  uniqueIndex('story_threads_owner_conversation').on(table.id, table.ownerUserId, table.conversationId),
  index('story_threads_conversation_idx').on(table.ownerUserId, table.conversationId),
])

export const storyThreadRuns = sqliteTable('story_thread_runs', {
  jobId: text('job_id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  threadId: text('thread_id').notNull(),
  runOrder: integer('run_order').notNull(),
  needsAuthor: integer('needs_author', { mode: 'boolean' }).notNull().default(false),
}, table => [
  foreignKey({ columns: [table.threadId, table.ownerUserId], foreignColumns: [storyThreads.id, storyThreads.ownerUserId] }),
  foreignKey({ columns: [table.jobId, table.ownerUserId], foreignColumns: [sessions.id, sessions.ownerUserId] }),
  uniqueIndex('story_thread_runs_order').on(table.threadId, table.runOrder),
  index('story_thread_runs_thread_idx').on(table.ownerUserId, table.threadId, table.runOrder),
])

export const storyThreadPreferences = sqliteTable('story_thread_preferences', {
  ownerUserId: text('owner_user_id').notNull(),
  storyId: text('story_id').notNull(),
  viewMode: text('view_mode', { enum: ['tree', 'flat'] }).notNull(),
  expandedIdsJson: text('expanded_ids_json').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  primaryKey({ columns: [table.ownerUserId, table.storyId] }),
  foreignKey({ columns: [table.storyId, table.ownerUserId], foreignColumns: [stories.id, stories.ownerUserId] }),
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
  foreignKey({ columns: [table.storyId, table.ownerUserId], foreignColumns: [stories.id, stories.ownerUserId] }),
  index('studio_sessions_owner_idx').on(table.ownerUserId, table.updatedAt),
  uniqueIndex('studio_sessions_owner_pair').on(table.id, table.ownerUserId),
])
