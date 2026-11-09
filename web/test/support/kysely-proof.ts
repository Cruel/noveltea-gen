import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { Generated } from 'kysely'
import type { SharedDatabase } from '../../src/db/kysely-connection'

export interface ProofDb {
  proofQueue: { id: number; phase: string }
  proofMessages: { sequence: number; threadId: string; jobId: number }
  proofChildren: { id: string; intent: string }
  proofEvents: { id: Generated<number>; jobId: string; body: string }
}

/** Small Gate 0 proof algorithm, not a second Studio domain repository. */
export async function drainProofQueue(db: SharedDatabase<ProofDb>): Promise<number[]> {
  const claims: number[] = []
  for (;;) {
    const id = await db.withWriteTransaction([{ kind: 'thread', id: 'thread' }], async (tx) => {
      const running = await tx.selectFrom('proofQueue').select('id').where('phase', '=', 'running').execute()
      assert.ok(running.length <= 3)
      if (running.length === 3) return null
      const next = await tx
        .selectFrom('proofQueue')
        .select('id')
        .where('phase', '=', 'queued')
        .orderBy('id')
        .executeTakeFirst()
      if (!next) return undefined
      await tx.updateTable('proofQueue').set({ phase: 'running' }).where('id', '=', next.id).execute()
      const last = await tx
        .selectFrom('proofMessages')
        .select('sequence')
        .where('threadId', '=', 'thread')
        .orderBy('sequence', 'desc')
        .executeTakeFirst()
      await tx
        .insertInto('proofMessages')
        .values({ threadId: 'thread', sequence: (last?.sequence ?? 0) + 1, jobId: next.id })
        .execute()
      return next.id
    })
    if (id === undefined) break
    if (id === null) {
      await delay(1)
      continue
    }
    claims.push(id)
    await delay(1)
    await db.withWriteTransaction([], (tx) =>
      tx.updateTable('proofQueue').set({ phase: 'finished' }).where('id', '=', id).execute(),
    )
  }
  return claims
}
