import type { Transaction } from 'kysely'
import type { QueryExecutor, SharedDatabase } from '../db/kysely-connection'
import type { StudioDb } from '../db/studio-db'
import type { NaturalStoryPersistence } from './natural-story-contracts'
import { creativePolicy, DEFAULT_CREATIVE_POLICY } from '../../../src/creative-policy'

type Read = QueryExecutor<StudioDb>
type Write = Transaction<StudioDb>

function required(owner: string): void {
  if (!owner) throw new Error('Authenticated actor required.')
}

async function selected(db: Read | Write, owner: string, storyId: string) {
  const row = await db.selectFrom('stories')
    .innerJoin('repositories', (join) => join
      .onRef('repositories.id', '=', 'stories.repositoryId')
      .onRef('repositories.ownerUserId', '=', 'stories.ownerUserId'))
    .select([
      'stories.id as id', 'stories.id as storyId', 'stories.repositoryId as repositoryId',
      'stories.sourceCommitSha as headSha', 'stories.title as title',
      'stories.initialContentSha256 as initialContentSha256',
      'repositories.provider as provider', 'repositories.providerRepositoryId as providerId',
      'stories.directory as directory',
    ])
    .where('stories.id', '=', storyId)
    .where('stories.ownerUserId', '=', owner)
    .executeTakeFirst()
  return row ? {
    ...row,
    provider: row.provider as 'github' | 'gitlab',
  } : null
}

/** Shared Story-first admission path. The trigger creating Story Turn records
 * and all request identity checks execute inside the same write transaction;
 * no helper reopens a root connection. Staged until the coordinated cutover. */
