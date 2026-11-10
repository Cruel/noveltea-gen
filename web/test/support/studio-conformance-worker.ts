import { openSharedStudioStore } from '../../src/db/shared-studio-store'
import { openKyselyDatabase, type DatabaseOptions } from '../../src/db/kysely-connection'
import type { StudioDb } from '../../src/db/studio-db'

/** An independent OS process, not a shared in-memory test adapter. */
type Input = {
  options: DatabaseOptions
  operation: 'claim' | 'hold-uncommitted-job-update' | 'probe-lock' | 'author-decision'
  workerId: string
  owner?: string
  jobId?: string
  limit?: number
}
const input = JSON.parse(process.env.NT_STUDIO_CERT_WORKER_INPUT!) as Input
const at = '2026-11-10T12:00:00Z'

if (input.operation === 'claim') {
  const store = openSharedStudioStore(input.options)
  try {
    await store.assertReady()
    const result = await store.persistence.generation.queue.claim(input.workerId, input.limit ?? 2, at)
    process.send?.({ type: 'result', result })
  } finally {
    await store.close()
    process.disconnect?.()
  }
} else if (input.operation === 'author-decision') {
  if (!input.jobId || !input.owner) throw new Error('Decision requires job and owner')
  const store = openSharedStudioStore(input.options)
  try {
    await store.assertReady()
    process.send?.({ type: 'ready' })
    await store.persistence.generation.jobs.authorDecision(input.owner, input.jobId, 'blocked', at)
    process.send?.({ type: 'result', result: true })
  } finally {
    await store.close()
    process.disconnect?.()
  }
} else {
  if (!input.jobId) throw new Error('Crash worker requires a job identity')
  // Explicit transaction fault injector: only the backend test helper may
  // access the transaction executor. The witness is read through StudioStore.
  const database = openKyselyDatabase<StudioDb>(input.operation === 'probe-lock'
    ? { ...input.options, maxAttempts: 1,
        ...(input.options.backend === 'sqlite' ? { busyTimeoutMs: 50 } : {}) }
    : input.options)
  try {
    if (input.operation === 'probe-lock') {
      try {
        await database.withWriteTransaction([{ kind: 'job', id: input.jobId }], async tx => {
          await tx.updateTable('studioSessions').set({ status: 'blocked' })
            .where('id', '=', input.jobId!).execute()
        })
        process.send?.({ type: 'probe', blocked: false })
      } catch (error) {
        process.send?.({ type: 'probe', blocked: true,
          code: (error as { code?: string }).code, error: String(error) })
      }
    } else {
      await database.withWriteTransaction([{ kind: 'job', id: input.jobId }], async tx => {
      const result = await tx.updateTable('studioSessions')
        .set({ status: 'cancelled' })
        .where('id', '=', input.jobId!)
        .executeTakeFirst()
      if (Number(result.numUpdatedRows) !== 1) throw new Error('Missing crash witness job')
      // An unresolved Promise does not keep Node alive. Keep the process and
      // open transaction alive until the parent explicitly sends SIGKILL.
      const keepalive = setInterval(() => {}, 1_000)
      process.send?.({ type: 'uncommitted' })
      try {
        await new Promise<void>(() => {})
      } finally {
        clearInterval(keepalive)
      }
      })
    }
  } finally {
    await database.close()
    process.disconnect?.()
  }
}
