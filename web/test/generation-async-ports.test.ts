import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { queueGeneration, queueRecord, claimNext, finishAttempt } from '../src/lib/generation-queue.server'
import { appendGenerationEvent, listGenerationEvents, recentGenerationEvents } from '../src/lib/generation-progress.server'
import { pumpAgentQueue } from '../src/agent-service'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'strictly-async-studio-persistence-test-secret-01234567890',
  github: { clientId: 'github', clientSecret: 'secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'secret' },
}

test('queue and progress consumers await async-only ports without exposing SQLite handles', async () => {
  const store = openStudioDatabase(':memory:')
  try {
    await migrateStudio(store, config)
    const owner = (await (await createStudioAuth(store, config).$context).internalAdapter.createUser({
      name: 'Owner', email: 'port@example.test', emailVerified: true,
    }, { method: 'test' })).id
    const repositoryId = randomUUID(), storyId = randomUUID(), jobId = randomUUID()
    await store.persistence.repositories.upsert(owner, 'github', '11', 'owner/story',
      null, repositoryId, 'now')
    await store.persistence.onboarding.importStory({
      id: storyId, owner, repositoryId, directory: 'story', title: 'Story',
      createdAt: 'now', commitSha: 'a'.repeat(40),
    })
    assert.equal(await store.persistence.generation.jobs.register(owner, jobId,
      storyId, 'Job', 'a'.repeat(40), 'now'), true)
    const queue = store.persistence.generation.queue
    const events = store.persistence.generation.events
    const calls: string[] = []
    store.persistence.generation.queue = {
      ...queue,
      async record(...args) { await Promise.resolve(); calls.push('record'); return queue.record(...args) },
      async enqueue(...args) { await Promise.resolve(); calls.push('enqueue'); return queue.enqueue(...args) },
      async claim(...args) { await Promise.resolve(); calls.push('claim'); return queue.claim(...args) },
      async finish(...args) { await Promise.resolve(); calls.push('finish'); return queue.finish(...args) },
    }
    store.persistence.generation.events = {
      ...events,
      async append(...args) { await Promise.resolve(); calls.push('append'); return events.append(...args) },
      async after(...args) { await Promise.resolve(); calls.push('after'); return events.after(...args) },
      async recent(...args) { await Promise.resolve(); calls.push('recent'); return events.recent(...args) },
    }
    await queueGeneration(store, owner, jobId, 'start', 'prepared', '{"task":"test"}', 'thread')
    assert.equal((await queueRecord(store, jobId))?.phase, 'queued')
    assert.equal((await claimNext(store))?.jobId, jobId)
    await finishAttempt(store, jobId, true)
    assert.equal((await queueRecord(store, jobId))?.phase, 'finished')
    await appendGenerationEvent(store, owner, jobId, { kind: 'started' })
    assert.deepEqual((await listGenerationEvents(store, owner, jobId, 0)).map(e => e.kind), ['started'])
    assert.equal((await recentGenerationEvents(store, owner, jobId)).events.length, 1)
    assert.deepEqual(calls, ['enqueue', 'record', 'claim', 'finish', 'record', 'append', 'after', 'recent'])
  } finally {
    store.close()
  }
})

test('overlapping agent pump calls share one asynchronous fenced claim pass', async () => {
  const store = openStudioDatabase(':memory:')
  try {
    await migrateStudio(store, config)
    const queue = store.persistence.generation.queue
    let claims = 0, fences = 0
    store.persistence.generation.queue = {
      ...queue,
      async foreignRunning(worker) {
        fences++
        await Promise.resolve()
        return queue.foreignRunning(worker)
      },
      async claim(worker, limit, now) {
        claims++
        await new Promise<void>(resolve => setTimeout(resolve, 5))
        return queue.claim(worker, limit, now)
      },
    }
    await Promise.all([pumpAgentQueue(store), pumpAgentQueue(store), pumpAgentQueue(store)])
    assert.equal(claims, 1, 'overlapping callers must not start concurrent claim loops')
    assert.equal(fences, 1, 'restart fencing runs once for this connection')
  } finally {
    store.close()
  }
})
