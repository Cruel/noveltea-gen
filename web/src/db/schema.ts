import { foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const piCredentials = sqliteTable('pi_credentials', {
  ownerUserId: text('owner_user_id').notNull(),
  provider: text('provider').notNull(),
  ciphertext: text('ciphertext').notNull(),
  revision: integer('revision').notNull().default(1),
}, table => [
  primaryKey({ columns: [table.ownerUserId, table.provider] }),
])

export const repositories = sqliteTable('repositories', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  provider: text('provider', { enum: ['github', 'gitlab'] }).notNull(),
  providerRepositoryId: text('provider_repository_id').notNull(),
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
])