export function createKyselyNaturalStoryPersistence(db: SharedDatabase<StudioDb>): NaturalStoryPersistence {
  return {
    async story(owner, storyId) {
      required(owner)
      return selected(db.read, owner, storyId)
    },
    async originalInitializationJob(owner, storyId) {
      required(owner)
      // GitHub initialization commits its Story registration and original job
      // with the same creation timestamp in one transaction. An ambiguous
      // historical match is not reusable authorization.
      const rows = await db.read.selectFrom('stories as st')
        .innerJoin('studioSessions as s', join => join
          .onRef('s.storyId', '=', 'st.id')
          .onRef('s.ownerUserId', '=', 'st.ownerUserId')
          .onRef('s.createdAt', '=', 'st.createdAt')
          .onRef('s.sourceCommitSha', '=', 'st.sourceCommitSha'))
        .select(['s.id as jobId'])
        .where('st.id', '=', storyId).where('st.ownerUserId', '=', owner)
        .where('s.generationRequestJson', 'is', null)
        .limit(2).execute()
      return rows.length === 1 ? rows[0]!.jobId : null
    },
    async previousJob(owner, jobId) {
      required(owner)
      const row = await db.read.selectFrom('studioSessions')
        .leftJoin('storyThreadRuns', (join) => join
          .onRef('storyThreadRuns.jobId', '=', 'studioSessions.id')
          .onRef('storyThreadRuns.ownerUserId', '=', 'studioSessions.ownerUserId'))
        .select([
          'studioSessions.storyId as storyId',
          'studioSessions.generationRequestJson as requestJson',
          'studioSessions.generationConfigJson as configJson',
          'storyThreadRuns.threadId as threadId',
        ])
        .where('studioSessions.id', '=', jobId)
        .where('studioSessions.ownerUserId', '=', owner)
        .executeTakeFirst()
      return row ?? null
    },
    async beginFirstTurn(owner, storyId, jobId, prompt, at, creativeMode) {
      required(owner)
      const policyJson = JSON.stringify(
        creativeMode ? creativePolicy(creativeMode) : DEFAULT_CREATIVE_POLICY,
      )
      return db.withWriteTransaction([{ kind: 'job', id: jobId }], async (tx) => {
        const member = await selected(tx, owner, storyId)
        if (!member) throw new Error('Story not found.')
        if (!member.headSha || !/^[a-f0-9]{40}$/i.test(member.headSha))
          throw new Error('Story has no verified source commit.')
        const threadId = 'root:' + jobId
        const thread = await tx.selectFrom('storyThreads')
          .select(['ownerUserId as owner', 'storyId', 'parentThreadId as parent', 'deletedAt'])
          .where('id', '=', threadId)
          .executeTakeFirst()
        const existing = await tx.selectFrom('storyThreadMessages')
          .select([
            'id', 'ownerUserId as owner', 'threadId', 'body', 'verifiedCommitSha as base',
            'role', 'phase', 'creativePolicyJson', 'creativeModeOverride',
          ])
          .where('id', '=', jobId).executeTakeFirst()
        if (thread) {
          if (
            thread.owner !== owner || thread.storyId !== storyId || thread.parent ||
            thread.deletedAt || !existing || existing.owner !== owner ||
            existing.threadId !== threadId || existing.role !== 'user' ||
            existing.body !== prompt ||
            (creativeMode !== undefined && (existing.creativePolicyJson !== policyJson ||
              existing.creativeModeOverride !== creativeMode))
          ) throw new Error('Request ID already belongs to a different Story, Thread or message.')
          if (existing.base !== member.headSha)
            throw new Error(
              'The saved first Turn is pinned to another Story revision. Review the new source and start a new Thread.',
            )
        } else {
          const collision = await tx.selectFrom('studioSessions').select('id')
            .where('id', '=', jobId).executeTakeFirst()
          if (existing || collision)
            throw new Error('Request ID already belongs to another execution.')
          await tx.insertInto('storyThreads').values({
            id: threadId,
            ownerUserId: owner,
            storyId,
            title: prompt.slice(0, 120),
            creativePolicyJson: policyJson,
            activityAt: at,
            createdAt: at,
          }).execute()
          await tx.insertInto('storyThreadMessages').values({
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
          }).execute()
          return { headSha: member.headSha, state: 'claimed' as const }
        }
        if (existing!.phase === 'running' || existing!.phase === 'finished')
          return { headSha: member.headSha, state: 'admitted' as const }
        if (existing!.phase === 'preparing')
          return { headSha: member.headSha, state: 'pending' as const }
        if (existing!.phase !== 'blocked')
          throw new Error(
            'The first Turn lifecycle is incompatible with a new admission. Inspect the saved Thread.',
          )
        const accepted = await tx.selectFrom('generationRunQueue').select('jobId')
          .where('jobId', '=', jobId).where('ownerUserId', '=', owner).executeTakeFirst()
        if (accepted) {
          const linked = await tx.selectFrom('storyThreadRuns').select('jobId')
            .where('jobId', '=', jobId).where('ownerUserId', '=', owner)
            .where('threadId', '=', threadId).executeTakeFirst()
          if (!linked) throw new Error('Admitted first Turn has no linked execution.')
          await tx.updateTable('storyThreadMessages')
            .set({ phase: 'running', status: 'delivered', jobId })
            .where('id', '=', jobId).where('ownerUserId', '=', owner).execute()
          return { headSha: member.headSha, state: 'admitted' as const }
        }
        await tx.updateTable('storyThreadMessages').set({ phase: 'preparing' })
          .where('id', '=', jobId).where('ownerUserId', '=', owner).execute()
        return { headSha: member.headSha, state: 'claimed' as const }
      })
    },
    async finishFirstTurn(owner, storyId, jobId, admitted) {
      required(owner)
      await db.withWriteTransaction([{ kind: 'job', id: jobId }], async (tx) => {
        const threadId = 'root:' + jobId
        const message = await tx.selectFrom('storyThreadMessages')
          .innerJoin('storyThreads', 'storyThreads.id', 'storyThreadMessages.threadId')
          .select('storyThreadMessages.phase as phase')
          .where('storyThreadMessages.id', '=', jobId)
          .where('storyThreadMessages.ownerUserId', '=', owner)
          .where('storyThreadMessages.threadId', '=', threadId)
          .where('storyThreads.storyId', '=', storyId)
          .where('storyThreads.ownerUserId', '=', owner).executeTakeFirst()
        if (!message || (message.phase !== 'preparing' && message.phase !== 'running'))
          throw new Error('First Turn reservation changed; inspect the saved Thread.')
        const queue = await tx.selectFrom('generationRunQueue').select('jobId')
          .where('jobId', '=', jobId).where('ownerUserId', '=', owner).executeTakeFirst()
        const accepted = admitted || !!queue
        if (accepted) {
          const run = await tx.selectFrom('storyThreadRuns').select('jobId')
            .where('jobId', '=', jobId).where('ownerUserId', '=', owner)
            .where('threadId', '=', threadId).executeTakeFirst()
          if (!run || !queue) throw new Error('First Turn execution was not durably admitted.')
        }
        await tx.updateTable('storyThreadMessages')
          .set(accepted ? { phase: 'running', status: 'delivered', jobId } :
            { phase: 'blocked', status: 'queued' })
          .where('id', '=', jobId).where('ownerUserId', '=', owner).execute()
      })
    },
    async finishFoundationOnly(owner, storyId, jobId) {
      required(owner)
      await db.withWriteTransaction([{ kind: 'job', id: jobId }], async tx => {
        const threadId = 'root:' + jobId
        const saved = await tx.selectFrom('storyThreadMessages as m')
          .innerJoin('storyThreads as t', join => join.onRef('t.id', '=', 'm.threadId')
            .onRef('t.ownerUserId', '=', 'm.ownerUserId'))
          .innerJoin('storyThreadRuns as r', join => join.onRef('r.threadId', '=', 't.id')
            .onRef('r.ownerUserId', '=', 't.ownerUserId').onRef('r.jobId', '=', 'm.id'))
          .innerJoin('studioSessions as s', join => join.onRef('s.id', '=', 'r.jobId')
            .onRef('s.ownerUserId', '=', 'r.ownerUserId'))
          .select(['m.phase as phase', 'm.jobId as messageJobId',
            's.status as status', 's.generationRequestJson as requestJson'])
          .where('m.id', '=', jobId).where('m.ownerUserId', '=', owner)
          .where('m.threadId', '=', threadId).where('t.storyId', '=', storyId)
          .where('t.deletedAt', 'is', null).where('r.runOrder', '=', 0)
          .executeTakeFirst()
        const queue = await tx.selectFrom('generationRunQueue').select('jobId')
          .where('jobId', '=', jobId).where('ownerUserId', '=', owner).executeTakeFirst()
        if (!saved || queue || saved.requestJson ||
            (saved.phase === 'finished'
              ? saved.status !== 'completed' || saved.messageJobId !== jobId
              : saved.phase !== 'preparing' || saved.status !== 'paused'))
          throw new Error('Foundation-only completion has an incompatible saved execution.')
        if (saved.phase === 'finished') return
        await tx.updateTable('studioSessions').set({
          status: 'completed', updatedAt: new Date().toISOString(),
        }).where('id', '=', jobId).where('ownerUserId', '=', owner)
          .where('status', '=', 'paused').where('generationRequestJson', 'is', null).execute()
        await tx.updateTable('storyThreadMessages')
          .set({ phase: 'finished', status: 'delivered', jobId })
          .where('id', '=', jobId).where('ownerUserId', '=', owner)
          .where('phase', '=', 'preparing').execute()
      })
    },
    async associateRoot(owner, storyId, jobId, title, at) {
      required(owner)
      return db.withWriteTransaction([{ kind: 'job', id: jobId }], async (tx) => {
        const member = await selected(tx, owner, storyId)
        if (!member) throw new Error('Story not found.')
        if (!member.headSha || !/^[a-f0-9]{40}$/i.test(member.headSha))
          throw new Error('Story has no verified source commit.')
        const threadId = 'root:' + jobId
        const row = await tx.selectFrom('storyThreads')
          .innerJoin('storyThreadRuns', (join) => join
            .onRef('storyThreadRuns.threadId', '=', 'storyThreads.id')
            .onRef('storyThreadRuns.ownerUserId', '=', 'storyThreads.ownerUserId'))
          .innerJoin('studioSessions', (join) => join
            .onRef('studioSessions.id', '=', 'storyThreadRuns.jobId')
            .onRef('studioSessions.ownerUserId', '=', 'storyThreadRuns.ownerUserId'))
          .select(['storyThreads.parentThreadId', 'storyThreads.deletedAt'])
          .where('storyThreads.id', '=', threadId)
          .where('storyThreads.storyId', '=', storyId)
          .where('storyThreads.ownerUserId', '=', owner)
          .where('storyThreadRuns.jobId', '=', jobId)
          .where('storyThreadRuns.runOrder', '=', 0)
          .where('studioSessions.storyId', '=', storyId)
          .executeTakeFirst()
        if (!row || row.deletedAt || row.parentThreadId)
          throw new Error('Generation job already belongs to another Thread or Story.')
        await tx.updateTable('storyThreads').set({ title: title.slice(0, 120), activityAt: at })
          .where('id', '=', threadId).where('ownerUserId', '=', owner).execute()
        return threadId
      })
    },
  }
}
