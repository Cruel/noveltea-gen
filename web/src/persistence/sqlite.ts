import { and, desc, eq, isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { repositories, sessions, stories, storyThreadRuns, storyThreads, storyThreadPreferences, userPreferences } from '../db/schema'
import type { StudioPersistence } from './contracts'
import { createGitSqlitePersistence } from './git-sqlite'
import { createSqliteNaturalStoryPersistence } from './natural-story-sqlite'
import { createSqliteGenerationPersistence } from './generation-sqlite'
import { createSqliteConversationCatalog } from './conversation-sqlite'
import { createSqliteThreadMessages } from './thread-message-sqlite'
import { createSqliteAdvancedThreads } from './advanced-thread-sqlite'
import { createSqliteSteeringPersistence, createSqliteSteeringSync } from './steering-sqlite'
import { createSqliteContinuationPersistence } from './continuation-sqlite'
import { createSqlitePublicationRecords } from './publication-sqlite'
import { createSqliteApprovalJobCatalog, createSqliteProtectedDecisionRecords,
  createSqliteRevisionRecords } from './approval-revision-sqlite'

type StudioDrizzle = BetterSQLite3Database<typeof schema>

function assertOwner(owner: string): void {
  if (!owner) throw new Error('Authenticated actor required')
}

/** SQLite driver operations and transactions stay synchronous.
 * These async-compatible ports use resolved Promises around complete, atomic
 * Drizzle operations; never await within a better-sqlite3 transaction callback.
 * A later PostgreSQL implementation may implement the same ports with async IO.
 */
export function createSqlitePersistence(db: StudioDrizzle): StudioPersistence {
  const generation = createSqliteGenerationPersistence(db)
  const steeringSync = createSqliteSteeringSync(db)
  const steering = createSqliteSteeringPersistence(steeringSync)
  const protectedDecisions = createSqliteProtectedDecisionRecords(db)
  return {
    ...createGitSqlitePersistence(db),
    naturalStory: createSqliteNaturalStoryPersistence(db),
    generation,
    conversations: createSqliteConversationCatalog(db),
    messages: createSqliteThreadMessages(db),
    advancedThreads: createSqliteAdvancedThreads(db),
    steering,
    continuation: createSqliteContinuationPersistence(db, steeringSync),
    publications: createSqlitePublicationRecords(db),
    approvalJobs: createSqliteApprovalJobCatalog(db),
    protectedDecisions,
    revisions: createSqliteRevisionRecords(db),
    dashboard: {
      async forOwner(owner) {
        assertOwner(owner)
        const repoRows = db.select({
          id: repositories.id, name: repositories.name, provider: repositories.provider,
        }).from(repositories).where(eq(repositories.ownerUserId, owner)).all()
        const storyRows = db.select({
          id: stories.id, title: stories.title, repositoryId: stories.repositoryId,
          directory: stories.directory, commitSha: stories.sourceCommitSha,
        }).from(stories).where(eq(stories.ownerUserId, owner)).all()
        const sessionRows = db.select({
          id: sessions.id, storyId: sessions.storyId, title: sessions.title,
          status: sessions.status, updatedAt: sessions.updatedAt,
          threadId: storyThreadRuns.threadId, runOrder: storyThreadRuns.runOrder,
        }).from(sessions)
          .leftJoin(storyThreadRuns, and(eq(storyThreadRuns.jobId, sessions.id),
            eq(storyThreadRuns.ownerUserId, sessions.ownerUserId)))
          .leftJoin(storyThreads, and(eq(storyThreads.id, storyThreadRuns.threadId),
            eq(storyThreads.ownerUserId, sessions.ownerUserId)))
          .where(eq(sessions.ownerUserId, owner))
          .orderBy(desc(sessions.updatedAt)).limit(60).all()
        // Internal recovery runs and ordinary sequential follow-ups are
        // executions of one visible Thread, not duplicate dashboard items.
        const latest = new Map<string, typeof sessionRows[number]>()
        for (const row of sessionRows) {
          const key = row.threadId ? 'thread:' + row.threadId : 'job:' + row.id
          const prior = latest.get(key)
          if (!prior || (row.runOrder ?? -1) > (prior.runOrder ?? -1))
            latest.set(key, row)
        }
        const recentSessions = [...latest.values()]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 20).map(({ runOrder: _runOrder, ...session }) => session)
        return {
          repositories: repoRows,
          stories: storyRows,
          activeJobs: recentSessions.filter(row =>
            row.status === 'running' || row.status === 'paused' || row.status === 'blocked'),
          recentSessions,
        }
      },
    },
    settings: {
      async getDefaultModel(owner) {
        assertOwner(owner)
        const row = db.select({ value: userPreferences.defaultModelJson })
          .from(userPreferences).where(eq(userPreferences.ownerUserId, owner)).get()
        return row?.value ? { selection: JSON.parse(row.value) as unknown } : null
      },
      async putDefaultModel(owner, model, updatedAt) {
        assertOwner(owner)
        const defaultModelJson = model === null ? null : JSON.stringify(model)
        db.insert(userPreferences).values({
          ownerUserId: owner, defaultModelJson, updatedAt,
        }).onConflictDoUpdate({
          target: userPreferences.ownerUserId,
          set: { defaultModelJson, updatedAt },
        }).run()
      },
      async listRepositories(owner) {
        assertOwner(owner)
        return db.select({
          id: repositories.id, provider: repositories.provider, name: repositories.name,
          connectionId: repositories.connectionId,
        }).from(repositories).where(eq(repositories.ownerUserId, owner))
          .orderBy(repositories.provider, repositories.name).all()
      },
      async hasLegacyRepositories(owner, provider) {
        assertOwner(owner)
        return !!db.select({ id: repositories.id }).from(repositories)
          .where(and(eq(repositories.ownerUserId, owner), eq(repositories.provider, provider),
            isNull(repositories.connectionId))).limit(1).get()
      },
      async getThreadPreferences(owner, storyId) {
        assertOwner(owner)
        const row = db.select({
          view: storyThreadPreferences.viewMode, expanded: storyThreadPreferences.expandedIdsJson,
        }).from(storyThreadPreferences).where(and(eq(storyThreadPreferences.ownerUserId, owner),
          eq(storyThreadPreferences.storyId, storyId))).get()
        return row ? { view: row.view, expandedIds: JSON.parse(row.expanded) as string[] } : null
      },
      async putThreadPreferences(owner, storyId, view, expandedIds, updatedAt) {
        assertOwner(owner)
        const expandedIdsJson = JSON.stringify(expandedIds)
        db.insert(storyThreadPreferences).values({
          ownerUserId: owner, storyId, viewMode: view, expandedIdsJson, updatedAt,
        }).onConflictDoUpdate({
          target: [storyThreadPreferences.ownerUserId, storyThreadPreferences.storyId],
          set: { viewMode: view, expandedIdsJson, updatedAt },
        }).run()
      },
    },
  }
}
