import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createStudioAuth } from '../src/lib/auth'
import { migrateStudio } from './support/studio-database'
import { openStudioDatabase } from './support/studio-database'
import { submitFirstStoryTurn } from '../src/lib/story-first-chat.server'
import { openStoryThread, listStoryThreads } from '../src/lib/story-threads.server'
import { studioSeed } from './support/studio-seed'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'story-first-chat-test-secret-01234567890123456',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}

test('authenticated first Chat Turn is durable, isolated, retry-safe and restartable without a credential fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-first-chat-'))
  const filename = join(dir, 'studio.sqlite')
  const db = openStudioDatabase(filename)
  try {
    await migrateStudio(db, config)
    const auth = createStudioAuth(db, config)
    const adapter = (await auth.$context).internalAdapter
    const alice = (
      await adapter.createUser(
        { name: 'Alice', email: 'alice@chat.test', emailVerified: true },
        { method: 'test' },
      )
    ).id
    const bob = (
      await adapter.createUser(
        { name: 'Bob', email: 'bob@chat.test', emailVerified: true },
        { method: 'test' },
      )
    ).id
    const token = await adapter.createSession(alice)
    const headers = new Headers({
      cookie:
        'better-auth.session_token=' +
        token.token +
        '.' +
        createHmac('sha256', config.secret).update(token.token).digest('base64'),
    })
    const storyId = randomUUID(),
      otherStory = randomUUID(),
      repoId = randomUUID()
    const head = 'a'.repeat(40)
    await db.persistence.repositories.upsert(alice, 'github', '42', 'Owner/Story', null, repoId, 'now')
    for (const [id, directory] of [
      [storyId, 'story'],
      [otherStory, 'other'],
    ] as const)
      await db.persistence.onboarding.importStory({
        id,
        owner: alice,
        repositoryId: repoId,
        directory,
        title: 'Mystery',
        createdAt: 'now',
        commitSha: head,
      })
    assert.deepEqual((await listStoryThreads(db, alice, storyId)).threads, [])
    const jobId = randomUUID()
    const prompt = 'Write a branching mystery visual novel about an archivist.'
    const input = { storyId, jobId, prompt }
    await assert.rejects(
      () =>
        submitFirstStoryTurn(
          auth,
          db,
          new Headers({
            cookie: headers.get('cookie')!,
            origin: 'https://untrusted.example',
          }),
          config.baseURL,
          input,
        ),
      /Cross-origin/,
    )
    assert.deepEqual(
      (await listStoryThreads(db, alice, storyId)).threads,
      [],
      'cross-origin writes must not reserve a Thread',
    )
    const attempts = await Promise.all([
      submitFirstStoryTurn(auth, db, headers, config.baseURL, input),
      submitFirstStoryTurn(auth, db, headers, config.baseURL, input),
    ])
    assert.ok(attempts.every((result) => result.threadId === 'root:' + jobId))
    assert.ok(attempts.every((result) => ['pending', 'attention'].includes(result.state)))
    const missing = attempts.find((result) => result.state === 'attention')!
    assert.ok(missing, 'one request must eventually report its credential refusal')
    assert.match(missing.message ?? '', /Settings|model|credential/i)
    const thread = await openStoryThread(db, alice, storyId, missing.threadId)
    assert.deepEqual(
      thread.state.messages.map((m) => m.content),
      [prompt],
    )
    assert.deepEqual(thread.state.turns, [{ id: jobId, executionIds: [] }])
    assert.deepEqual(thread.state.runs, [])
    assert.equal(thread.state.messages[0]?.phase, 'blocked')
    assert.equal((await listStoryThreads(db, alice, storyId)).threads.length, 1)
    const retry = await submitFirstStoryTurn(auth, db, headers, config.baseURL, input)
    assert.equal(retry.state, 'attention')
    assert.deepEqual((await openStoryThread(db, alice, storyId, missing.threadId)).state.turns, [
      { id: jobId, executionIds: [] },
    ])
    assert.equal((await listStoryThreads(db, alice, storyId)).threads.length, 1)
    await assert.rejects(
      () =>
        submitFirstStoryTurn(auth, db, headers, config.baseURL, { ...input, prompt: 'A different request' }),
      /already belongs|different/i,
    )
    await assert.rejects(
      () => submitFirstStoryTurn(auth, db, headers, config.baseURL, { ...input, storyId: otherStory }),
      /already belongs|different/i,
    )
    await assert.rejects(
      () => submitFirstStoryTurn(auth, db, new Headers(), config.baseURL, { ...input, jobId: randomUUID() }),
      /Sign in required/,
    )
    const foreign = await adapter.createSession(bob)
    const foreignHeaders = new Headers({
      cookie:
        'better-auth.session_token=' +
        foreign.token +
        '.' +
        createHmac('sha256', config.secret).update(foreign.token).digest('base64'),
    })
    await assert.rejects(
      () => submitFirstStoryTurn(auth, db, foreignHeaders, config.baseURL, { ...input, jobId: randomUUID() }),
      /Story not found/,
    )
    await assert.rejects(
      () => submitFirstStoryTurn(auth, db, foreignHeaders, config.baseURL, input),
      /Story not found/,
    )
    assert.deepEqual(
      (await listStoryThreads(db, alice, storyId)).threads.map((t) => t.id),
      ['root:' + jobId],
    )
    assert.deepEqual(await db.testing.foreignKeyViolations(), [])
    db.close()
    const reopened = openStudioDatabase(filename)
    try {
      const after = await openStoryThread(reopened, alice, storyId, 'root:' + jobId)
      assert.deepEqual(
        after.state.messages.map((m) => m.content),
        [prompt],
      )
      assert.deepEqual(after.state.turns, [{ id: jobId, executionIds: [] }])
      assert.equal(after.state.messages[0]?.phase, 'blocked')
    } finally {
      reopened.close()
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one pending first Turn becomes one linked execution only after durable queue admission', async () => {
  const db = openStudioDatabase(':memory:')
  try {
    await migrateStudio(db, config)
    const seed = studioSeed(db)
    const owner = randomUUID(),
      repo = randomUUID(),
      storyId = randomUUID(),
      jobId = randomUUID()
    const sha = 'b'.repeat(40),
      prompt = 'Create a branching noir mystery.'
    const at = '2026-11-08T12:00:00Z'
    await seed.user(owner)
    await seed.repository({
      id: repo,
      ownerUserId: owner,
      provider: 'gitlab',
      providerRepositoryId: '17',
      name: 'Owner/Story',
      createdAt: at,
    })
    await seed.story({
      id: storyId,
      ownerUserId: owner,
      repositoryId: repo,
      directory: 'story',
      title: 'Noir',
      sourceCommitSha: sha,
      createdAt: at,
    })
    const first = await db.persistence.naturalStory.beginFirstTurn(
      owner, storyId, jobId, prompt, at, 'collaborative')
    assert.deepEqual(first, { headSha: sha, state: 'claimed' })
    const pinned = await db.persistence.messages.owned(owner, 'root:' + jobId, jobId)
    assert.equal(JSON.parse(pinned!.creativePolicyJson).mode, 'collaborative')
    assert.equal(pinned!.creativeModeOverride, 'collaborative')
    assert.equal(JSON.parse((await db.persistence.messages.membership(owner,
      'root:' + jobId)).creativePolicyJson).mode, 'collaborative')
    await assert.rejects(() => db.persistence.naturalStory.beginFirstTurn(
      owner, storyId, jobId, prompt, at, 'autonomous'), /already belongs/)
    const overlapping = await db.persistence.naturalStory.beginFirstTurn(owner, storyId, jobId, prompt, at)
    assert.equal(overlapping.state, 'pending', 'double-submit does not re-enter provider admission')
    assert.equal((await listStoryThreads(db, owner, storyId)).threads.length, 1)
    await db.persistence.generation.jobs.register(owner, jobId, storyId, 'Noir', sha, at)
    await db.persistence.conversations.reconcileRoots(owner, storyId)
    await assert.rejects(
      () => db.persistence.naturalStory.finishFirstTurn(owner, storyId, jobId, true),
      /not durably admitted/,
    )
    assert.deepEqual((await openStoryThread(db, owner, storyId, 'root:' + jobId)).state.turns, [
      { id: jobId, executionIds: [] },
    ])
    await seed.queue({
      jobId,
      ownerUserId: owner,
      phase: 'queued',
      intent: 'start',
      createdAt: at,
      updatedAt: at,
    })
    // A late failure handler cannot turn an already-queued writer back into
    // a blocked/discoverable first Turn. Queue state is authoritative.
    await db.persistence.naturalStory.finishFirstTurn(owner, storyId, jobId, false)
    const admitted = await openStoryThread(db, owner, storyId, 'root:' + jobId)
    assert.equal(admitted.state.messages[0]?.status, 'delivered')
    assert.equal(admitted.state.messages[0]?.jobId, jobId)
    assert.deepEqual(admitted.state.turns, [{ id: jobId, executionIds: [jobId] }])
    assert.equal(admitted.state.runs.length, 1)
    assert.equal(
      (await db.persistence.naturalStory.beginFirstTurn(owner, storyId, jobId, prompt, at)).state,
      'admitted',
    )
    assert.equal((await listStoryThreads(db, owner, storyId)).threads.length, 1)
    await db.testing.records.update('stories', { id: storyId }, { sourceCommitSha: 'c'.repeat(40) })
    await assert.rejects(
      () => db.persistence.naturalStory.beginFirstTurn(owner, storyId, jobId, prompt, at),
      /pinned to another Story revision/,
    )
    assert.equal(
      (await listStoryThreads(db, owner, storyId)).threads.length,
      1,
      'a moved Story base must not allocate or replay a different execution',
    )
    assert.deepEqual(await db.testing.foreignKeyViolations(), [])
  } finally {
    db.close()
  }
})
