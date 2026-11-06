import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { migrateStudio } from '../src/db/migrations'
import { archiveThread, listStoryConversations, restoreThread } from '../src/lib/threads.server'
import { cancelQueuedThreadMessage, editQueuedThreadMessage,
  enqueueThreadMessage, readThreadChat } from '../src/lib/thread-chat.server'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'thread-persistence-two-connection-test-secret',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}

/** Two real SQLite connections exercise the same public owner-scoped contract
 * the web and worker processes use, with no alternate test schema. */
test('Conversation and Thread writes serialize across Studio connections and survive reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noveltea-core-thread-db-'))
  const file = join(dir, 'studio.sqlite')
  const a = openStudioDatabase(file)
  const b = openStudioDatabase(file)
  try {
    await migrateStudio(a, config)
    const owner = randomUUID(), stranger = randomUUID()
    const repo = randomUUID(), story = randomUUID(), job = randomUUID()
    const seed = studioSeed(a)
    for (const id of [owner, stranger]) { await seed.user(id) }
    (await seed.repository({ id: repo, ownerUserId: owner, provider: 'github',
      providerRepositoryId: 'repo', name: 'Repository', createdAt: '2026-11-01T00:00:00Z' }))
    ;(await seed.story({ id: story, ownerUserId: owner, repositoryId: repo,
      directory: 'story', title: 'Story', createdAt: '2026-11-01T00:00:00Z' }))
    ;(await seed.job({ id: job, ownerUserId: owner, storyId: story, title: 'Initial run',
      status: 'completed', generationRequestJson: JSON.stringify({ task: 'Opening request', fixture: true }),
      createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z' }))
    ;(await seed.queue({ jobId: job, ownerUserId: owner, intent: 'start', phase: 'finished',
      createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z' }))

    // Independent requests reconcile the same legacy root exactly once.
    const [firstNav, secondNav] = await Promise.all([
      listStoryConversations(a, owner, story), listStoryConversations(b, owner, story),
    ])
    const threadId = firstNav.conversations[0]!.threads[0]!.id
    assert.equal(threadId, secondNav.conversations[0]!.threads[0]!.id)
    assert.equal(firstNav.conversations[0]!.threads.length, 1)
    assert.equal((await readThreadChat(b, owner, threadId)).messages[0]?.content, 'Opening request')

    const [one, two, three] = [randomUUID(), randomUUID(), randomUUID()]
    const [postedOne, postedTwo, postedThree] = await Promise.all([
      enqueueThreadMessage(a, owner, threadId, one, 'First edit'),
      enqueueThreadMessage(b, owner, threadId, two, 'Second edit'),
      enqueueThreadMessage(a, owner, threadId, three, 'Third edit'),
    ])
    assert.deepEqual([postedOne.sequence, postedTwo.sequence, postedThree.sequence], [2, 3, 4])
    assert.deepEqual(await enqueueThreadMessage(b, owner, threadId, one, 'First edit'), postedOne)
    await assert.rejects(() => enqueueThreadMessage(b, owner, threadId, one, 'Different text'),
      /already in use/)
    await assert.rejects(() => enqueueThreadMessage(b, stranger, threadId, two, 'Second edit'),
      /not found/)
    await assert.rejects(() => readThreadChat(b, stranger, threadId), /not found/)

    const editId = randomUUID()
    const edited = await editQueuedThreadMessage(b, owner, threadId, one, editId,
      'First edit', 'First updated')
    assert.equal(edited.content, 'First updated')
    assert.equal(edited.sequence, 2)
    assert.deepEqual(await editQueuedThreadMessage(a, owner, threadId, one, editId,
      'First edit', 'First updated'), edited)
    assert.deepEqual(await enqueueThreadMessage(a, owner, threadId, one, 'First edit'), edited,
      'original HTTP retry returns the edited durable message without overwriting it')
    await assert.rejects(() => editQueuedThreadMessage(a, owner, threadId, one, randomUUID(),
      'First edit', 'Stale edit'), /changed/)

    await archiveThread(a, owner, threadId)
    await archiveThread(b, owner, threadId)
    assert.equal((await readThreadChat(a, owner, threadId)).archived, true)
    await assert.rejects(() => enqueueThreadMessage(b, owner, threadId, randomUUID(), 'Forbidden'),
      /archived/)
    await assert.rejects(() => restoreThread(b, stranger, threadId), /not found/)
    await restoreThread(b, owner, threadId)
    await restoreThread(a, owner, threadId)
    const cancelled = await cancelQueuedThreadMessage(b, owner, threadId, two)
    assert.equal(cancelled.phase, 'cancelled')
    assert.equal((await cancelQueuedThreadMessage(a, owner, threadId, two)).cancelledAt,
      cancelled.cancelledAt)

    a.close()
    b.close()
    const reopened = openStudioDatabase(file)
    try {
      const result = await readThreadChat(reopened, owner, threadId)
      assert.deepEqual(result.messages.map(message => message.sequence), [0, 1, 2, 3, 4])
      assert.deepEqual(result.messages.filter(message => message.role === 'user')
        .map(message => message.content),
      ['Opening request', 'First updated', 'Second edit', 'Third edit'])
      const history = result.messages.find(message => message.id === one)?.editHistory
      assert.equal(history?.length, 1)
      assert.equal(history[0]?.old, 'First edit')
      assert.equal(history[0]?.replacement, 'First updated')
      assert.match(history[0]?.editedAt ?? '', /^\d{4}-\d{2}-\d{2}T/)
      assert.equal(result.messages.find(message => message.id === two)?.phase, 'cancelled')
      assert.equal(result.archived, false)
      assert.deepEqual((await reopened.testing.foreignKeyViolations()), [])
    } finally { reopened.close() }
  } finally {
    a.close()
    b.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
