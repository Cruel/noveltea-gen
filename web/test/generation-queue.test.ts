import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { openStudioDatabase } from '../src/db/connection'
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
    db.sqlite.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)")
      .run(owner, 'Author', 'queue@example.test', 1, Date.now(), Date.now())
    db.sqlite.prepare(`INSERT INTO repositories (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES (?,?,'github','repo','Repo','now')`).run(repo, owner)
    db.sqlite.prepare(`INSERT INTO stories (id,owner_user_id,repository_id,directory,title,created_at)
      VALUES (?,?,?,'story','Story','now')`).run(story, owner, repo)
    const ids = Array.from({ length: 4 }, () => randomUUID())
    for (const id of ids) {
      db.sqlite.prepare(`INSERT INTO studio_sessions
        (id,owner_user_id,story_id,title,status,created_at,updated_at)
        VALUES (?,?,?,'Job','paused','now','now')`).run(id, owner, story)
      queueGeneration(db, owner, id, 'start', 'prepared', '{"task":"example"}', 'thread-' + id)
    }
    assert.equal(activeLimit(), 2)
    assert.equal(claimNext(db)?.jobId, ids[0])
    assert.equal(claimNext(db)?.jobId, ids[1])
    assert.equal(claimNext(db), null)
    assert.throws(() => queueGeneration(db, owner, ids[0]!, 'start', 'paused'), /queued or executing/)
    finishAttempt(db, ids[0]!, true)
    assert.equal(claimNext(db)?.jobId, ids[2])
    assert.equal(queueRecord(db, ids[3]!)?.phase, 'queued')
    assert.equal(dequeueBeforeStart(db, owner, ids[3]!), true)
    assert.equal(queueRecord(db, ids[3]!), undefined)
    assert.equal(claimNext(db), null)
    // Interrupted attempts are not requeued, and they do not consume capacity.
    db.sqlite.prepare("UPDATE generation_run_queue SET worker_id='other-host:4242:alive' WHERE job_id=?")
      .run(ids[1])
    assert.equal(fenceAbandonedRuns(db), 0, 'do not steal another host owner')
    db.sqlite.prepare('UPDATE generation_run_queue SET worker_id=? WHERE job_id=?')
      .run(`${hostname()}:999999999:dead`, ids[1])
    assert.equal(fenceAbandonedRuns(db), 1)
    assert.equal(queueRecord(db, ids[1]!)?.phase, 'interrupted')
    assert.throws(() => queueGeneration(db, owner, ids[1]!, 'resume', 'paused'), /reconciliation/)
    process.env.NT_STUDIO_MAX_ACTIVE_JOBS = '1'
    assert.equal(claimNext(db), null)
    process.env.NT_STUDIO_MAX_ACTIVE_JOBS = 'bogus'
    assert.throws(activeLimit, /integer/)
    assert.deepEqual(db.sqlite.pragma('foreign_key_check'), [])
  } finally {
    if (prior === undefined) delete process.env.NT_STUDIO_MAX_ACTIVE_JOBS
    else process.env.NT_STUDIO_MAX_ACTIVE_JOBS = prior
    db.sqlite.close()
    rmSync(root, { recursive: true, force: true })
  }
})
