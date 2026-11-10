import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from './support/studio-database'
import { createStudioAuth } from '../src/lib/auth'
import { ensureRootThreads } from '../src/lib/threads.server'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'natural-story-port-only-test-secret-012345678901234',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}

test('Shared persistence ports atomically associate Story roots and only deliver messages after admitted queue', async () => {
  const store = openStudioDatabase(':memory:')
  try {
    await migrateStudio(store, config)
    const adapter = (await createStudioAuth(store, config).$context).internalAdapter
    const owner = (await adapter.createUser({
      name: 'Owner', email: 'owner@example.test', emailVerified: true,
    }, { method: 'test' })).id
    const stranger = (await adapter.createUser({
      name: 'Stranger', email: 'stranger@example.test', emailVerified: true,
    }, { method: 'test' })).id
    const repositoryId = randomUUID(), storyId = randomUUID(), jobId = randomUUID()
    const sha = 'a'.repeat(40), at = '2026-11-05T00:00:00.000Z'
    await store.persistence.repositories.upsert(owner, 'github', '123', 'owner/story',
      null, repositoryId, at)
    await store.persistence.onboarding.importStory({
      id: storyId, owner, repositoryId, directory: 'story',
      title: 'Story', createdAt: at, commitSha: sha,
    })
    assert.equal(await store.persistence.generation.jobs.register(
      owner, jobId, storyId, 'Original', sha, at), true)
    await ensureRootThreads(store, owner, storyId)
    await assert.rejects(() =>
      store.persistence.naturalStory.associateRoot(stranger, storyId, jobId, 'Wrong', at),
    /not found/)
    for (let attempt = 0; attempt < 2; attempt++)
      assert.equal(await store.persistence.naturalStory.associateRoot(
        owner, storyId, jobId, 'New title', at), 'root:' + jobId)
    assert.equal((await store.persistence.naturalStory.previousJob(owner, jobId))?.threadId,
      'root:' + jobId)

    const threadId = 'root:' + jobId
    const guidanceId = 'guidance:fork:' + jobId
    await store.persistence.messages.enqueue(owner, threadId, guidanceId,
      'Author guidance', undefined, at)
    await assert.rejects(() => store.persistence.messages.markAdmitted(owner, jobId), /not admitted/)
    assert.equal((await store.persistence.messages.owned(owner, threadId, guidanceId))?.status, 'queued')
    assert.equal(await store.persistence.messages.owned(stranger, threadId, guidanceId), null)
    await store.persistence.generation.queue.enqueue(owner, jobId, 'start', 'prepared',
      at, JSON.stringify({ task: 'Write a Story' }), threadId)
    await assert.rejects(() => store.persistence.messages.markAdmitted(stranger, jobId), /not admitted/)
    await store.persistence.messages.markAdmitted(owner, jobId)
    await store.persistence.messages.markAdmitted(owner, jobId)
    assert.equal((await store.persistence.messages.owned(owner, threadId, guidanceId))?.status,
      'delivered')
  } finally {
    store.close()
  }
})
