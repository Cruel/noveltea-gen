import { openKyselyDatabase, type DatabaseOptions } from '../../src/db/kysely-connection'
import { drainProofQueue, type ProofDb } from './kysely-proof'

const db = openKyselyDatabase<ProofDb>(JSON.parse(process.env.NT_KYSELY_WORKER_OPTIONS!) as DatabaseOptions)
try {
  // Parent releases all four workers together after each has started.
  process.send?.('ready')
  await new Promise<void>((resolve) => process.once('message', () => resolve()))
  await drainProofQueue(db)
} finally {
  await db.close()
  process.disconnect?.()
}
