import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { migrateStudio } from '../src/db/migrations'
import {
  openStoryThread,
  listStoryThreads,
  resolveStoryThreadAncestry,
} from '../src/lib/story-threads.server'
import { saveThreadPreferences, archiveThread, renameThread } from '../src/lib/threads.server'
import { enqueueThreadMessage } from '../src/lib/thread-chat.server'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'story-thread-gateway-test-secret-0123456789012345',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}
const at = '2026-11-06T00:00:00Z'
const base = 'a'.repeat(40),
  checkpoint = 'b'.repeat(40),
  proof = 'c'.repeat(64)

test('Story gateway lists zero Threads and refuses foreign Stories and cross-Story Thread IDs identically', async () => {
  const db = openStudioDatabase(':memory:')
  try {
    await migrateStudio(db, config)
    const seed = studioSeed(db)
    const alice = randomUUID(),
      bob = randomUUID()
    const repo = randomUUID(),
      story = randomUUID(),
      otherStory = randomUUID()
    await seed.user(alice)
    await seed.user(bob)
    await seed.repository({
      id: repo,
      ownerUserId: alice,
      provider: 'github',
      providerRepositoryId: 'repo',
      name: 'Author/Story',
      createdAt: at,
    })
    for (const id of [story, otherStory])
      await seed.story({
        id,
        ownerUserId: alice,
        repositoryId: repo,
        directory: id === story ? 'story' : 'story-other',
        title: 'An Empty Story',
        createdAt: at,
      })
    const empty = await listStoryThreads(db, alice, story)
    assert.deepEqual(empty, { story: { id: story, title: 'An Empty Story' }, threads: [] })
    assert.equal(
      await db.testing.records.count('story_threads'),
      0,
      'an empty Story must not create a fake root Thread',
    )
    assert.equal(await db.testing.records.count('story_conversations').catch(() => -1), -1,
      'fresh schema has no Conversation table')
    const threadId = randomUUID()
    await seed.thread({
      id: threadId,
      ownerUserId: alice,
      storyId: otherStory,
      title: 'Different Story',
      activityAt: at,
      createdAt: at,
    })
    const missing = randomUUID()
    for (const id of [threadId, missing]) {
      await assert.rejects(() => openStoryThread(db, alice, story, id), /Thread not found\./)
      await assert.rejects(() => resolveStoryThreadAncestry(db, alice, story, id), /Thread not found\./)
    }
    await assert.rejects(() => openStoryThread(db, bob, otherStory, threadId), /Story not found\./)
    await assert.rejects(() => listStoryThreads(db, bob, otherStory), /Story not found\./)
    await assert.rejects(() => listStoryThreads(db, alice, randomUUID()), /Story not found\./)
    const bobRepo = randomUUID(),
      bobStory = randomUUID()
    await seed.repository({
      id: bobRepo,
      ownerUserId: bob,
      provider: 'gitlab',
      providerRepositoryId: 'bob-repo',
      name: 'Bob/Story',
      createdAt: at,
    })
    await seed.story({
      id: bobStory,
      ownerUserId: bob,
      repositoryId: bobRepo,
      directory: 'story',
      title: 'Bob Story',
      createdAt: at,
    })
    await assert.rejects(() => openStoryThread(db, bob, bobStory, threadId), /Thread not found\./)
    await assert.rejects(() => openStoryThread(db, bob, bobStory, missing), /Thread not found\./)
    const other = await openStoryThread(db, alice, otherStory, threadId)
    assert.equal(other.thread.title, 'Different Story')
    assert.equal(other.state.storyId, otherStory)
    assert.ok(!('conversationId' in other.thread))
    assert.ok(!('jobId' in other.thread))
    assert.deepEqual(await db.testing.foreignKeyViolations(), [])
  } finally {
    db.close()
  }
})

