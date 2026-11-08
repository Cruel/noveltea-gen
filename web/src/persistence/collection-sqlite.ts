import { and, eq, isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import {
  stories,
  storyThreads,
  storyCollections,
  storyCollectionMemberships,
  userStorySelection,
} from '../db/schema'
import type { CollectionCatalog } from './collection-contracts'

type Db = BetterSQLite3Database<typeof schema>

function required(owner: string) {
  if (!owner) throw new Error('Authenticated actor required.')
}
export function createSqliteCollectionCatalog(db: Db): CollectionCatalog {
  const selected = (owner: string, storyId: string) =>
    db
      .select({ id: stories.id })
      .from(stories)
      .where(and(eq(stories.id, storyId), eq(stories.ownerUserId, owner)))
      .get()
  return {
    async list(owner, storyId) {
      required(owner)
      if (!selected(owner, storyId)) throw new Error('Story not found.')
      return db
        .select({
          id: storyCollections.id,
          storyId: storyCollections.storyId,
          name: storyCollections.name,
          createdAt: storyCollections.createdAt,
          updatedAt: storyCollections.updatedAt,
        })
        .from(storyCollections)
        .where(and(eq(storyCollections.ownerUserId, owner), eq(storyCollections.storyId, storyId)))
        .orderBy(storyCollections.name, storyCollections.id)
        .all()
    },
    async create(owner, storyId, id, name, at) {
      required(owner)
      if (!selected(owner, storyId)) throw new Error('Story not found.')
      const row = { id, ownerUserId: owner, storyId, name, createdAt: at, updatedAt: at }
      db.insert(storyCollections).values(row).run()
      return { id, storyId, name, createdAt: at, updatedAt: at }
    },
    async rename(owner, storyId, id, name, at) {
      required(owner)
      return (
        db
          .update(storyCollections)
          .set({ name, updatedAt: at })
          .where(
            and(
              eq(storyCollections.id, id),
              eq(storyCollections.ownerUserId, owner),
              eq(storyCollections.storyId, storyId),
            ),
          )
          .run().changes === 1
      )
    },
    async remove(owner, storyId, id) {
      required(owner)
      // The composite FK cascades only into membership rows. No Thread row is
      // reparented and there is no execution/worktree mutation.
      return (
        db
          .delete(storyCollections)
          .where(
            and(
              eq(storyCollections.id, id),
              eq(storyCollections.ownerUserId, owner),
              eq(storyCollections.storyId, storyId),
            ),
          )
          .run().changes === 1
      )
    },
    async assign(owner, storyId, threadId, collectionId) {
      required(owner)
      return db.transaction(
        (tx) => {
          const thread = tx
            .select({ id: storyThreads.id })
            .from(storyThreads)
            .where(
              and(
                eq(storyThreads.id, threadId),
                eq(storyThreads.ownerUserId, owner),
                eq(storyThreads.storyId, storyId),
                isNull(storyThreads.deletedAt),
              ),
            )
            .get()
          if (!thread) return false
          if (collectionId === null) {
            tx.delete(storyCollectionMemberships)
              .where(
                and(
                  eq(storyCollectionMemberships.threadId, threadId),
                  eq(storyCollectionMemberships.ownerUserId, owner),
                  eq(storyCollectionMemberships.storyId, storyId),
                ),
              )
              .run()
            return true
          }
          const collection = tx
            .select({ id: storyCollections.id })
            .from(storyCollections)
            .where(
              and(
                eq(storyCollections.id, collectionId),
                eq(storyCollections.ownerUserId, owner),
                eq(storyCollections.storyId, storyId),
              ),
            )
            .get()
          if (!collection) return false
          tx.insert(storyCollectionMemberships)
            .values({
              threadId,
              ownerUserId: owner,
              storyId,
              collectionId,
            })
            .onConflictDoUpdate({
              target: storyCollectionMemberships.threadId,
              set: { collectionId },
              setWhere: and(
                eq(storyCollectionMemberships.ownerUserId, owner),
                eq(storyCollectionMemberships.storyId, storyId),
              ),
            })
            .run()
          return true
        },
        { behavior: 'immediate' },
      )
    },
    async chooseStory(owner, storyId, at) {
      required(owner)
      if (!selected(owner, storyId)) throw new Error('Story not found.')
      db.insert(userStorySelection)
        .values({ ownerUserId: owner, storyId, updatedAt: at })
        .onConflictDoUpdate({ target: userStorySelection.ownerUserId, set: { storyId, updatedAt: at } })
        .run()
    },
    async selectedStory(owner) {
      required(owner)
      return (
        db
          .select({ storyId: userStorySelection.storyId })
          .from(userStorySelection)
          .where(eq(userStorySelection.ownerUserId, owner))
          .get()?.storyId ?? null
      )
    },
  }
}
