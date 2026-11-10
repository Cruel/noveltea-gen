import { randomUUID } from 'node:crypto'
import type { Transaction } from 'kysely'
import type { StudioDb } from '../db/studio-db'
import { nextThreadSequenceKysely } from './thread-message-kysely'

/** The continuation and public Steering ports share these transaction-scoped
 * operations. Neither may acquire another connection inside a recovery write. */
export async function deferUndeliveredSteeringKysely(
  tx: Transaction<StudioDb>, owner: string, jobId: string,
): Promise<void> {
  if (!owner) throw new Error('Authenticated owner required.')
  await tx.updateTable('threadLiveInputs').set({ state: 'deferred' })
    .where('ownerUserId', '=', owner).where('sourceJobId', '=', jobId)
    .where('state', '=', 'pending').execute()
  const stuck = await tx.selectFrom('threadLiveInputs').select('messageId')
    .where('ownerUserId', '=', owner).where('sourceJobId', '=', jobId)
    .where('state', 'in', ['dispatching', 'sdk-queued']).execute()
  for (const row of stuck) {
    await tx.updateTable('threadLiveInputs').set({ state: 'blocked' })
      .where('messageId', '=', row.messageId).where('ownerUserId', '=', owner)
      .where('sourceJobId', '=', jobId).where('state', 'in', ['dispatching', 'sdk-queued'])
      .execute()
    await tx.updateTable('storyThreadMessages').set({ phase: 'blocked' })
      .where('id', '=', row.messageId).where('ownerUserId', '=', owner)
      .where('phase', '=', 'queued').execute()
  }
}

export async function boundarySteeringReviewsKysely(
  tx: Transaction<StudioDb>, owner: string, jobId: string,
  threadId: string, verifiedHead: string, at: string,
): Promise<number> {
  if (!owner) throw new Error('Authenticated owner required.')
  if (!/^[a-f0-9]{40}$/.test(verifiedHead)) return 0
  const rows = await tx.selectFrom('threadSteeringIntents as i')
    .innerJoin('storyThreadMessages as m', join => join
      .onRef('m.id', '=', 'i.messageId').onRef('m.ownerUserId', '=', 'i.ownerUserId')
      .onRef('m.threadId', '=', 'i.threadId'))
    .innerJoin('generationRunQueue as q', join => join
      .onRef('q.jobId', '=', 'i.sourceJobId').onRef('q.ownerUserId', '=', 'i.ownerUserId'))
    .innerJoin('studioSessions as s', join => join
      .onRef('s.id', '=', 'i.sourceJobId').onRef('s.ownerUserId', '=', 'i.ownerUserId'))
    .select(['i.messageId as id', 'm.body as content'])
    .where('i.ownerUserId', '=', owner).where('i.sourceJobId', '=', jobId)
    .where('i.threadId', '=', threadId).where('i.reviewState', '=', 'pending-boundary')
    .where('i.reviewMessageId', 'is', null)
    .where('i.disposition', 'in', ['scope-review', 'protected-review'])
    .where('q.phase', '=', 'finished').where('s.status', '=', 'completed')
    .where('m.status', '=', 'delivered').orderBy('m.sequence').execute()
  for (const row of rows) {
    const id = randomUUID()
    await tx.insertInto('storyThreadMessages').values({
      id, ownerUserId: owner, threadId, sequence: await nextThreadSequenceKysely(tx, threadId),
      role: 'user', status: 'queued', body: row.content,
      originMessageId: row.id, phase: 'queued', createdAt: at,
    }).execute()
    const updated = await tx.updateTable('threadSteeringIntents').set({
      reviewMessageId: id, reviewState: 'awaiting-review',
    }).where('messageId', '=', row.id).where('ownerUserId', '=', owner)
      .where('threadId', '=', threadId).where('reviewState', '=', 'pending-boundary')
      .where('reviewMessageId', 'is', null).executeTakeFirst()
    if (Number(updated.numUpdatedRows) !== 1)
      throw new Error('Steering boundary review was already claimed')
  }
  return rows.length
}
