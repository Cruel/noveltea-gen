import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { setTimeout, clearTimeout } from 'node:timers'
import { setTimeout as delay } from 'node:timers/promises'
import { openSharedStudioStore } from '../src/db/shared-studio-store'
import type { KyselyFeatureFixture } from './support/studio-database'
import type { QueueRecord } from '../src/persistence/generation-contracts'
import { openStudioBusinessFixture } from './support/studio-database'

const at = '2026-11-10T12:00:00Z'
const later = '2026-11-10T13:00:00Z'
const base = 'a'.repeat(40)
type DatabaseOptions = KyselyFeatureFixture['databaseOptions']
const pg = process.env.NT_TEST_PG_URL
if (process.env.NT_REQUIRE_KYSELY_PROOF === '1' && !pg)
  throw new Error('Mandatory StudioStore conformance needs NT_TEST_PG_URL')

type WorkerInput = {
  options: DatabaseOptions
  operation: 'claim' | 'hold-uncommitted-job-update' | 'probe-lock' | 'author-decision'
  workerId: string
  owner?: string
  jobId?: string
  limit?: number
}
type WorkerMessage =
  | { type: 'result'; result: QueueRecord | null }
  | { type: 'uncommitted' }
  | { type: 'ready' }
  | { type: 'probe'; blocked: boolean; code: string; error: string }
