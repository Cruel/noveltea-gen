import type { StudioDb } from '../db/studio-db'
import type { QueryExecutor, SharedDatabase } from '../db/kysely-connection'
import type { CollectionCatalog } from './collection-contracts'

type Read = QueryExecutor<StudioDb>

function required(owner: string): void {
  if (!owner) throw new Error('Authenticated actor required.')
}

async function ownedStory(db: Read, owner: string, storyId: string): Promise<boolean> {
  return !!(await db
    .selectFrom('stories')
    .select('id')
    .where('id', '=', storyId)
    .where('ownerUserId', '=', owner)
    .executeTakeFirst())
}

/** Isolated new-stack repository: do not combine this with Drizzle-backed
 * StudioPersistence until the atomic application cutover (#141).
 * All decisions and mutations run in the shared transaction executor.
 */
export function createKyselyCollectionCatalog(db: SharedDatabase<StudioDb>): CollectionCatalog {
  return {
    async list(owner, storyId) {
      required(owner)
      if (!(await ownedStory(db.read, owner, storyId))) throw new Error('Story not found.')
      return db.read
        .selectFrom('storyCollections')
        .select(['id', 'storyId', 'name', 'createdAt', 'updatedAt'])
        .where('ownerUserId', '=', owner)
        .where('storyId', '=', storyId)
        .orderBy('name')
        .orderBy('id')
        .execute()
    },
    async create(owner, storyId, id, name, at) {
      required(owner)
      return db.withWriteTransaction([], async (tx) => {
        if (!(await ownedStory(tx, owner, storyId))) throw new Error('Story not found.')
        await tx
          .insertInto('storyCollections')
          .values({
            id,
            ownerUserId: owner,
            storyId,
            name,
            createdAt: at,
            updatedAt: at,
          })
          .execute()
        return { id, storyId, name, createdAt: at, updatedAt: at }
      })
    },
    async rename(owner, storyId, id, name, at) {
      required(owner)
      return db.withWriteTransaction([], async (tx) => {
        const result = await tx
          .updateTable('storyCollections')
          .set({ name, updatedAt: at })
          .where('id', '=', id)
          .where('ownerUserId', '=', owner)
          .where('storyId', '=', storyId)
          .executeTakeFirst()
        return result.numUpdatedRows === 1n
      })
    },
    async remove(owner, storyId, id) {
      required(owner)
      return db.withWriteTransaction([], async (tx) => {
        // Membership cascades through the schema; Thread ancestry never changes.
        const result = await tx
          .deleteFrom('storyCollections')
          .where('id', '=', id)
          .where('ownerUserId', '=', owner)
          .where('storyId', '=', storyId)
          .executeTakeFirst()
        return result.numDeletedRows === 1n
      })
    },
    async assign(owner, storyId, threadId, collectionId) {
      required(owner)
      return db.withWriteTransaction([{ kind: 'thread', id: threadId }], async (tx) => {
        const thread = await tx
          .selectFrom('storyThreads')
          .select('id')
          .where('id', '=', threadId)
          .where('ownerUserId', '=', owner)
          .where('storyId', '=', storyId)
          .where('deletedAt', 'is', null)
          .executeTakeFirst()
        if (!thread) return false
        if (collectionId === null) {
          await tx
            .deleteFrom('storyCollectionMemberships')
            .where('threadId', '=', threadId)
            .where('ownerUserId', '=', owner)
            .where('storyId', '=', storyId)
            .execute()
          return true
        }
        const collection = await tx
          .selectFrom('storyCollections')
          .select('id')
          .where('id', '=', collectionId)
          .where('ownerUserId', '=', owner)
          .where('storyId', '=', storyId)
          .executeTakeFirst()
        if (!collection) return false
        await tx
          .insertInto('storyCollectionMemberships')
          .values({
            threadId,
            ownerUserId: owner,
            storyId,
            collectionId,
          })
          .onConflict((oc) =>
            oc
              .column('threadId')
              .doUpdateSet({ collectionId })
              .where('storyCollectionMemberships.ownerUserId', '=', owner)
              .where('storyCollectionMemberships.storyId', '=', storyId),
          )
          .execute()
        return true
      })
    },
    async chooseStory(owner, storyId, at) {
      required(owner)
      await db.withWriteTransaction([], async (tx) => {
        if (!(await ownedStory(tx, owner, storyId))) throw new Error('Story not found.')
        await tx
          .insertInto('userStorySelection')
          .values({
            ownerUserId: owner,
            storyId,
            updatedAt: at,
          })
          .onConflict((oc) => oc.column('ownerUserId').doUpdateSet({ storyId, updatedAt: at }))
          .execute()
      })
    },
    async selectedStory(owner) {
      required(owner)
      const row = await db.read
        .selectFrom('userStorySelection')
        .select('storyId')
        .where('ownerUserId', '=', owner)
        .executeTakeFirst()
      return row?.storyId ?? null
    },
  }
}
