import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { migrateStudio } from '../src/db/migrations'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import {
  createCollection,
  renameCollection,
  removeCollection,
  assignThreadCollection,
  chooseStory,
  listStoryNavigation,
  saveThreadPreferences,
} from '../src/lib/threads.server'
import { openStoryThread } from '../src/lib/story-threads.server'
import { orderThreads } from '../src/lib/thread-navigation'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'thread-collections-test-secret-0123456789012345678',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}
const at = '2026-11-08T12:00:00Z'
const rootHead = 'a'.repeat(40),
  forkHead = 'b'.repeat(40)

test('Collections group Story Threads without changing fork ancestry, activity order or safe deletion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-thread-collections-'))
  const path = join(dir, 'studio.sqlite')
  const db = openStudioDatabase(path)
  try {
    await migrateStudio(db, config)
    const seed = studioSeed(db)
    const alice = randomUUID(),
      bob = randomUUID(),
      repo = randomUUID(),
      story = randomUUID(),
      otherStory = randomUUID(),
      root = randomUUID(),
      child = randomUUID(),
      peer = randomUUID()
    await seed.user(alice)
    await seed.user(bob)
    await seed.repository({
      id: repo,
      ownerUserId: alice,
      provider: 'github',
      providerRepositoryId: '123',
      name: 'Owner/Repo',
      createdAt: at,
    })
    for (const [id, directory] of [
      [story, 'story'],
      [otherStory, 'elsewhere'],
    ] as const)
      await seed.story({
        id,
        ownerUserId: alice,
        repositoryId: repo,
        directory,
        title: directory,
        sourceCommitSha: rootHead,
        createdAt: at,
      })
    for (const [id, parentThreadId, activityAt] of [
      [root, null, '2026-11-01T00:00:00Z'],
      [child, root, '2026-11-05T00:00:00Z'],
      [peer, null, '2026-11-03T00:00:00Z'],
    ] as const)
      await seed.thread({
        id,
        ownerUserId: alice,
        storyId: story,
        parentThreadId,
        title: id,
        createdAt: at,
        activityAt,
      })
    const first = await listStoryNavigation(db, alice, story)
    assert.deepEqual(first.collections, [])
    assert.ok(first.threads.every((thread) => thread.collectionId === null))
    assert.deepEqual(
      orderThreads(first.threads, 'tree').map((thread) => thread.id),
      [root, child, peer],
    )
    assert.deepEqual(
      orderThreads(first.threads, 'flat').map((thread) => thread.id),
      [child, peer, root],
    )

    const research = await createCollection(db, alice, story, 'Research')
    const drafts = await createCollection(db, alice, story, 'Drafts')
    await assignThreadCollection(db, alice, story, root, research.id)
    await assignThreadCollection(db, alice, story, child, drafts.id)
    await assignThreadCollection(db, alice, story, peer, research.id)
    const grouped = await listStoryNavigation(db, alice, story)
    assert.deepEqual(
      grouped.threads.map((t) => [t.id, t.collectionId]),
      [
        [root, research.id],
        [child, drafts.id],
        [peer, research.id],
      ],
    )
    assert.deepEqual(
      orderThreads(grouped.threads, 'tree').map((t) => t.id),
      [root, child, peer],
    )
    const ancestry = await openStoryThread(db, alice, story, child)
    assert.deepEqual(
      ancestry.ancestry.map((node) => node.id),
      [root, child],
    )
    assert.equal(ancestry.ancestry[1]?.parentThreadId, root)
    await renameCollection(db, alice, story, drafts.id, 'Writing')
    await saveThreadPreferences(db, alice, story, 'flat', [root], [research.id])
    await chooseStory(db, alice, story)
    assert.equal(await db.persistence.collections.selectedStory(alice), story)
    assert.deepEqual((await listStoryNavigation(db, alice, story)).preferences, {
      view: 'flat',
      expandedIds: [root],
      collapsedCollectionIds: [research.id],
    })

    await assert.rejects(() => assignThreadCollection(db, bob, story, root, research.id), /not found/)
    await assert.rejects(() => assignThreadCollection(db, alice, otherStory, root, research.id), /not found/)
    await assert.rejects(() => assignThreadCollection(db, alice, story, child, randomUUID()), /not found/)
    await assert.rejects(() => renameCollection(db, bob, story, research.id, 'Hacked'), /not found/)
    await assert.rejects(() => removeCollection(db, alice, otherStory, research.id), /not found/)
    await assert.rejects(() => chooseStory(db, bob, story), /not found/)
    await assert.rejects(() => createCollection(db, bob, story, 'Foreign'), /not found/)
    await assert.rejects(() => createCollection(db, alice, story, '  '), /name/i)

    await removeCollection(db, alice, story, research.id)
    const afterRemove = await listStoryNavigation(db, alice, story)
    assert.deepEqual(
      afterRemove.collections.map((c) => c.name),
      ['Writing'],
    )
    assert.equal(afterRemove.threads.find((t) => t.id === root)?.collectionId, null)
    assert.equal(afterRemove.threads.find((t) => t.id === peer)?.collectionId, null)
    assert.equal(afterRemove.threads.find((t) => t.id === child)?.collectionId, drafts.id)
    assert.deepEqual((await openStoryThread(db, alice, story, child)).ancestry, ancestry.ancestry)
    assert.deepEqual(await db.testing.foreignKeyViolations(), [])
    db.close()

    const reopened = openStudioDatabase(path)
    try {
      const recovered = await listStoryNavigation(reopened, alice, story)
      assert.deepEqual(
        recovered.collections.map((c) => c.name),
        ['Writing'],
      )
      assert.equal(recovered.threads.find((t) => t.id === child)?.collectionId, drafts.id)
      assert.equal(recovered.preferences.view, 'flat')
      assert.deepEqual(
        recovered.preferences.collapsedCollectionIds,
        [],
        'removed Collections cannot retain unusable collapsed IDs',
      )
      assert.equal(await reopened.persistence.collections.selectedStory(alice), story)
      assert.deepEqual((await openStoryThread(reopened, alice, story, child)).ancestry, ancestry.ancestry)
    } finally {
      reopened.close()
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