function spawnWorker(input: WorkerInput) {
  const child = fork(new URL('./support/studio-conformance-worker.ts', import.meta.url), [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, NT_STUDIO_CERT_WORKER_INPUT: JSON.stringify(input) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr!.on('data', (part: Buffer) => { stderr += String(part) })
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  void exit.catch(() => {})
  return { child, exit, stderr: () => stderr.slice(-1800) }
}
async function message(child: ChildProcess, timeoutMs = 18_000): Promise<WorkerMessage> {
  return new Promise<WorkerMessage>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Independent Studio worker timed out')), timeoutMs)
    const onMessage = (value: unknown) => finish(null, value as WorkerMessage)
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(new Error('Worker exited before result: ' + code + '/' + signal))
    const onError = (error: Error) => finish(error)
    function finish(error: Error | null, value?: WorkerMessage) {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
      child.off('error', onError)
      if (error) reject(error)
      else resolve(value!)
    }
    child.once('message', onMessage)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}
async function claim(options: DatabaseOptions, id: string, capacity: number) {
  const w = spawnWorker({ options, operation: 'claim', workerId: id, limit: capacity })
  try {
    const response = await message(w.child)
    const ended = await w.exit
    assert.equal(ended.code, 0, w.stderr())
    assert.equal(response.type, 'result')
    return response.type === 'result' ? response.result : null
  } finally {
    if (w.child.exitCode === null) w.child.kill('SIGKILL')
    await w.exit
  }
}
async function killUncommitted(options: DatabaseOptions, jobId: string) {
  const w = spawnWorker({ options, operation: 'hold-uncommitted-job-update', workerId: 'crash', jobId })
  try {
    assert.deepEqual(await message(w.child), { type: 'uncommitted' })
  } finally {
    w.child.kill('SIGKILL')
    const end = await w.exit
    assert.equal(end.signal, 'SIGKILL', w.stderr())
  }
}

for (const backend of ['sqlite', 'postgres'] as const) {
  test(backend + ': actual StudioStore certification — 8 worker processes, capacity 3, crash rollback, tenant boundaries', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 120_000,
  }, async t => {
    const fixture = await openStudioBusinessFixture(backend)
    t.after(() => fixture.close())
    const first = fixture.store
    const second = openSharedStudioStore(fixture.databaseOptions)
    t.after(() => second.close())
    await Promise.all([first.assertReady(), second.assertReady()])
    const owner = await fixture.owner(), outsider = await fixture.owner()
    const repository = randomUUID(), story = randomUUID()
    const ownerRepo = await first.persistence.repositories.upsert(owner, 'github', repository,
      'Owner/Novel', null, repository, at)
    assert.equal(ownerRepo.id, repository)
    await first.persistence.onboarding.importStory({
      id: story, owner, repositoryId: repository, directory: 'story',
      title: 'The Novel', createdAt: at, commitSha: base,
    })
    const ids: string[] = []
    for (let i = 0; i < 8; i++) {
      const id = randomUUID()
      ids.push(id)
      assert.equal(await first.persistence.generation.jobs.register(
        owner, id, story, 'Queued ' + i, base, at), true)
      await first.persistence.generation.queue.enqueue(owner, id, 'start', 'prepared',
        at, JSON.stringify({ task: 'Queued ' + i }), 'generation:' + id)
    }

    await t.test('eight independent process claims preserve global FIFO, capacity, leases and restart state', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        claim(fixture.databaseOptions, 'process-' + i, 3)))
      const winning = results.filter((result): result is QueueRecord => !!result)
      assert.equal(winning.length, 3)
      assert.deepEqual(winning.map(row => row.jobId).sort(), ids.slice(0, 3).sort())
      assert.deepEqual(winning.map(row => row.sequence).sort((a, b) => a - b), [1, 2, 3])
      assert.equal(await claim(fixture.databaseOptions, 'late-process', 3), null,
        'OS process exit cannot release another worker\'s durable lease')
      const reopened = openSharedStudioStore(fixture.databaseOptions)
      try {
        await reopened.assertReady()
        for (let i = 0; i < ids.length; i++) {
          const row = await reopened.persistence.generation.queue.record(ids[i]!)
          assert.equal(row?.phase, i < 3 ? 'running' : 'queued')
          assert.equal(row?.sequence, i + 1)
          assert.equal(await reopened.persistence.generation.jobs.selected(outsider, ids[i]!), null)
        }
        assert.equal(await reopened.persistence.generation.queue.finish(
          winning[0]!.jobId, winning[0]!.workerId!, true, later), true)
        assert.equal(await second.persistence.generation.queue.finish(
          winning[0]!.jobId, 'stale-lease', true, later), false)
        assert.equal((await claim(fixture.databaseOptions, 'replacement', 3))?.jobId, ids[3])
      } finally {
        await reopened.close()
      }
    })

    await t.test('SIGKILL rolls back uncommitted mutations and a new store can write', async () => {
      // Job 7 remains paused. A child process updates it inside a transaction
      // but dies without committing; independent connections see old state.
      const victim = ids[7]!
      await killUncommitted(fixture.databaseOptions, victim)
      const reopened = openSharedStudioStore(fixture.databaseOptions)
      try {
        await reopened.assertReady()
        assert.equal((await reopened.persistence.generation.jobs.state(owner, victim))?.status, 'paused')
        assert.equal((await reopened.persistence.generation.queue.record(victim))?.phase, 'queued')
        await reopened.persistence.generation.events.append(owner, victim, {
          kind: 'working', stage: 'crash-recovery', milestone: null,
          filesJson: '[]', status: 'recovered', createdAt: later,
        })
        assert.deepEqual((await second.persistence.generation.events.after(owner, victim, 0, 10))
          .map(event => event.status), ['recovered'])
      } finally {
        await reopened.close()
      }
    })

    await t.test('an independent competing writer observes lock timeout, then resumes after process SIGKILL', async () => {
      const id = randomUUID()
      assert.equal(await first.persistence.generation.jobs.register(
        owner, id, story, 'Lock witness', base, at), true)
      const holder = spawnWorker({
        options: fixture.databaseOptions, operation: 'hold-uncommitted-job-update',
        workerId: 'holder', jobId: id,
      })
      try {
        assert.deepEqual(await message(holder.child), { type: 'uncommitted' })
        assert.equal(holder.child.exitCode, null, 'lock holder exited unexpectedly')
        const probe = spawnWorker({
          options: fixture.databaseOptions, operation: 'probe-lock',
          workerId: 'lock-probe', jobId: id,
        })
        try {
          const failed = await message(probe.child, 12_000)
          assert.equal(failed.type, 'probe')
          if (failed.type === 'probe') {
            assert.equal(failed.blocked, true, failed.error)
            assert.match(failed.code + ' ' + failed.error,
              /SQLITE_BUSY|55P03|lock timeout|canceling statement due to lock timeout/i)
          }
          assert.equal((await probe.exit).code, 0, probe.stderr())
        } finally {
          if (probe.child.exitCode === null) probe.child.kill('SIGKILL')
          await probe.exit
        }
        const contender = spawnWorker({
          options: fixture.databaseOptions, operation: 'author-decision',
          workerId: 'follower', owner, jobId: id,
        })
        try {
          assert.deepEqual(await message(contender.child), { type: 'ready' })
          let settled = false
          const finished = message(contender.child)
          void finished.then(() => { settled = true }, () => { settled = true })
          await delay(75)
          assert.equal(settled, false, 'competing connection must wait for the held job guard')
          holder.child.kill('SIGKILL')
          assert.equal((await holder.exit).signal, 'SIGKILL', holder.stderr())
          assert.deepEqual(await finished, { type: 'result', result: true })
          assert.equal((await contender.exit).code, 0, contender.stderr())
        } finally {
          if (contender.child.exitCode === null) contender.child.kill('SIGKILL')
          await contender.exit
        }
      } finally {
        if (holder.child.exitCode === null) holder.child.kill('SIGKILL')
        await holder.exit
      }
      const reopened = openSharedStudioStore(fixture.databaseOptions)
      try {
        await reopened.assertReady()
        assert.equal((await reopened.persistence.generation.jobs.state(owner, id))?.status, 'blocked',
          'committed follower wins after rollback; uncommitted cancellation never survives')
      } finally {
        await reopened.close()
      }
    })

    await t.test('cross-owner FK/check boundaries and published state survive reopen', async () => {
      assert.equal(await first.persistence.generation.jobs.catalogStory(outsider, story, 'github'), null)
      assert.equal(await second.persistence.repositories.get(outsider, repository), null)
      await assert.rejects(fixture.records.insert('stories', {
        id: randomUUID(), ownerUserId: outsider, repositoryId: repository,
        directory: 'unauthorized', title: 'Wrong owner',
        sourceCommitSha: base, createdAt: at,
      }), /foreign key|constraint/i)
      await assert.rejects(fixture.records.insert('story_threads', {
        id: randomUUID(), ownerUserId: outsider, storyId: story,
        title: 'Wrong owner', createdAt: at, activityAt: at,
      }), /foreign key|constraint/i)
      const collectionId = randomUUID(), threadId = randomUUID()
      await fixture.records.insert('story_threads', {
        id: threadId, ownerUserId: owner, storyId: story,
        title: 'Owner thread', createdAt: at, activityAt: at,
      })
      await first.persistence.collections.create(owner, story, collectionId, 'Draft', at)
      assert.equal(await first.persistence.collections.assign(outsider, story, threadId, collectionId), false)
      assert.equal(await first.persistence.collections.assign(owner, story, threadId, collectionId), true)
      const connection = randomUUID()
      await first.persistence.git.connect({
        id: connection, owner, provider: 'github', providerAccountId: randomUUID(),
        login: 'owner', credentials: 'encrypted:opaque', accessExpiresAt: 1000,
        refreshExpiresAt: 2000, now: at,
      })
      assert.equal(await second.persistence.git.read(outsider, connection), null)
      assert.equal((await second.persistence.git.read(owner, connection))?.credentials, 'encrypted:opaque')
      const reopened = openSharedStudioStore(fixture.databaseOptions)
      try {
        await reopened.assertReady()
        assert.deepEqual((await reopened.persistence.collections.list(owner, story)).map(c => c.name), ['Draft'])
        await assert.rejects(reopened.persistence.collections.list(outsider, story), /Story not found/)
        assert.equal((await reopened.persistence.git.read(owner, connection))?.login, 'owner')
        assert.equal((await reopened.persistence.dashboard.forOwner(outsider)).stories.some(s => s.id === story), false)
      } finally {
        await reopened.close()
      }
    })
  })
}

