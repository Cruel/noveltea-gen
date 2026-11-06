import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { migrateStudio } from '../src/db/migrations'
import { activeLimit, claimNext, finishAttempt, queueGeneration, queueRecord,
  fenceAbandonedRuns, dequeueBeforeStart } from '../src/lib/generation-queue.server'

const config = { baseURL: 'http://localhost:3000',
  secret: 'studio-queue-test-01234567890123456789',
  github: { clientId: 'gh', clientSecret: 'secret' },
  gitlab: { clientId: 'gl', clientSecret: 'secret' } }

test('SQLite queue reserves two concurrent slots, is FIFO, preserves interrupted claims and rejects duplicate admission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'noveltea-queue-'))
  const db = openStudioDatabase(join(root, 'studio.sqlite'))
  const prior = process.env.NT_STUDIO_MAX_ACTIVE_JOBS
  try {
    await migrateStudio(db, config)
    const owner = randomUUID(), repo = randomUUID(), story = randomUUID()
    const seed = studioSeed(db)
    ;(await seed.user(owner))
    ;(await seed.repository({ id: repo, ownerUserId: owner, provider: 'github',
      providerRepositoryId: 'repo', name: 'Repo', createdAt: 'now' }))
    ;(await seed.story({ id: story, ownerUserId: owner, repositoryId: repo,
      directory: 'story', title: 'Story', createdAt: 'now' }))
    const ids = Array.from({ length: 4 }, () => randomUUID())
    for (const id of ids) {
      (await seed.job({ id, ownerUserId: owner, storyId: story, title: 'Job',
        status: 'paused', createdAt: 'now', updatedAt: 'now' }))
      await queueGeneration(db, owner, id, 'start', 'prepared', '{"task":"example"}', 'thread-' + id)
    }
    assert.equal(activeLimit(), 2)
    assert.equal((await claimNext(db))?.jobId, ids[0])
    assert.equal((await claimNext(db))?.jobId, ids[1])
    assert.equal((await claimNext(db)), null)
    await assert.rejects(() => queueGeneration(db, owner, ids[0]!, 'start', 'paused'), /queued or executing/)
    await finishAttempt(db, ids[0]!, true)
    assert.equal((await claimNext(db))?.jobId, ids[2])
    assert.equal((await queueRecord(db, ids[3]!))?.phase, 'queued')
    assert.equal((await dequeueBeforeStart(db, owner, ids[3]!)), true)
    assert.equal((await queueRecord(db, ids[3]!)), undefined)
    assert.equal((await claimNext(db)), null)
    // Interrupted attempts are not requeued, and they do not consume capacity.
    ;(await db.testing.records.update('generation_run_queue', { jobId: ids[1] },
      { workerId: 'other-host:4242:alive' }))
    assert.equal((await fenceAbandonedRuns(db)), 0, 'do not steal another host owner')
    ;(await db.testing.records.update('generation_run_queue', { jobId: ids[1] },
      { workerId: `${hostname()}:999999999:dead` }))
    assert.equal((await fenceAbandonedRuns(db)), 1)
    assert.equal((await queueRecord(db, ids[1]!))?.phase, 'interrupted')
    await assert.rejects(() => queueGeneration(db, owner, ids[1]!, 'resume', 'paused'), /reconciliation/)
    // A Compose restart may assign the same process PID (often PID 1).
    // The distinct incarnation still must be fenced, never automatically rerun.
    ;(await db.testing.records.update('generation_run_queue', { jobId: ids[2] },
      { workerId: `${hostname()}:${process.pid}:previous-container` }))
    assert.equal((await fenceAbandonedRuns(db)), 1)
    assert.equal((await queueRecord(db, ids[2]!))?.phase, 'interrupted')
    process.env.NT_STUDIO_MAX_ACTIVE_JOBS = '1'
    assert.equal((await claimNext(db)), null)
    process.env.NT_STUDIO_MAX_ACTIVE_JOBS = 'bogus'
    assert.throws(activeLimit, /integer/)
    assert.deepEqual((await db.testing.foreignKeyViolations()), [])
  } finally {
    if (prior === undefined) delete process.env.NT_STUDIO_MAX_ACTIVE_JOBS
    else process.env.NT_STUDIO_MAX_ACTIVE_JOBS = prior
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
