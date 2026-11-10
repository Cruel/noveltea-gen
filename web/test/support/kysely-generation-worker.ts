import { openKyselyDatabase, type DatabaseOptions } from '../../src/db/kysely-connection'
import type { StudioDb } from '../../src/db/studio-db'
import { createKyselyGenerationPersistence } from '../../src/persistence/generation-kysely'

type Generation = ReturnType<typeof createKyselyGenerationPersistence>
type Operation = 'claim' | 'finish' | 'interrupt' | 'enqueue' | 'reconcileAndEnqueue' | 'start' | 'finishJob'
const input = JSON.parse(process.env.NT_GENERATION_WORKER_INPUT!) as {
  options: DatabaseOptions; operation: Operation; args: unknown[]
}
const db = openKyselyDatabase<StudioDb>(input.options)
const generation: Generation = createKyselyGenerationPersistence(db)
try {
  let result: unknown
  switch (input.operation) {
    case 'claim':
      result = await generation.queue.claim(...input.args as Parameters<Generation['queue']['claim']>)
      break
    case 'finish':
      result = await generation.queue.finish(...input.args as Parameters<Generation['queue']['finish']>)
      break
    case 'interrupt':
      result = await generation.queue.interrupt(...input.args as Parameters<Generation['queue']['interrupt']>)
      break
    case 'enqueue':
      result = await generation.queue.enqueue(...input.args as Parameters<Generation['queue']['enqueue']>)
      break
    case 'reconcileAndEnqueue':
      result = await generation.queue.reconcileAndEnqueue(
        ...input.args as Parameters<Generation['queue']['reconcileAndEnqueue']>)
      break
    case 'start':
      result = await generation.jobs.start(...input.args as Parameters<Generation['jobs']['start']>)
      break
    case 'finishJob':
      result = await generation.jobs.finish(...input.args as Parameters<Generation['jobs']['finish']>)
      break
  }
  process.stdout.write(JSON.stringify({ ok: true, result: result ?? null }) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false, error: error instanceof Error ? error.message : String(error),
  }) + '\n')
} finally {
  await db.close()
}
