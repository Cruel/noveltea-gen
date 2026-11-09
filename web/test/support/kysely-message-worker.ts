/** Independent-process fixture for SQLite/PG message write contention.
 * Never prints connection options or credentials. */
import { randomUUID } from 'node:crypto'
import { openKyselyDatabase, type DatabaseOptions } from '../../src/db/kysely-connection'
import type { StudioDb } from '../../src/db/studio-db'
import { createKyselyThreadMessages } from '../../src/persistence/thread-message-kysely'

type Input = {
  options: DatabaseOptions
  owner: string
  threadId: string
  kind: 'batch' | 'edit'
  label: string
  count?: number
  id?: string
  requestId?: string
  expected?: string
  replacement?: string
}
const input = JSON.parse(process.env.NT_MESSAGE_WORKER_INPUT ?? 'null') as Input
if (!input?.options || !input.owner || !input.threadId) throw new Error('Missing test worker input')
const db = openKyselyDatabase<StudioDb>(input.options)
try {
  const messages = createKyselyThreadMessages(db)
  if (input.kind === 'batch') {
    const sent = []
    for (let i = 0; i < (input.count ?? 0); i++) {
      const id = randomUUID()
      const row = await messages.enqueue(input.owner, input.threadId, id,
        input.label + ':' + i, undefined, '2026-11-09T12:00:00Z')
      sent.push({ id, sequence: row.sequence })
    }
    process.stdout.write(JSON.stringify({ ok: true, sent }) + '\n')
  } else {
    try {
      const result = await messages.edit(input.owner, input.threadId, input.id!,
        input.requestId!, input.expected!, input.replacement!, '2026-11-09T13:00:00Z')
      process.stdout.write(JSON.stringify({ ok: true, content: result.content }) + '\n')
    } catch (error) {
      process.stdout.write(JSON.stringify({
        ok: false,
        status: (error as { status?: number }).status,
        message: error instanceof Error ? error.message : 'Unknown',
      }) + '\n')
    }
  }
} finally {
  await db.close()
}
