import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openKyselyFeatureFixture, type KyselyFeatureFixture } from './support/kysely-feature-fixture'

const at = '2026-11-09T12:00:00Z'
const later = '2026-11-09T13:00:00Z'
const base = 'a'.repeat(40)
const checked = 'b'.repeat(40)
const pg = process.env.NT_TEST_PG_URL

type WorkerInput = {
  owner: string; threadId: string; kind: 'batch' | 'edit'; label: string;
  count?: number; id?: string; requestId?: string; expected?: string; replacement?: string
}
type WorkerResult = {
  ok: boolean; status?: number; message?: string; content?: string;
  sent?: Array<{ id: string; sequence: number }>
}
async function worker(fixture: KyselyFeatureFixture, input: WorkerInput): Promise<WorkerResult> {
  const path = fileURLToPath(new URL('./support/kysely-message-worker.ts', import.meta.url))
  const child = spawn(process.execPath, ['--import', 'tsx', path], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NT_MESSAGE_WORKER_INPUT: JSON.stringify({ ...input, options: fixture.databaseOptions }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data })
  child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  if (code !== 0) throw new Error('Independent message worker failed: ' + stderr.slice(0, 1000))
  return JSON.parse(stdout.trim()) as WorkerResult
}
if (process.env.NT_REQUIRE_KYSELY_PROOF === '1' && !pg)
  throw new Error('NT_TEST_PG_URL required for shared Thread message conformance')

async function setup(fixture: KyselyFeatureFixture) {
  const owner = await fixture.owner()
  const stranger = await fixture.owner()
  const repositoryId = randomUUID(), storyId = randomUUID(), threadId = randomUUID(), jobId = randomUUID()
  const data = fixture.records
  await data.insert('repositories', {
    id: repositoryId, ownerUserId: owner, provider: 'github',
    providerRepositoryId: repositoryId, name: 'Story/Repo', createdAt: at,
  })
  await data.insert('stories', {
    id: storyId, ownerUserId: owner, repositoryId, title: 'Novel', directory: 'story',
    sourceCommitSha: base, createdAt: at,
  })
  await data.insert('story_threads', {
    id: threadId, ownerUserId: owner, storyId, title: 'Thread',
    activityAt: at, createdAt: at,
  })
  await data.insert('studio_sessions', {
    id: jobId, ownerUserId: owner, storyId, title: 'Original', status: 'completed',
    sourceCommitSha: base, createdAt: at, updatedAt: at,
    generationRequestJson: JSON.stringify({ task: 'Initial request', fixture: true }),
  })
  await data.insert('story_thread_runs', {
    jobId, ownerUserId: owner, threadId, runOrder: 0,
  })
  await data.insert('generation_run_queue', {
    jobId, ownerUserId: owner, intent: 'start', phase: 'finished',
    createdAt: at, updatedAt: later,
  })
  await data.insert('generation_events', {
    jobId, ownerUserId: owner, kind: 'finished', status: 'completed',
    createdAt: later,
  })
  return { owner, stranger, repositoryId, storyId, threadId, jobId }
}

