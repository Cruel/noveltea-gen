import type { SharedDatabase } from '../db/kysely-connection'
import type { StudioDb } from '../db/studio-db'
import type {
  DashboardCatalog, DashboardJob, SettingsPreferences,
} from './contracts'

function required(owner: string): void {
  if (!owner) throw new Error('Authenticated actor required')
}

/** Shared owner-scoped dashboard and navigation preference queries. No
 * Conversation entity is required: runs are folded into their owning Thread. */
export function createKyselyCatalogPersistence(db: SharedDatabase<StudioDb>): {
  dashboard: DashboardCatalog
  settings: SettingsPreferences
} {
  const dashboard: DashboardCatalog = {
    async forOwner(owner) {
      required(owner)
      const [repositories, stories, sessionRows, selection] = await Promise.all([
        db.read.selectFrom('repositories').select(['id', 'name', 'provider'])
          .where('ownerUserId', '=', owner).execute(),
        db.read.selectFrom('stories')
          .select(['id', 'title', 'repositoryId', 'directory', 'sourceCommitSha as commitSha'])
          .where('ownerUserId', '=', owner).execute(),
        db.read.selectFrom('studioSessions')
          .leftJoin('storyThreadRuns', (join) => join
            .onRef('storyThreadRuns.jobId', '=', 'studioSessions.id')
            .onRef('storyThreadRuns.ownerUserId', '=', 'studioSessions.ownerUserId'))
          .select([
            'studioSessions.id as id', 'studioSessions.storyId as storyId',
            'studioSessions.title as title', 'studioSessions.status as status',
            'studioSessions.updatedAt as updatedAt',
            'storyThreadRuns.threadId as threadId', 'storyThreadRuns.runOrder as runOrder',
          ])
          .where('studioSessions.ownerUserId', '=', owner)
          .orderBy('studioSessions.updatedAt', 'desc').limit(60).execute(),
        db.read.selectFrom('userStorySelection').select('storyId')
          .where('ownerUserId', '=', owner).executeTakeFirst(),
      ])
      const latest = new Map<string, typeof sessionRows[number]>()
      for (const row of sessionRows) {
        const key = row.threadId ? 'thread:' + row.threadId : 'job:' + row.id
        const prior = latest.get(key)
        if (!prior || (row.runOrder ?? -1) > (prior.runOrder ?? -1))
          latest.set(key, row)
      }
      const recentSessions: DashboardJob[] = [...latest.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 20)
        .map(row => ({
          id: row.id, storyId: row.storyId, title: row.title,
          status: row.status as DashboardJob['status'],
          updatedAt: row.updatedAt, threadId: row.threadId,
        }))
      return {
        repositories: repositories.map(row => ({
          ...row, provider: row.provider as 'github' | 'gitlab',
        })),
        stories,
        selectedStoryId: selection?.storyId ?? null,
        activeJobs: recentSessions.filter(row =>
          row.status === 'running' || row.status === 'paused' || row.status === 'blocked'),
        recentSessions,
      }
    },
  }
  const settings: SettingsPreferences = {
    async getDefaultModel(owner) {
      required(owner)
      const row = await db.read.selectFrom('userPreferences').select('defaultModelJson')
        .where('ownerUserId', '=', owner).executeTakeFirst()
      return row?.defaultModelJson ?
        { selection: JSON.parse(row.defaultModelJson) as unknown } : null
    },
    async putDefaultModel(owner, model, updatedAt) {
      required(owner)
      const defaultModelJson = model === null ? null : JSON.stringify(model)
      await db.withWriteTransaction([], async tx => {
        await tx.insertInto('userPreferences')
          .values({ ownerUserId: owner, defaultModelJson, updatedAt })
          .onConflict(oc => oc.column('ownerUserId')
            .doUpdateSet({ defaultModelJson, updatedAt }))
          .execute()
      })
    },
    async listRepositories(owner) {
      required(owner)
      const rows = await db.read.selectFrom('repositories')
        .select(['id', 'provider', 'name', 'connectionId'])
        .where('ownerUserId', '=', owner)
        .orderBy('provider').orderBy('name').execute()
      return rows.map(row => ({
        ...row, provider: row.provider as 'github' | 'gitlab',
      }))
    },
    async hasLegacyRepositories(owner, provider) {
      required(owner)
      return !!(await db.read.selectFrom('repositories').select('id')
        .where('ownerUserId', '=', owner).where('provider', '=', provider)
        .where('connectionId', 'is', null).executeTakeFirst())
    },
    async getThreadPreferences(owner, storyId) {
      required(owner)
      const row = await db.read.selectFrom('storyThreadPreferences')
        .select(['viewMode', 'expandedIdsJson', 'collapsedCollectionIdsJson'])
        .where('ownerUserId', '=', owner).where('storyId', '=', storyId)
        .executeTakeFirst()
      if (!row) return null
      const collections = await db.read.selectFrom('storyCollections').select('id')
        .where('ownerUserId', '=', owner).where('storyId', '=', storyId).execute()
      const collectionIds = new Set(collections.map(c => c.id))
      const collapsed = JSON.parse(row.collapsedCollectionIdsJson) as string[]
      return {
        view: row.viewMode as 'tree' | 'flat',
        expandedIds: JSON.parse(row.expandedIdsJson) as string[],
        collapsedCollectionIds: collapsed.filter(id => id === 'ungrouped' || collectionIds.has(id)),
      }
    },
    async putThreadPreferences(owner, storyId, view, expandedIds, updatedAt, collapsedCollectionIds) {
      required(owner)
      const expandedIdsJson = JSON.stringify(expandedIds)
      const collapsed = collapsedCollectionIds === undefined ? undefined :
        JSON.stringify(collapsedCollectionIds)
      await db.withWriteTransaction([], async tx => {
        await tx.insertInto('storyThreadPreferences').values({
          ownerUserId: owner, storyId, viewMode: view, expandedIdsJson,
          collapsedCollectionIdsJson: collapsed ?? '[]', updatedAt,
        }).onConflict(oc => oc.columns(['ownerUserId', 'storyId']).doUpdateSet({
          viewMode: view, expandedIdsJson, updatedAt,
          ...(collapsed === undefined ? {} : { collapsedCollectionIdsJson: collapsed }),
        })).execute()
      })
    },
  }
  return { dashboard, settings }
}