test('postgres: a held Studio writer never blocks a different selected schema', {
  skip: !pg && 'Set NT_TEST_PG_URL',
  timeout: 45_000,
}, async () => {
  const first = await openStudioBusinessFixture('postgres')
  try {
    const second = await openStudioBusinessFixture('postgres')
    try {
      const ownerA = await first.owner(), ownerB = await second.owner()
      const repository = randomUUID(), story = randomUUID(), job = randomUUID()
      await first.store.persistence.repositories.upsert(ownerA, 'github', repository,
        'First/Novel', null, repository, at)
      await first.store.persistence.onboarding.importStory({
        id: story, owner: ownerA, repositoryId: repository, directory: 'novel',
        title: 'First Novel', commitSha: base, createdAt: at,
      })
      assert.equal(await first.store.persistence.generation.jobs.register(
        ownerA, job, story, 'Locked job', base, at), true)
      const held = spawnWorker({
        options: first.databaseOptions, operation: 'hold-uncommitted-job-update',
        workerId: 'schema-holder', jobId: job,
      })
      try {
        assert.deepEqual(await message(held.child), { type: 'uncommitted' })
        const started = Date.now()
        await second.store.persistence.git.startFlow(ownerB, 'github', randomUUID(),
          'verifier', 1000, 500)
        assert.ok(Date.now() - started < 3500,
          'unrelated schema must not acquire the first schema\'s advisory lock')
        assert.equal(held.child.exitCode, null)
      } finally {
        if (held.child.exitCode === null) held.child.kill('SIGKILL')
        await held.exit
      }
      assert.equal((await first.store.persistence.generation.jobs.state(ownerA, job))?.status,
        'paused', 'terminated transaction must roll back independently')
    } finally {
      await second.close()
    }
  } finally {
    await first.close()
  }
})
