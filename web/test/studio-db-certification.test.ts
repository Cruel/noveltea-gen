import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from './support/studio-database'
import { createStudioAuth } from '../src/lib/auth'

const auth = {
  baseURL: 'http://localhost:3000',
  secret: 'studio-certification-fresh-database-secret-01234567890123456789',
  github: { clientId: 'test', clientSecret: 'test-secret' },
  gitlab: { clientId: 'test', clientSecret: 'test-secret' },
}
const at = '2026-11-05T00:00:00Z'
const sha = 'a'.repeat(40)
type Store = ReturnType<typeof openStudioDatabase>

async function fixture(connectionCount = 4) {
  const dir = mkdtempSync(join(tmpdir(), 'noveltea-studio-cert-'))
  const path = join(dir, 'studio.sqlite')
  const stores: Store[] = []
  try {
    const first = openStudioDatabase(path)
    stores.push(first)
    await migrateStudio(first, auth)
    const context = await createStudioAuth(first, auth).$context
    const user = await context.internalAdapter.createUser({
      name: 'Author', email: randomUUID() + '@example.test', emailVerified: true,
    }, { method: 'test' })
    const stranger = await context.internalAdapter.createUser({
      name: 'Other author', email: randomUUID() + '@example.test', emailVerified: true,
    }, { method: 'test' })
    const repo = await first.persistence.repositories.upsert(user.id, 'github', '1001',
      'owner/repository', null, randomUUID(), at)
    const storyId = randomUUID()
    await first.persistence.onboarding.importStory({
      id: storyId, owner: user.id, repositoryId: repo.id,
      directory: 'story', title: 'Fresh Story', commitSha: sha, createdAt: at,
    })
    for (let i = 1; i < connectionCount; i++) stores.push(openStudioDatabase(path))
    return {
      dir, path, stores, owner: user.id, stranger: stranger.id, storyId,
      close() { for (const store of stores) store.close() },
      cleanup() {
        for (const store of stores) {
          try { store.close() } catch { /* already closed for restart certification */ }
        }
        rmSync(dir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    for (const store of stores) store.close()
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

test('four connections drain 48 FIFO jobs without duplicate claims, slot oversubscription or lease theft', async () => {
  const f = await fixture()
  try {
    const ids: string[] = Array.from({ length: 48 }, () => randomUUID())
    for (const [i, id] of ids.entries()) {
      const store = f.stores[i % f.stores.length]!
      assert.equal(await store.persistence.generation.jobs.register(f.owner, id, f.storyId, 'Job', sha, at), true)
      await store.persistence.generation.queue.enqueue(f.owner, id, 'start', 'prepared', at,
        JSON.stringify({ job: i }), 'graph:' + id)
    }
    const claimed: string[] = []
    for (let round = 0; round < ids.length / 3; round++) {
      const candidates = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        f.stores[i % f.stores.length]!.persistence.generation.queue.claim(
          'host:100:worker-' + i, 3, at)))
      const active = candidates.filter((item): item is NonNullable<typeof item> => item !== null)
      assert.equal(active.length, 3, 'one global three-slot limit across independent connections')
      assert.equal(new Set(active.map(item => item.jobId)).size, 3)
      const roundIds = active.map(item => item.jobId)
      assert.deepEqual([...roundIds].sort((a, b) => ids.indexOf(a) - ids.indexOf(b)),
        ids.slice(round * 3, round * 3 + 3), 'each round claims the oldest eligible jobs')
      claimed.push(...roundIds)
      assert.equal(await f.stores[2]!.persistence.generation.queue.finish(
        active[0]!.jobId, 'host:100:wrong-worker', true, at), false)
      for (const entry of active) {
        assert.equal(await f.stores[3]!.persistence.generation.queue.finish(
          entry.jobId, entry.workerId!, true, at), true)
        assert.equal(await f.stores[0]!.persistence.generation.queue.finish(
          entry.jobId, entry.workerId!, true, at), false, 'finished claim cannot be replayed')
      }
    }
    assert.deepEqual([...claimed].sort((a, b) => ids.indexOf(a) - ids.indexOf(b)), ids,
      'all durable FIFO jobs are claimed exactly once')
    assert.equal(await f.stores[1]!.persistence.generation.queue.claim('host:100:idle', 3, at), null)
  } finally { f.cleanup() }
})

test('independent OS processes contend for 60 jobs without duplicate claims or capacity races', async () => {
  const f = await fixture()
  try {
    const ids = Array.from({ length: 60 }, () => randomUUID())
    for (const [i, id] of ids.entries()) {
      const store = f.stores[i % f.stores.length]!
      await store.persistence.generation.jobs.register(f.owner, id, f.storyId, 'Job', sha, at)
      await store.persistence.generation.queue.enqueue(f.owner, id, 'start', 'prepared', at,
        '{"task":"multi-process"}', 'graph:' + id)
    }
    const script = fileURLToPath(new URL('./support/studio-claim-worker.ts', import.meta.url))
    const runWorker = (worker: number) => {
      const child = fork(script, [f.path, 'host:' + (100 + worker) + ':worker'], {
        execArgv: ['--import', 'tsx'],
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        silent: true,
      })
      let stderr = ''
      child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      let readyResolve!: () => void
      let readyReject!: (reason: Error) => void
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve
        readyReject = reject
      })
      let finished = false
      const result = new Promise<string[]>((resolve, reject) => {
        child.on('message', message => {
          if (message === 'ready') readyResolve()
          if (typeof message === 'object' && message !== null &&
            'claimed' in message && Array.isArray(message.claimed)) {
            finished = true
            resolve(message.claimed as string[])
          }
        })
        child.on('error', error => { readyReject(error); reject(error) })
        child.on('exit', code => {
          if (!finished) {
            const error = new Error('Isolated worker exited (' + code + '): ' + stderr)
            readyReject(error)
            reject(error)
          }
        })
      })
      return { child, ready, result }
    }
    const workers = Array.from({ length: 4 }, (_, i) => runWorker(i))
    let results: string[][]
    try {
      await Promise.all(workers.map(worker => worker.ready))
      for (const worker of workers) worker.child.send('go')
      results = await Promise.all(workers.map(worker => worker.result))
    } finally {
      for (const worker of workers) worker.child.kill()
    }
    const claimed = results.flat()
    assert.equal(claimed.length, ids.length)
    assert.deepEqual(new Set(claimed), new Set(ids),
      'every durable job is claimed exactly once across four separate processes')
    for (const id of ids)
      assert.equal((await f.stores[0]!.persistence.generation.queue.record(id))?.phase, 'finished')
  } finally { f.cleanup() }
})

test('80 concurrent Thread writes keep unique sequences and idempotency across connections and restart', async () => {
  const f = await fixture()
  try {
    const job = randomUUID(), thread = 'graph:' + job
    const a = f.stores[0]!, b = f.stores[1]!
    await a.persistence.generation.jobs.register(f.owner, job, f.storyId, 'Root', sha, at)
    await a.persistence.generation.queue.enqueue(f.owner, job, 'start', 'prepared', at, '{"task":"opening"}', thread)
    const worker = 'host:100:root'
    assert.equal((await b.persistence.generation.queue.claim(worker, 1, at))?.jobId, job)
    assert.equal(await b.persistence.generation.jobs.start(f.owner, job, thread, '{"task":"opening"}', worker, at), true)
    assert.equal(await a.persistence.generation.jobs.finish(f.owner, job, thread, 'completed', false, worker, at), true)
    assert.equal(await b.persistence.generation.queue.finish(job, worker, true, at), true)
    await Promise.all([a.persistence.conversations.reconcileRoots(f.owner, f.storyId),
      b.persistence.conversations.reconcileRoots(f.owner, f.storyId)])
    const navigation = await b.persistence.conversations.navigation(f.owner, f.storyId)
    assert.equal(navigation.threads.length, 1)
    const threadId = navigation.threads[0]!.id
    const ids = Array.from({ length: 80 }, () => randomUUID())
    const writes = await Promise.all(ids.map((id, i) =>
      f.stores[i % f.stores.length]!.persistence.messages.enqueue(
        f.owner, threadId, id, 'Message ' + i, undefined, at)))
    assert.equal(new Set(writes.map(message => message.sequence)).size, ids.length)
    const sorted = writes.map(message => message.sequence).sort((x, y) => x - y)
    assert.deepEqual(sorted, Array.from({ length: 80 }, (_, i) => i + sorted[0]!))
    assert.deepEqual(await b.persistence.messages.enqueue(
      f.owner, threadId, ids[0]!, 'Message 0', undefined, at), writes[0])
    await assert.rejects(b.persistence.messages.enqueue(
      f.owner, threadId, ids[0]!, 'Conflicting retry', undefined, at), /already in use/)
    await assert.rejects(b.persistence.messages.enqueue(
      f.stranger, threadId, randomUUID(), 'Cross-owner', undefined, at), /not found/)
    f.close()
    const reopened = openStudioDatabase(f.path)
    try {
      const history = await reopened.persistence.messages.read(f.owner, threadId)
      const postedIds = new Set<string>(ids)
      const posted = history.messages.filter(message => postedIds.has(message.id))
      assert.equal(posted.length, 80)
      assert.deepEqual(posted.map(message => message.sequence), sorted)
      assert.deepEqual(posted.map(message => message.content),
        ids.map((_, i) => 'Message ' + i))
    } finally { reopened.close() }
  } finally { f.cleanup() }
})

test('failed admission rolls back, crash fencing persists, and Studio reset leaves checkpoint state alone', async () => {
  const f = await fixture(2)
  try {
    const id = randomUUID(), a = f.stores[0]!, b = f.stores[1]!
    const jobs = a.persistence.generation.jobs
    const queue = a.persistence.generation.queue
    await jobs.register(f.owner, id, f.storyId, 'Recovery', sha, at)
    await assert.rejects(queue.enqueue(f.owner, id, 'start', 'prepared', at,
      '{"task":"work"}'), /Missing pinned generation inputs/)
    assert.equal((await b.persistence.generation.jobs.state(f.owner, id))?.requestJson, null)
    assert.equal(await b.persistence.generation.queue.record(id), null)
    await assert.rejects(queue.enqueue(f.stranger, id, 'start', 'prepared', at,
      '{"task":"work"}', 'graph:recovery'), /state changed/)
    assert.equal(await b.persistence.generation.queue.record(id), null)
    await queue.enqueue(f.owner, id, 'start', 'prepared', at, '{"task":"work"}', 'graph:recovery')
    const oldWorker = 'host:100:crashed'
    assert.equal((await b.persistence.generation.queue.claim(oldWorker, 1, at))?.jobId, id)
    assert.equal(await jobs.start(f.owner, id, 'graph:recovery', '{"task":"work"}', oldWorker, at), true)
    assert.equal(await queue.finish(id, oldWorker, false, at), true)
    f.close()
    const reopened = openStudioDatabase(f.path)
    try {
      assert.equal((await reopened.persistence.generation.queue.record(id))?.phase, 'interrupted')
      assert.equal(await reopened.persistence.generation.jobs.finish(f.owner, id,
        'graph:recovery', 'completed', false, oldWorker, at), false)
      await assert.rejects(reopened.persistence.generation.queue.enqueue(f.owner, id,
        'resume', 'paused', at), /state changed|reconciliation/)
      await reopened.persistence.generation.queue.reconcileAndEnqueue(f.owner, id, 'resume', {
        status: 'running', request: '{"task":"work"}', thread: 'graph:recovery',
      }, true, at)
      assert.equal((await reopened.persistence.generation.jobs.state(f.owner, id))?.status, 'paused')
      assert.equal((await reopened.persistence.generation.queue.record(id))?.phase, 'queued')
      assert.equal(await reopened.persistence.generation.queue.claim('host:200:restored', 1, at)
        .then(item => item?.jobId), id)
    } finally { reopened.close() }

    // An operator resetting *only* Studio must never touch independent graph or Pi state.
    const graphDir = join(f.dir, 'jobs', 'independent-job')
    mkdirSync(graphDir, { recursive: true })
    const checkpoint = join(graphDir, 'generation.sqlite')
    const session = join(graphDir, 'pi-session.jsonl')
    writeFileSync(checkpoint, 'untouched checkpoint bytes')
    writeFileSync(session, 'untouched Pi transcript')
    for (const suffix of ['', '-wal', '-shm']) rmSync(f.path + suffix, { force: true })
    assert.equal(existsSync(f.path), false)
    const fresh = openStudioDatabase(f.path)
    try {
      await migrateStudio(fresh, auth)
      assert.equal(await fresh.persistence.generation.queue.record(id), null)
    } finally { fresh.close() }
    assert.equal(readFileSync(checkpoint, 'utf8'), 'untouched checkpoint bytes')
    assert.equal(readFileSync(session, 'utf8'), 'untouched Pi transcript')
  } finally { f.cleanup() }
})
