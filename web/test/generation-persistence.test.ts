import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { migrateStudio } from '../src/db/migrations'
import { fenceAbandonedRuns } from '../src/lib/generation-queue.server'

const auth = {
  baseURL: 'http://localhost:3000',
  secret: 'studio-generation-persistence-test-0123456789abcdefghijklmnopqrstuvwxyz',
  github: { clientId: 'test-gh', clientSecret: 'test-secret' },
  gitlab: { clientId: 'test-gl', clientSecret: 'test-secret' },
}
const stamp = '2026-11-05T09:00:00Z'
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'noveltea-db-generation-'))
  const path = join(directory, 'studio.sqlite')
  const a = openStudioDatabase(path)
  await migrateStudio(a, auth)
  const b = openStudioDatabase(path)
  const owners = [randomUUID(), randomUUID()]
  const repos = owners.map(() => randomUUID())
  const stories = owners.map(() => randomUUID())
  const seed = studioSeed(a)
  for (let i = 0; i < owners.length; i++) {
    (await seed.user(owners[i]!))
    ;(await seed.repository({ id: repos[i]!, ownerUserId: owners[i]!, provider: 'github',
      providerRepositoryId: String(i), name: 'repo-' + i, createdAt: stamp }))
    ;(await seed.story({ id: stories[i]!, ownerUserId: owners[i]!, repositoryId: repos[i]!,
      directory: 'story', title: 'Demo', createdAt: stamp, sourceCommitSha: 'a'.repeat(40) }))
  }
  async function job(ownerIndex = 0) {
    const id = randomUUID()
    ;(await seed.job({ id, ownerUserId: owners[ownerIndex]!, storyId: stories[ownerIndex]!,
      title: 'Job', status: 'paused', createdAt: stamp, updatedAt: stamp }))
    return id
  }
  return { a, b, owners, repos, stories, job, cleanup() {
    a.close(); b.close(); rmSync(directory, { recursive: true, force: true })
  } }
}

test('two WAL connections claim one FIFO queue without duplicate slots or excess concurrency', async () => {
  const f = await setup()
  try {
    const ids = await Promise.all(Array.from({ length: 7 }, () => f.job()))
    for (const id of ids) await f.a.persistence.generation.queue.enqueue(
      f.owners[0]!, id, 'start', 'prepared', stamp, '{"task":"test"}', 'thread-' + id)
    const queueA = f.a.persistence.generation.queue
    const queueB = f.b.persistence.generation.queue
    const claims = await Promise.all([
      queueA.claim('host:100:worker-1', 2, stamp),
      queueB.claim('host:200:worker-2', 2, stamp),
      queueA.claim('host:100:worker-1', 2, stamp),
      queueB.claim('host:200:worker-2', 2, stamp),
    ])
    assert.deepEqual(claims.map(c => c?.jobId ?? null), [ids[0], ids[1], null, null])
    assert.equal((await queueB.record(ids[0]!))?.phase, 'running')
    assert.equal(await queueB.finish(ids[0]!, 'host:200:worker-2', true, stamp), false,
      'one worker cannot terminate another worker lease')
    assert.equal(await queueA.finish(ids[0]!, 'host:100:worker-1', true, stamp), true)
    assert.equal((await queueB.claim('host:200:worker-2', 2, stamp))?.jobId, ids[2])
    assert.equal(await queueA.dequeue(f.owners[1]!, ids[3]!), false)
    assert.equal(await queueB.dequeue(f.owners[0]!, ids[3]!), true)
    assert.equal(await queueA.record(ids[3]!), null)
    assert.equal(await queueA.claim('host:100:worker-1', 2, stamp), null)
    assert.deepEqual((await f.b.testing.foreignKeyViolations()), [])
  } finally { f.cleanup() }
})

test('admission is owner-bound, pins request atomically, and idempotent work cannot be claimed twice', async () => {
  const f = await setup()
  try {
    const id = await f.job()
    const a = f.a.persistence.generation.queue, b = f.b.persistence.generation.queue
    await assert.rejects(a.enqueue(f.owners[1]!, id, 'start', 'prepared', stamp, '{}', 'thread'),
      /state changed/i)
    assert.equal((await f.b.persistence.generation.jobs.state(f.owners[0]!, id))?.requestJson, null)
    await a.enqueue(f.owners[0]!, id, 'start', 'prepared', stamp, '{"task":"a"}', 'thread')
    await assert.rejects(b.enqueue(f.owners[0]!, id, 'start', 'prepared', stamp, 'other', 'other'),
      /state changed|queued or executing/i)
    assert.equal((await f.b.persistence.generation.jobs.state(f.owners[0]!, id))?.requestJson, '{"task":"a"}')
    assert.equal((await a.record(id))?.intent, 'start')
    const claimed = await b.claim('host:100:active', 2, stamp)
    assert.equal(claimed?.jobId, id)
    assert.equal(await a.claim('host:200:active', 2, stamp), null)
    const job = f.a.persistence.generation.jobs
    assert.equal(await job.start(f.owners[1]!, id, 'thread', '{"task":"a"}', 'host:100:active', stamp), false)
    assert.equal(await job.start(f.owners[0]!, id, 'other', '{"task":"a"}', 'host:100:active', stamp), false)
    assert.equal(await job.start(f.owners[0]!, id, 'thread', '{"task":"a"}', 'host:200:active', stamp), false)
    assert.equal(await job.start(f.owners[0]!, id, 'thread', '{"task":"a"}', 'host:100:active', stamp), true)
    assert.equal(await job.start(f.owners[0]!, id, 'thread', '{"task":"a"}', 'host:100:active', stamp), false)
    assert.equal(await job.finish(f.owners[0]!, id, 'thread', 'completed', false, 'host:200:active', stamp), false)
    assert.equal(await job.finish(f.owners[0]!, id, 'thread', 'completed', false, 'host:100:active', stamp), true)
    assert.equal(await job.finish(f.owners[0]!, id, 'thread', 'completed', false, 'host:100:active', stamp), false)
    assert.equal((await f.b.persistence.generation.jobs.state(f.owners[0]!, id))?.status, 'completed')
    assert.equal(await b.finish(id, 'host:100:active', true, stamp), true)
  } finally { f.cleanup() }
})