test('Story gateway preserves fork checkpoint identity, chat, navigation and restart across connections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-story-thread-gateway-'))
  const path = join(dir, 'studio.sqlite')
  const a = openStudioDatabase(path),
    b = openStudioDatabase(path)
  try {
    await migrateStudio(a, config)
    const seed = studioSeed(a)
    const owner = randomUUID(),
      stranger = randomUUID(),
      repo = randomUUID()
    const story = randomUUID(),
      sourceJob = randomUUID(),
      forkJob = randomUUID()
    await seed.user(owner)
    await seed.user(stranger)
    await seed.repository({
      id: repo,
      ownerUserId: owner,
      provider: 'github',
      providerRepositoryId: 'repo',
      name: 'Author/Story',
      createdAt: at,
    })
    await seed.story({
      id: story,
      ownerUserId: owner,
      repositoryId: repo,
      directory: 'story',
      title: 'Mystery',
      sourceCommitSha: base,
      createdAt: at,
    })
    await seed.job({
      id: sourceJob,
      ownerUserId: owner,
      storyId: story,
      title: 'Original',
      status: 'completed',
      sourceCommitSha: base,
      generationRequestJson: JSON.stringify({ fixture: true, task: 'Start' }),
      createdAt: at,
      updatedAt: at,
    })
    await seed.queue({
      jobId: sourceJob,
      ownerUserId: owner,
      intent: 'start',
      phase: 'finished',
      createdAt: at,
      updatedAt: at,
    })
    const first = await listStoryThreads(a, owner, story)
    const rootId = 'root:' + sourceJob
    assert.deepEqual(
      first.threads.map((row) => row.id),
      [rootId],
    )
    assert.ok(!('conversations' in first))
    assert.equal(first.threads[0]?.parentThreadId, null)
    const fork = {
      childId: forkJob,
      owner,
      sourceJobId: sourceJob,
      sourceBaseSha: base,
      commitSha: checkpoint,
      bundle: '{"version":1}',
      draft: '{"version":1}',
      sourceThreadId: rootId,
      proofDigest: proof,
      guidance: 'Explore the other culprit',
      history: JSON.stringify([
        {
          role: 'user',
          body: 'Who did it?',
          originId: 'source:' + sourceJob,
          verifiedSha: base,
          createdAt: at,
        },
      ]),
      at,
    }
    await a.persistence.advancedThreads.reserveFork(fork)
    const childId = 'fork:' + forkJob
    await a.persistence.advancedThreads.registerChild({
      childId: forkJob,
      owner,
      storyId: story,
      title: 'Alternative',
      baseSha: checkpoint,
      parentThreadId: rootId,
      threadId: childId,
      draft: fork.draft,
      at,
      kind: 'fork',
      history: JSON.parse(fork.history),
      guidance: fork.guidance,
    })
    const selected = await openStoryThread(b, owner, story, childId)
    assert.equal(selected.story.id, story)
    assert.equal(selected.thread.id, childId)
    assert.deepEqual(
      selected.ancestry.map((node) => node.id),
      [rootId, childId],
    )
    assert.deepEqual(selected.ancestry[1]?.forkPoint, {
      kind: 'checkpoint',
      commitSha: checkpoint,
      proofDigest: proof,
    })
    assert.equal(selected.ancestry[0]?.forkPoint, null)
    assert.deepEqual(
      selected.state.messages.map((m) => m.content),
      ['Who did it?', 'Explore the other culprit'],
    )
    assert.deepEqual(
      selected.state.runs.map((run) => run.jobId),
      [forkJob],
    )
    assert.equal(selected.state.runs[0]?.status, 'prepared')
    assert.equal((await openStoryThread(a, owner, story, rootId)).state.runs[0]?.status, 'completed')

    // A restart reservation is not a visible Thread until the actual child and
    // pinned source are atomically registered. Its exact selection survives.
    const restartJob = randomUUID(),
      restartId = 'restart:' + restartJob
    const restartIntent = {
      childId: restartJob,
      owner,
      sourceThread: childId,
      sourceJob: forkJob,
      rootJob: sourceJob,
      original: base,
      mode: 'newer' as const,
      selected: checkpoint,
      branch: null,
      draft: fork.draft,
      at,
    }
    await a.persistence.advancedThreads.reserveRestart(restartIntent)
    await assert.rejects(() => openStoryThread(b, owner, story, restartId), /Thread not found\./)
    await a.persistence.advancedThreads.registerChild({
      childId: restartJob,
      owner,
      storyId: story,
      title: 'Restart from clue',
      baseSha: checkpoint,
      parentThreadId: childId,
      threadId: restartId,
      draft: fork.draft,
      at,
      kind: 'restart',
    })
    const restarted = await openStoryThread(b, owner, story, restartId)
    assert.deepEqual(
      restarted.ancestry.map((node) => node.id),
      [rootId, childId, restartId],
    )
    assert.deepEqual(restarted.ancestry[2]?.forkPoint, {
      kind: 'restart',
      commitSha: checkpoint,
      proofDigest: null,
    })

    // A new run is internal execution state, not a new visible Thread.
    const followUp = randomUUID()
    await seed.job({
      id: followUp,
      ownerUserId: owner,
      storyId: story,
      title: 'Revision',
      status: 'completed',
      sourceCommitSha: checkpoint,
      generationRequestJson: JSON.stringify({ fixture: true }),
      createdAt: at,
      updatedAt: at,
    })
    await seed.threadRun({ jobId: followUp, ownerUserId: owner, threadId: childId, runOrder: 1 })
    await enqueueThreadMessage(b, owner, childId, randomUUID(), 'Revise a clue')
    await archiveThread(a, owner, rootId)
    await renameThread(a, owner, childId, 'A different ending')
    await saveThreadPreferences(a, owner, story, 'flat', [childId])
    const updated = await openStoryThread(b, owner, story, childId)
    assert.equal(updated.thread.title, 'A different ending')
    assert.equal(updated.ancestry[0]?.archivedAt !== null, true)
    assert.equal(updated.ancestry[1]?.forkPoint?.commitSha, checkpoint)
    assert.equal(updated.ancestry[1]?.forkPoint?.proofDigest, proof)
    assert.deepEqual(
      updated.state.runs.map((run) => run.jobId),
      [forkJob, followUp],
    )
    assert.equal(updated.state.messages.at(-1)?.content, 'Revise a clue')
    const turns = await a.testing.records.all<{ id: string }>('story_turns', { threadId: childId })
    assert.ok(turns.some(turn => turn.id === updated.state.messages.at(-1)?.id),
      'each new author request has a durable Turn independent of its execution')
    await assert.rejects(() => a.testing.records.update('story_threads', { id: childId },
      { parentThreadId: null }), /immutable|constraint/i)
    await assert.rejects(() => a.testing.records.update('checkpoint_forks', { childId: forkJob },
      { commitSha: base }), /immutable/i)
    assert.equal((await listStoryThreads(a, owner, story)).threads.length, 3)
    assert.ok(
      !('preferences' in (await listStoryThreads(a, owner, story))),
      'display preferences do not belong to the revision gateway',
    )
    await assert.rejects(() => openStoryThread(b, stranger, story, childId), /Story not found\./)
    assert.deepEqual(await a.testing.foreignKeyViolations(), [])
    const finalRestart = await openStoryThread(b, owner, story, restartId)
    assert.equal(finalRestart.ancestry[2]?.forkPoint?.commitSha, checkpoint)
    a.close()
    b.close()
    const reopened = openStudioDatabase(path)
    try {
      const persisted = await openStoryThread(reopened, owner, story, childId)
      assert.deepEqual(persisted.ancestry, updated.ancestry)
      assert.deepEqual(persisted.state.runs, updated.state.runs)
      assert.deepEqual(persisted.state.messages, updated.state.messages)
      assert.equal((await listStoryThreads(reopened, owner, story)).threads.length, 3)
      assert.deepEqual(
        (await openStoryThread(reopened, owner, story, restartId)).ancestry,
        finalRestart.ancestry,
      )
    } finally {
      reopened.close()
    }
  } finally {
    a.close()
    b.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
