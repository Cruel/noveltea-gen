import { openKyselyDatabase, type DatabaseOptions } from '../../src/db/kysely-connection'
import type { StudioDb } from '../../src/db/studio-db'
import { createKyselyContinuationPersistence } from '../../src/persistence/continuation-kysely'

type Continuation = ReturnType<typeof createKyselyContinuationPersistence>
type Operation = 'claim' | 'beginFollowUp' | 'protectedFinish' | 'settle' | 'block'
const input = JSON.parse(process.env.NT_CONTINUATION_WORKER_INPUT!) as {
  options: DatabaseOptions; operation: Operation; args: unknown[]
}
const db = openKyselyDatabase<StudioDb>(input.options)
const continuation: Continuation = createKyselyContinuationPersistence(db)
try {
  let result: unknown
  switch (input.operation) {
    case 'claim':
      result = await continuation.claim(...input.args as Parameters<Continuation['claim']>)
      break
    case 'beginFollowUp':
      result = await continuation.beginFollowUp(...input.args as Parameters<Continuation['beginFollowUp']>)
      break
    case 'protectedFinish':
      result = await continuation.protectedFinish(...input.args as Parameters<Continuation['protectedFinish']>)
      break
    case 'settle':
      result = await continuation.settle(...input.args as Parameters<Continuation['settle']>)
      break
    case 'block':
      result = await continuation.block(...input.args as Parameters<Continuation['block']>)
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
