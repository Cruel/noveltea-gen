import { openKyselyDatabase, type DatabaseOptions } from '../../src/db/kysely-connection'
import type { StudioDb } from '../../src/db/studio-db'
import { createKyselyAdvancedThreads } from '../../src/persistence/advanced-thread-kysely'
import type {
  ForkReservation, NewThreadChild, RecoveryContinuationRegistration, RestartReservation,
} from '../../src/persistence/advanced-thread-contracts'

async function main() {
  const input = JSON.parse(process.env.NT_ADVANCED_WORKER_INPUT ?? '{}') as {
    options: DatabaseOptions
    method: 'reserveFork' | 'registerChild' | 'reserveRestart' | 'registerRecoveryContinuation'
    data: ForkReservation & NewThreadChild & RestartReservation & RecoveryContinuationRegistration
  }
  const db = openKyselyDatabase<StudioDb>(input.options)
  try {
    const advanced = createKyselyAdvancedThreads(db)
    try {
      const result = await advanced[input.method](input.data)
      process.stdout.write(JSON.stringify({ ok: true, result }) + '\n')
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, message: (error as Error).message }) + '\n')
    }
  } finally { await db.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