for (const backend of ['sqlite', 'postgres'] as const) {
  test(`${backend}: shared Thread messages, edit receipts and protected admissions`, {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL for PostgreSQL conformance',
    timeout: 90_000,
  }, async t => {
    const fixture = await openKyselyFeatureFixture(backend)
    t.after(async () => fixture.close())
    const { records: data, messages } = fixture
    const { owner, stranger, storyId, threadId, jobId } = await setup(fixture)
    const other = await fixture.openIndependentMessages()
    t.after(async () => other.close())

    await t.test('reconcile is idempotent across two readers; evidence, Turn receipts and SHA are trustworthy',
      async () => {
        const first = await messages.read(owner, threadId)
        const second = await other.messages.read(owner, threadId)
        assert.deepEqual(first.messages.map(m => m.role), ['user', 'assistant'])
        assert.deepEqual(second.messages, first.messages)
        assert.equal(first.messages[0]?.content, 'Initial request')
        assert.match(first.messages[1]!.content, /not independently validated/)
        assert.deepEqual(first.evidence.map(e => e.kind), ['finished'])
        assert.deepEqual(first.runs.map(r => r.jobId), [jobId])
        assert.equal(first.turns[0]?.executionIds[0], jobId)
        assert.equal(first.turnReceipts[0]?.inputSha, base)
        assert.equal(first.turnReceipts[0]?.executions[0]?.validatedSha, null)
        assert.equal(await data.count('story_thread_messages', { threadId }), 2)
        assert.equal(await data.count('story_turns', { threadId }), 1)
        assert.equal(await data.count('story_turn_executions', { jobId }), 1)
        await data.insert('story_thread_messages', {
          id: randomUUID(), ownerUserId: owner, threadId, sequence: 2,
          role: 'assistant', status: 'delivered', body: 'Verified receipt',
          phase: 'finished', jobId, verifiedCommitSha: checked, createdAt: later,
        })
        const persisted = await other.messages.read(owner, threadId)
        assert.equal(persisted.turnReceipts[0]?.executions[0]?.validatedSha, checked)
        assert.equal(persisted.messages.length, 4, 'new verified receipt retains the old assistant summary')
        await data.update('studio_sessions', { id: jobId }, { status: 'paused' })
        const paused = (await messages.read(owner, threadId)).messages
          .filter(m => m.role === 'assistant')
        assert.match(paused.at(-1)?.content ?? '', /paused/i)
        await data.update('studio_sessions', { id: jobId }, { status: 'completed' })
        const completed = (await other.messages.read(owner, threadId)).messages
          .filter(m => m.role === 'assistant')
        assert.match(completed.at(-1)?.content ?? '', /finished/i)
        assert.equal(new Set(completed.map(m => m.id)).size, completed.length)
        assert.equal((await messages.read(owner, threadId)).messages.length, completed.length + 1,
          'repeated settlement does not append duplicate assistant receipts')
        assert.equal((await messages.membership(owner, threadId)).storyId, storyId)
        await assert.rejects(messages.membership(stranger, threadId), /Thread not found/)
        await assert.rejects(messages.read(stranger, threadId), /Thread not found/)
      })

    await t.test('first edit is used for enqueue replay, while history always uses generated sequence', async () => {
      const id = randomUUID(), firstRequest = randomUUID(), secondRequest = randomUUID()
      const queued = await messages.enqueue(owner, threadId, id, 'Original', undefined, at)
      assert.equal(queued.phase, 'queued')
      assert.equal(queued.editCount, 0)
      assert.equal(queued.hasRevisionScope, 0)
      await data.update('story_thread_messages', { id }, { revisionScopeJson: '{"stale":true}' })
      assert.equal((await messages.edit(owner, threadId, id, firstRequest, 'Original', 'Second', later)).content,
        'Second')
      assert.equal((await other.messages.edit(owner, threadId, id, secondRequest, 'Second', 'Third', at)).content,
        'Third')
      assert.equal((await messages.enqueue(owner, threadId, id, 'Original', undefined, at)).content, 'Third')
      await assert.rejects(messages.enqueue(owner, threadId, id, 'Second', undefined, at),
        /already in use/)
      assert.equal((await messages.edit(owner, threadId, id, firstRequest, 'Original', 'Second', later)).content,
        'Third', 'duplicate edit request is idempotent and does not undo a newer edit')
      await assert.rejects(other.messages.edit(owner, threadId, id, firstRequest, 'Wrong', 'Second', later),
        /already in use/)
      await assert.rejects(other.messages.edit(owner, threadId, id, randomUUID(), 'Original', 'Wrong', at),
        /Queued message changed/)
      await assert.rejects(messages.edit(stranger, threadId, id, randomUUID(), 'Third', 'Tampered', at),
        /Thread not found/)
      const current = (await messages.read(owner, threadId)).messages.find(m => m.id === id)!
      assert.equal(current.editCount, 2)
      assert.equal(current.hasRevisionScope, 0, 'edits revoke stale revision scope')
      assert.deepEqual(current.editHistory, [
        { old: 'Original', replacement: 'Second', editedAt: later },
        { old: 'Second', replacement: 'Third', editedAt: at },
      ], 'insertion sequence, not timestamp or physical rowid, defines history')
      const receipt = (await messages.read(owner, threadId)).turnReceipts.find(t => t.id === id)!
      assert.equal(receipt.request, 'Original')
      assert.equal(receipt.effectiveRequest, 'Third')
      await assert.rejects(messages.enqueue(stranger, threadId, id, 'Original', undefined, at),
        /Thread not found/)
    })

    await t.test('cancellation and protected/reviewed work are fenced, owner-scoped and durable', async () => {
      const cancellable = randomUUID()
      await messages.enqueue(owner, threadId, cancellable, 'Cancel me', undefined, later)
      const cancelled = await other.messages.cancel(owner, threadId, cancellable, later)
      assert.equal(cancelled.phase, 'cancelled')
      assert.equal((await messages.cancel(owner, threadId, cancellable, at)).cancelledAt, later)
      await assert.rejects(messages.edit(owner, threadId, cancellable, randomUUID(), 'Cancel me', 'No', at),
        /already admitted or approved/)
      await assert.rejects(messages.cancel(stranger, threadId, cancellable, at), /Thread not found/)

      const protectedId = randomUUID()
      await messages.enqueue(owner, threadId, protectedId, 'Protected', undefined, at)
      await data.insert('thread_protected_decisions', {
        messageId: protectedId, ownerUserId: owner, threadId, sourceJobId: jobId,
        sourceSha: base, proposalSha256: 'e'.repeat(64), changeJson: '{}',
        nonce: randomUUID(), decision: 'approved', principal: owner, recordedAt: at,
      })
      await assert.rejects(messages.edit(owner, threadId, protectedId, randomUUID(), 'Protected', 'Changed', at),
        /already admitted or approved/)
      await data.update('story_thread_messages', { id: protectedId }, { sourceJobId: jobId })
      await assert.rejects(messages.cancel(owner, threadId, protectedId, at),
        /entered execution/)
      assert.equal(await data.count('thread_queued_message_edits', { messageId: protectedId }), 0)
      assert.equal((await messages.read(owner, threadId)).messages.find(m => m.id === protectedId)?.content,
        'Protected')
    })

    await t.test('steer admission is pinned to active job and cannot be edited after dispatch', async () => {
      const idle = randomUUID()
      await assert.rejects(messages.enqueue(owner, threadId, idle, 'Not running', 'steer', at),
        /Steer is available only/)
      assert.equal(await data.count('story_thread_messages', { id: idle }), 0,
        'rejected admission must not leave an allocated sequence')
      await data.update('studio_sessions', { id: jobId }, { status: 'running' })
      await data.update('generation_run_queue', { jobId }, { phase: 'running' })
      await data.insert('thread_active_pi_turns', {
        jobId, piToken: randomUUID(), piSessionId: 'pi-session', workItem: 'world',
        expectedHead: base, createdAt: at,
      })
      const steerId = randomUUID()
      const steer = await messages.enqueue(owner, threadId, steerId, 'Steer', 'steer', at)
      assert.equal(steer.liveMode, 'steer')
      assert.equal(steer.liveState, 'pending')
      assert.equal(steer.liveSourceJobId, jobId)
      assert.equal(steer.liveWorkItem, 'world')
      assert.equal((await messages.edit(owner, threadId, steerId, randomUUID(),
        'Steer', 'Steer changed', later)).content, 'Steer changed')
      await data.update('thread_live_inputs', { messageId: steerId }, { state: 'dispatching' })
      await assert.rejects(other.messages.edit(owner, threadId, steerId, randomUUID(),
        'Steer changed', 'Too late', later), /already admitted or approved/)
      await assert.rejects(other.messages.cancel(owner, threadId, steerId, later),
        /entered execution/)
      const followup = await messages.enqueue(owner, threadId, randomUUID(), 'Future work',
        'follow-up', later)
      assert.equal(followup.liveState, 'deferred')
      const guidance = 'guidance:fork:' + jobId
      await data.insert('story_thread_messages', {
        id: guidance, ownerUserId: owner, threadId,
        sequence: 50, role: 'user', status: 'queued', body: 'Fork guidance',
        phase: 'queued', createdAt: at,
      })
      await messages.markAdmitted(owner, jobId)
      assert.equal((await messages.owned(owner, threadId, guidance))?.status, 'delivered')
      assert.equal((await messages.owned(owner, threadId, guidance))?.phase, 'running')
      await assert.rejects(messages.markAdmitted(owner, randomUUID()), /Generation was not admitted/)
    })

    await t.test('archival, stopped runs and missing executions roll back rejected admissions', async () => {
      const empty = randomUUID()
      await data.insert('story_threads', {
        id: empty, ownerUserId: owner, storyId, title: 'Empty',
        activityAt: at, createdAt: at,
      })
      await assert.rejects(messages.enqueue(owner, empty, randomUUID(), 'No run', undefined, at),
        /Create a generation run/)
      assert.equal(await data.count('story_thread_messages', { threadId: empty }), 0)
      await data.update('story_threads', { id: threadId }, { archivedAt: at })
      const beforeArchive = await data.count('story_thread_messages', { threadId })
      await assert.rejects(messages.enqueue(owner, threadId, randomUUID(), 'Archived', undefined, later),
        /Restore the archived Thread/)
      assert.equal(await data.count('story_thread_messages', { threadId }), beforeArchive)
      await data.update('story_threads', { id: threadId }, { archivedAt: null })
      await data.update('studio_sessions', { id: jobId }, { status: 'blocked' })
      await data.update('generation_run_queue', { jobId }, { phase: 'interrupted' })
      const beforeBlocked = await data.count('story_thread_messages', { threadId })
      await assert.rejects(messages.enqueue(owner, threadId, randomUUID(), 'Stopped', undefined, later),
        /cannot accept follow-ups/)
      assert.equal(await data.count('story_thread_messages', { threadId }), beforeBlocked)
      await data.update('studio_sessions', { id: jobId }, { status: 'completed' })
      await data.update('generation_run_queue', { jobId }, { phase: 'finished' })
    })

    await t.test('same-Thread recovery is one execution lineage, not a new synthetic author request',
      async () => {
        const childJob = randomUUID()
        await data.insert('checkpoint_forks', {
          childId: childJob, ownerUserId: owner, sourceJobId: jobId,
          sourceThreadId: threadId, sourceBaseSha: base, commitSha: checked,
          bundleJson: '{}', draftJson: '{}', createdAt: later,
        })
        await data.insert('studio_sessions', {
          id: childJob, ownerUserId: owner, storyId, title: 'Recovery',
          status: 'completed', sourceCommitSha: checked,
          createdAt: later, updatedAt: later,
          generationRequestJson: '{"task":"Recovered request","fixture":true}',
        })
        await data.insert('story_thread_runs', {
          jobId: childJob, ownerUserId: owner, threadId, runOrder: 1,
        })
        await data.insert('generation_run_queue', {
          jobId: childJob, ownerUserId: owner, intent: 'start',
          phase: 'finished', createdAt: later, updatedAt: later,
        })
        const chat = await messages.read(owner, threadId)
        assert.equal(chat.runs.length, 2)
        assert.equal(chat.messages.some(m => m.id === 'initial:' + childJob), false)
        assert.equal((await other.messages.read(owner, threadId)).messages.some(m =>
          m.id === 'initial:' + childJob), false)
        const lineage = await data.all('story_turn_executions', { jobId: childJob })
        assert.equal(lineage.filter(row => row.turnId === 'initial:' + jobId).length, 1,
          'recovery associates with the original Turn exactly once')
        assert.equal(chat.turnReceipts[0]?.executions.length, 2)
        assert.equal(chat.turnReceipts[0]?.executions[1]?.inputSha, checked)
      })
  })

  test(`${backend}: guarded independent writers allocate exact Thread sequences and recover on restart`, {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL for PostgreSQL conformance',
    timeout: 90_000,
  }, async t => {
    const fixture = await openKyselyFeatureFixture(backend)
    t.after(async () => fixture.close())
    const { owner, threadId } = await setup(fixture)
    const other = await fixture.openIndependentMessages()
    t.after(async () => other.close())
    // Separate processes prove actual SQLite writer-lock ownership and PG
    // transaction advisory guards; competing handles in one Node event loop
    // would block the synchronous SQLite driver from releasing its own lock.
    const batches = await Promise.all([
      worker(fixture, { owner, threadId, kind: 'batch', label: 'A', count: 18 }),
      worker(fixture, { owner, threadId, kind: 'batch', label: 'B', count: 18 }),
    ])
    const sent = batches.flatMap(result => result.sent ?? [])
    assert.equal(sent.length, 36)
    assert.equal(new Set(sent.map(m => m.sequence)).size, sent.length)
    assert.deepEqual(sent.map(m => m.sequence).sort((a, b) => a - b),
      Array.from({ length: sent.length }, (_, n) => n + 2))
    const repeated = await Promise.all(sent.map(({ id }, n) =>
      fixture.messages.enqueue(owner, threadId, id,
        batches[0]!.sent!.some(row => row.id === id)
          ? 'A:' + batches[0]!.sent!.findIndex(row => row.id === id)
          : 'B:' + batches[1]!.sent!.findIndex(row => row.id === id),
        undefined, later)))
    assert.deepEqual(repeated.map(row => row.sequence), sent.map(row => row.sequence))
    const chat = await fixture.messages.read(owner, threadId)
    assert.equal(chat.messages.length, sent.length + 2)
    assert.equal(chat.turns.length, sent.length + 1)
    const raceId = randomUUID()
    await fixture.messages.enqueue(owner, threadId, raceId, 'Race', undefined, at)
    const results = await Promise.all([
      worker(fixture, { owner, threadId, kind: 'edit', label: 'X', id: raceId,
        requestId: randomUUID(), expected: 'Race', replacement: 'First edit' }),
      worker(fixture, { owner, threadId, kind: 'edit', label: 'Y', id: raceId,
        requestId: randomUUID(), expected: 'Race', replacement: 'Second edit' }),
    ])
    assert.deepEqual(results.map(result => result.ok).sort(), [false, true])
    assert.equal(results.find(result => !result.ok)?.status, 409)
    const edited = await fixture.messages.owned(owner, threadId, raceId)
    assert.ok(['First edit', 'Second edit'].includes(edited!.content))
    assert.equal((await fixture.messages.read(owner, threadId)).messages
      .find(m => m.id === raceId)?.editHistory?.length, 1)
    assert.equal((await other.messages.cancel(owner, threadId, raceId, later)).phase, 'cancelled')
    await assert.rejects(fixture.messages.edit(owner, threadId, raceId, randomUUID(),
      edited!.content, 'Too late', later), /already admitted or approved/)
    const restarted = await fixture.reopenMessages()
    const after = await restarted.read(owner, threadId)
    assert.deepEqual(after.messages.map(m => m.sequence), chat.messages.map(m => m.sequence).concat([38]),
      'restart preserves all previously assigned message sequences plus the cancelled request')
    assert.equal(after.messages.find(m => m.id === raceId)?.phase, 'cancelled')
    assert.equal(new Set(after.messages.map(m => m.id)).size, after.messages.length)
    assert.equal(await fixture.records.count('story_thread_messages', { threadId }), after.messages.length)
  })
}
