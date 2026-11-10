import { openKyselyDatabase, type DatabaseOptions } from '../../src/db/kysely-connection'
import type { StudioDb } from '../../src/db/studio-db'
import { createKyselySteeringPersistence } from '../../src/persistence/steering-kysely'

type Steering = ReturnType<typeof createKyselySteeringPersistence>
type Operation = 'registerTurn' | 'closeTurn' | 'claim' | 'settle' | 'attribute' | 'recoverOrphaned'
type Payload = { options: DatabaseOptions; operation: Operation; args: unknown[] }
const input = JSON.parse(process.env.NT_STEERING_WORKER_INPUT!) as Payload
const db = openKyselyDatabase<StudioDb>(input.options)
const steering: Steering = createKyselySteeringPersistence(db)
try {
  let result: unknown
  switch (input.operation) {
    case 'registerTurn':
      result = await steering.registerTurn(...input.args as Parameters<Steering['registerTurn']>)
      break
    case 'closeTurn':
      result = await steering.closeTurn(...input.args as Parameters<Steering['closeTurn']>)
      break
    case 'claim':
      result = await steering.claim(...input.args as Parameters<Steering['claim']>)
      break
    case 'settle':
      result = await steering.settle(...input.args as Parameters<Steering['settle']>)
      break
    case 'attribute':
      result = await steering.attribute(...input.args as Parameters<Steering['attribute']>)
      break
    case 'recoverOrphaned':
      result = await steering.recoverOrphaned()
      break
  }
  process.stdout.write(JSON.stringify({ ok: true, result }) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false, error: error instanceof Error ? error.message : String(error),
  }) + '\n')
} finally {
  await db.close()
}