test('recovery must fence a dead writer; changed state never partially clears its interrupted receipt', async () => {
  const f = await setup()
  try {
    const id = await f.job()
    const q = f.a.persistence.generation.queue
    const owner = f.owners[0]!
    await q.enqueue(owner, id, 'start', 'prepared', stamp, '{"task":"run"}', 'thread')
    const worker = `${hostname()}:999999999:dead`
    assert.equal((await q.claim(worker, 2, stamp))?.jobId, id)
    assert.equal((await fenceAbandonedRuns(f.b)), 1)
    assert.equal((await q.record(id))?.phase, 'interrupted')
    await assert.rejects(q.enqueue(owner, id, 'resume', 'paused', stamp), /reconciliation/)
    await assert.rejects(f.b.persistence.generation.queue.reconcileAndEnqueue(
      f.owners[1]!, id, 'resume', { status: 'paused', request: '{"task":"run"}', thread: 'thread' },
      true, stamp), /recovered job|state/i)
    assert.equal((await q.record(id))?.phase, 'interrupted')
    await f.b.persistence.generation.queue.reconcileAndEnqueue(owner, id, 'resume',
      { status: 'paused', request: '{"task":"run"}', thread: 'thread' }, true, stamp)
    assert.equal((await q.record(id))?.phase, 'queued')
    assert.equal((await q.record(id))?.intent, 'resume')
    await assert.rejects(q.reconcileAndEnqueue(owner, id, 'resume',
      { status: 'paused', request: '{"task":"run"}', thread: 'thread' }, true, stamp),
    /interrupted attempt changed/i)
    assert.equal((await q.record(id))?.phase, 'queued')
  } finally { f.cleanup() }
})

test('a fenced worker cannot publish a successful job outcome after interruption', async () => {
  const f = await setup()
  try {
    const jobId = await f.job()
    const owner = f.owners[0]!
    const queue = f.a.persistence.generation.queue
    const jobs = f.b.persistence.generation.jobs
    const worker = 'host:123:stale'
    await queue.enqueue(owner, jobId, 'start', 'prepared', stamp, '{"task":"safe"}', 'thread')
    assert.equal((await queue.claim(worker, 2, stamp))?.jobId, jobId)
    assert.equal(await jobs.start(owner, jobId, 'thread', '{"task":"safe"}', worker, stamp), true)
    assert.equal(await queue.finish(jobId, worker, false, stamp), true)
    assert.equal(await jobs.finish(owner, jobId, 'thread', 'completed', false, worker, stamp), false)
    assert.equal((await jobs.state(owner, jobId))?.status, 'running',
      'an interrupted writer cannot forge completed status')
    assert.equal((await queue.record(jobId))?.phase, 'interrupted')
  } finally { f.cleanup() }
})

test('job configuration CAS and bounded event history share the raw SQLite schema', async () => {
  const f = await setup()
  try {
    const id = await f.job()
    const jobs = f.a.persistence.generation.jobs
    const other = f.b.persistence.generation.jobs
    assert.equal(await jobs.saveConfiguration(f.owners[1]!, id, '{"draft":1}', stamp), false)
    assert.equal(await jobs.saveConfiguration(f.owners[0]!, id, '{"draft":1}', stamp), true)
    assert.equal(await other.increaseBudget(f.owners[0]!, id, '{"draft":2}', '{"draft":3}', stamp), false)
    assert.equal(await jobs.increaseBudget(f.owners[0]!, id, '{"draft":1}', '{"draft":2}', stamp), true)
    assert.equal((await other.state(f.owners[0]!, id))?.configJson, '{"draft":2}')
    const events = f.a.persistence.generation.events
    for (let n = 0; n < 105; n++) await events.append(f.owners[0]!, id, {
      kind: 'working', stage: 'foundation', milestone: null, filesJson: '[]',
      status: null, createdAt: stamp,
    })
    assert.equal((await f.b.persistence.generation.events.after(f.owners[0]!, id, 0, 100)).length, 100)
    assert.equal((await f.b.persistence.generation.events.recent(f.owners[0]!, id,
      Number.MAX_SAFE_INTEGER, 101)).length, 101)
    assert.deepEqual(await f.b.persistence.generation.events.after(f.owners[1]!, id, 0, 100), [])
    assert.equal(await events.hasAfter(f.owners[0]!, id, 105), false)
    assert.equal(await events.hasAfter(f.owners[0]!, id, 104), true)
    assert.equal((await f.a.testing.records.count('generation_events')), 105)
    assert.deepEqual((await f.a.testing.foreignKeyViolations()), [])
  } finally { f.cleanup() }
})
