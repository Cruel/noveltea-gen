import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { generationRunQueue, repositories, sessions, stories, storyThreadMessages, storyThreadRuns, storyThreads } from '../db/schema'
import type { NaturalStoryPersistence } from './natural-story-contracts'
import { creativePolicy, DEFAULT_CREATIVE_POLICY } from '../../../src/creative-policy'

type Db = BetterSQLite3Database<typeof schema>
const validOwner = (owner: string) => {
  if (!owner) throw new Error('Authenticated actor required.')
}

export function createSqliteNaturalStoryPersistence(db: Db): NaturalStoryPersistence {
  const selected = (owner: string, id: string) =>
    db.select({
      id: stories.id, storyId: stories.id,
      headSha: stories.sourceCommitSha, provider: repositories.provider,
    }).from(stories).innerJoin(repositories, and(
      eq(repositories.id, stories.repositoryId),
      eq(repositories.ownerUserId, stories.ownerUserId),
    )).where(and(eq(stories.id, id), eq(stories.ownerUserId, owner))).get() ?? null
  return {
    async story(owner, id) {
      validOwner(owner)
      return selected(owner, id)
    },
    async previousJob(owner, jobId) {
      validOwner(owner)
      return db.select({
        storyId: sessions.storyId, requestJson: sessions.generationRequestJson,
        configJson: sessions.generationConfigJson, threadId: storyThreadRuns.threadId,
      }).from(sessions).leftJoin(storyThreadRuns, and(
        eq(storyThreadRuns.jobId, sessions.id), eq(storyThreadRuns.ownerUserId, sessions.ownerUserId),
      )).where(and(eq(sessions.id, jobId), eq(sessions.ownerUserId, owner))).get() ?? null
    },
    async beginFirstTurn(owner, storyId, jobId, prompt, at, creativeMode) {
      validOwner(owner)
      const policyJson = JSON.stringify(creativeMode ? creativePolicy(creativeMode) : DEFAULT_CREATIVE_POLICY)
      return db.transaction(
        (tx) => {
          const member = selected(owner, storyId)
          if (!member) throw new Error('Story not found.')
          if (!member.headSha || !/^[a-f0-9]{40}$/i.test(member.headSha))
            throw new Error('Story has no verified source commit.')
          const threadId = 'root:' + jobId
          const thread = tx
            .select({
              owner: storyThreads.ownerUserId,
              storyId: storyThreads.storyId,
              parent: storyThreads.parentThreadId,
              deletedAt: storyThreads.deletedAt,
            })
            .from(storyThreads)
            .where(eq(storyThreads.id, threadId))
            .get()
          const existing = tx
            .select({
              id: storyThreadMessages.id,
              owner: storyThreadMessages.ownerUserId,
              threadId: storyThreadMessages.threadId,
              body: storyThreadMessages.body,
              base: storyThreadMessages.verifiedCommitSha,
              role: storyThreadMessages.role,
              phase: storyThreadMessages.phase,
              creativePolicyJson: storyThreadMessages.creativePolicyJson,
              creativeModeOverride: storyThreadMessages.creativeModeOverride,
            })
            .from(storyThreadMessages)
            .where(eq(storyThreadMessages.id, jobId))
            .get()
          if (thread) {
            if (
              thread.owner !== owner ||
              thread.storyId !== storyId ||
              thread.parent ||
              thread.deletedAt ||
              !existing ||
              existing.owner !== owner ||
              existing.threadId !== threadId ||
              existing.role !== 'user' ||
              existing.body !== prompt ||
              creativeMode !== undefined && (existing.creativePolicyJson !== policyJson ||
                existing.creativeModeOverride !== creativeMode)
            )
              throw new Error('Request ID already belongs to a different Story, Thread or message.')
            if (existing.base !== member.headSha)
              throw new Error(
                'The saved first Turn is pinned to another Story revision. Review the new source and start a new Thread.',
              )
          } else {
            if (existing || tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, jobId)).get())
              throw new Error('Request ID already belongs to another execution.')
            tx.insert(storyThreads)
              .values({
                id: threadId,
                ownerUserId: owner,
                storyId,
                title: prompt.slice(0, 120),
                creativePolicyJson: policyJson,
                activityAt: at,
                createdAt: at,
              })
              .run()
            // The first message is saved before credentials or Git/network work.
            // The fresh-schema trigger creates its durable Story Turn.
            tx.insert(storyThreadMessages)
              .values({
                id: jobId,
                ownerUserId: owner,
                threadId,
                sequence: 1,
                role: 'user',
                status: 'queued',
                body: prompt,
                creativePolicyJson: policyJson,
                creativeModeOverride: creativeMode ?? null,
                phase: 'preparing',
                verifiedCommitSha: member.headSha,
                createdAt: at,
              })
              .run()
            return { headSha: member.headSha, state: 'claimed' as const }
          }
          if (existing!.phase === 'running' || existing!.phase === 'finished')
            return { headSha: member.headSha, state: 'admitted' as const }
          if (existing!.phase === 'preparing') return { headSha: member.headSha, state: 'pending' as const }
          if (existing!.phase !== 'blocked')
            throw new Error(
              'The first Turn lifecycle is incompatible with a new admission. Inspect the saved Thread.',
            )
          // A retry after a known refusal is explicit; the same request identity
          // is reused and any partially prepared provider job is reconciled by
          // the pinned, idempotent launch path.
          tx.update(storyThreadMessages)
            .set({ phase: 'preparing' })
            .where(and(eq(storyThreadMessages.id, jobId), eq(storyThreadMessages.ownerUserId, owner)))
            .run()
          return { headSha: member.headSha, state: 'claimed' as const }
        },
        { behavior: 'immediate' },
      )
    },
    async finishFirstTurn(owner, storyId, jobId, admitted) {
      validOwner(owner)
      db.transaction(
        (tx) => {
          const threadId = 'root:' + jobId
          const message = tx
            .select({ phase: storyThreadMessages.phase })
            .from(storyThreadMessages)
            .innerJoin(storyThreads, eq(storyThreads.id, storyThreadMessages.threadId))
            .where(
              and(
                eq(storyThreadMessages.id, jobId),
                eq(storyThreadMessages.ownerUserId, owner),
                eq(storyThreadMessages.threadId, threadId),
                eq(storyThreads.storyId, storyId),
                eq(storyThreads.ownerUserId, owner),
              ),
            )
            .get()
          if (!message || (message.phase !== 'preparing' && message.phase !== 'running'))
            throw new Error('First Turn reservation changed; inspect the saved Thread.')
          if (
            admitted &&
            (!tx
              .select({ id: storyThreadRuns.jobId })
              .from(storyThreadRuns)
              .where(
                and(
                  eq(storyThreadRuns.jobId, jobId),
                  eq(storyThreadRuns.ownerUserId, owner),
                  eq(storyThreadRuns.threadId, threadId),
                ),
              )
              .get() ||
              !tx
                .select({ id: generationRunQueue.jobId })
                .from(generationRunQueue)
                .where(and(eq(generationRunQueue.jobId, jobId), eq(generationRunQueue.ownerUserId, owner)))
                .get())
          )
            throw new Error('First Turn execution was not durably admitted.')
          tx.update(storyThreadMessages)
            .set(
              admitted
                ? { phase: 'running', status: 'delivered', jobId }
                : { phase: 'blocked', status: 'queued' },
            )
            .where(and(eq(storyThreadMessages.id, jobId), eq(storyThreadMessages.ownerUserId, owner)))
            .run()
        },
        { behavior: 'immediate' },
      )
    },
    async associateRoot(owner, storyId, jobId, title, at) {
      validOwner(owner)
      return db.transaction(tx => {
        const member = selected(owner, storyId)
        if (!member) throw new Error('Story not found.')
        if (!member.headSha || !/^[a-f0-9]{40}$/i.test(member.headSha))
          throw new Error('Story has no verified source commit.')
        const threadId = 'root:' + jobId
        const row = tx.select({ parentId: storyThreads.parentThreadId, deletedAt: storyThreads.deletedAt })
          .from(storyThreads).innerJoin(storyThreadRuns, and(
            eq(storyThreadRuns.threadId, storyThreads.id),
            eq(storyThreadRuns.ownerUserId, storyThreads.ownerUserId),
          )).innerJoin(sessions, and(
            eq(sessions.id, storyThreadRuns.jobId),
            eq(sessions.ownerUserId, storyThreadRuns.ownerUserId),
          )).where(and(eq(storyThreads.id, threadId), eq(storyThreads.storyId, storyId),
            eq(storyThreads.ownerUserId, owner), eq(storyThreadRuns.jobId, jobId),
            eq(storyThreadRuns.runOrder, 0), eq(sessions.storyId, storyId))).get()
        if (!row || row.deletedAt || row.parentId)
          throw new Error('Generation job already belongs to another Thread or Story.')
        tx.update(storyThreads).set({ title: title.slice(0, 120), activityAt: at })
          .where(and(eq(storyThreads.id, threadId), eq(storyThreads.ownerUserId, owner))).run()
        return threadId
      }, { behavior: 'immediate' })
    },
  }
}
