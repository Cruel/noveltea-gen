import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { openKyselyFeatureFixture } from './support/studio-database'

const at = '2026-11-09T12:00:00Z'
const later = '2026-11-09T13:00:00Z'
const sha = 'a'.repeat(40)
const pg = process.env.NT_TEST_PG_URL
if (process.env.NT_REQUIRE_KYSELY_PROOF === '1' && !pg)
  throw new Error('NT_TEST_PG_URL required for cross-backend Story/navigation conformance')

for (const backend of ['sqlite', 'postgres'] as const) {
  test(`${backend}: shared Story, Conversation/Thread and catalog contracts survive restart`, {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL for PostgreSQL conformance',
    timeout: 90_000,
  }, async (t) => {
    const fixture = await openKyselyFeatureFixture(backend)
    t.after(async () => fixture.close())
    const { records: data, onboarding, collections } = fixture
    const alice = await fixture.owner()
    const bob = await fixture.owner()
    const repo = randomUUID(), bobRepo = randomUUID(), story = randomUUID(), bobStory = randomUUID()
    for (const [id, ownerUserId] of [[repo, alice], [bobRepo, bob]]) {
      await data.insert('repositories', {
        id, ownerUserId, provider: 'github', providerRepositoryId: id,
        name: 'User/' + id, createdAt: at,
      })
    }
    const registration = {
      id: story, owner: alice, repositoryId: repo, directory: 'novel',
      title: 'Original', commitSha: sha, createdAt: at,
    }
    assert.equal((await onboarding.importStory(registration)).id, story)
    assert.equal((await onboarding.importStory({ ...registration, id: randomUUID(), title: 'Renamed' })).id, story)
    await onboarding.createStory({ ...registration, id: bobStory, owner: bob, repositoryId: bobRepo })
    await assert.rejects(onboarding.createStory({ ...registration, id: randomUUID() }), /unique|constraint/i)

    const { conversations, naturalStory, dashboard, settings } = fixture
    assert.equal((await naturalStory.story(alice, story))?.headSha, sha)
    assert.equal(await naturalStory.story(bob, story), null)
    assert.equal(await conversations.story(bob, story), null)
    assert.deepEqual(await conversations.navigation(alice, story), { threads: [] })
    assert.equal((await dashboard.forOwner(alice)).stories[0]?.title, 'Renamed')
    assert.deepEqual((await settings.listRepositories(bob)).map(r => r.id), [bobRepo])
    assert.equal(await settings.hasLegacyRepositories(alice, 'github'), true)
    await collections.chooseStory(alice, story, at)
    assert.equal((await dashboard.forOwner(alice)).selectedStoryId, story)
    assert.equal((await dashboard.forOwner(bob)).selectedStoryId, null)

    const firstJob = randomUUID()
    assert.deepEqual(await naturalStory.beginFirstTurn(alice, story, firstJob, 'Initial request', at), {
      headSha: sha, state: 'claimed',
    })
    assert.equal((await naturalStory.beginFirstTurn(alice, story, firstJob, 'Initial request', at)).state, 'pending')
    await assert.rejects(naturalStory.beginFirstTurn(bob, bobStory, firstJob, 'Initial request', at),
      /already belongs/)
    await assert.rejects(naturalStory.beginFirstTurn(alice, story, firstJob, 'Different request', at),
      /already belongs/)
    await assert.rejects(naturalStory.finishFirstTurn(alice, story, firstJob, true), /not durably admitted/)
    await naturalStory.finishFirstTurn(alice, story, firstJob, false)
    assert.equal((await naturalStory.beginFirstTurn(alice, story, firstJob, 'Initial request', later)).state, 'claimed')

    await data.insert('studio_sessions', {
      id: firstJob, ownerUserId: alice, storyId: story, title: 'Initial',
      status: 'completed', sourceCommitSha: sha, createdAt: at, updatedAt: later,
      generationRequestJson: '{"task":"Initial"}',
    })
    await data.insert('story_thread_runs', {
      jobId: firstJob, threadId: 'root:' + firstJob, ownerUserId: alice, runOrder: 0,
    })
    await data.insert('generation_run_queue', {
      jobId: firstJob, ownerUserId: alice, intent: 'start', phase: 'finished',
      createdAt: at, updatedAt: later,
    })
    await naturalStory.finishFirstTurn(alice, story, firstJob, true)
    assert.equal((await naturalStory.beginFirstTurn(alice, story, firstJob, 'Initial request', later)).state,
      'admitted')
    assert.equal((await naturalStory.previousJob(alice, firstJob))?.threadId, 'root:' + firstJob)
    assert.equal(await naturalStory.previousJob(bob, firstJob), null)
    assert.equal(await naturalStory.associateRoot(alice, story, firstJob, 'Better title', later), 'root:' + firstJob)

    const root = 'root:' + firstJob
    const child = randomUUID(), collection = randomUUID()
    await data.insert('story_threads', {
      id: child, ownerUserId: alice, storyId: story, title: 'Child',
      parentThreadId: root, createdAt: later, activityAt: later,
    })
    await collections.create(alice, story, collection, 'Drafts', at)
    assert.equal(await collections.assign(alice, story, child, collection), true)
    // A Thread may have many executions; only the latest run is selected.
    // Event IDs, not timestamps or physical insertion order, choose current work.
    const continuation = randomUUID()
    await data.insert('studio_sessions', {
      id: continuation, ownerUserId: alice, storyId: story, title: 'Follow up',
      status: 'running', sourceCommitSha: sha, createdAt: later, updatedAt: later,
    })
    await data.insert('story_thread_runs', {
      jobId: continuation, threadId: root, ownerUserId: alice, runOrder: 1,
      needsAuthor: 1,
    })
    await data.insert('generation_run_queue', {
      jobId: continuation, ownerUserId: alice, intent: 'resume', phase: 'running',
      createdAt: at, updatedAt: later,
    })
    await data.insert('generation_events', {
      jobId: continuation, ownerUserId: alice, kind: 'started', createdAt: at,
    })
    await data.insert('generation_events', {
      jobId: continuation, ownerUserId: alice, kind: 'working', stage: 'old-stage',
      milestone: 'Old', createdAt: at,
    })
    await data.insert('generation_events', {
      jobId: continuation, ownerUserId: alice, kind: 'started', createdAt: later,
    })
    await data.insert('generation_events', {
      jobId: continuation, ownerUserId: alice, kind: 'working',
      stage: 'new-stage', milestone: 'New', createdAt: later,
    })
    const nav = (await conversations.navigation(alice, story)).threads
    const current = nav.find(t => t.id === root)!
    assert.equal(nav.filter(t => t.id === root).length, 1)
    assert.equal(current.jobId, continuation)
    assert.equal(current.needsAuthor, true)
    assert.equal(current.queuePhase, 'running')
    assert.equal(current.workingStage, 'new-stage')
    assert.equal(current.workingMilestone, 'New')
    assert.equal(current.lastEventAt, later)
    assert.equal(nav.find(t => t.id === child)?.collectionId, collection)
    assert.equal((await conversations.navigation(alice, story)).threads.find(t => t.id === child)?.parentThreadId,
      root)
    assert.equal(await conversations.renameThread(bob, root, 'Stolen'), false)
    assert.equal(await conversations.renameThread(alice, root, 'Final'), true)
    assert.equal(await conversations.setCreativePolicy(alice, child, '{"mode":"autonomous"}'), true)
    assert.equal(await conversations.archiveThread(alice, child, true, later), true)
    assert.equal(await conversations.archiveThread(alice, child, true, later), true)
    assert.equal(await conversations.archiveThread(bob, child, true, later), false)
    assert.equal((await conversations.navigation(alice, story)).threads.find(t => t.id === child)?.archivedAt,
      later)
    assert.equal((await conversations.deletion(alice, root))?.children, 1)
    assert.equal(await conversations.beginDeletion(alice, root, [firstJob, continuation], '{}', later), false,
      'an unsettled author message prevents deletion')
    assert.equal(await conversations.beginDeletion(bob, child, [], '{}', later), false)
    assert.equal(await conversations.archiveThread(alice, child, false, later), true)

    const leaf = await conversations.create(alice, story, randomUUID(), later)
    assert.equal(leaf.title, 'New Thread')
    assert.equal(await conversations.beginDeletion(alice, leaf.id, [], '{"preserveReceipts":false}', later), true)
    assert.equal(await conversations.beginDeletion(alice, leaf.id, [], '{"preserveReceipts":false}', later), true,
      'same plan is idempotent')
    assert.equal(await conversations.beginDeletion(alice, leaf.id, [], '{}', later), false,
      'a changed deletion plan may not be replayed')
    await conversations.finishDeletion(alice, leaf.id, later, 42)
    await conversations.finishDeletion(alice, leaf.id, later, 99)
    assert.equal((await conversations.deletion(alice, leaf.id))?.bytes, 42)
    assert.equal(await conversations.renameThread(alice, leaf.id, 'Forbidden'), false)

    const legacyJob = randomUUID()
    await data.insert('studio_sessions', {
      id: legacyJob, ownerUserId: alice, storyId: story, title: 'Legacy',
      status: 'completed', sourceCommitSha: sha, createdAt: at, updatedAt: later,
    })
    await Promise.all([
      conversations.reconcileRoots(alice, story),
      conversations.reconcileRoots(alice, story),
    ])
    assert.equal((await conversations.navigation(alice, story)).threads.filter(t => t.id === 'root:' + legacyJob).length,
      1)
    assert.equal((await conversations.usageRuns(alice, story)).length, 3)
    assert.equal((await dashboard.forOwner(alice)).recentSessions.length, 2)
    assert.equal((await dashboard.forOwner(bob)).recentSessions.length, 0)

    // A completed leaf can be tombstoned while its execution receipts remain.
    const cleanThread = await conversations.create(alice, story, randomUUID(), later)
    const cleanJob = randomUUID()
    await data.insert('studio_sessions', {
      id: cleanJob, ownerUserId: alice, storyId: story, title: 'Clean',
      status: 'completed', sourceCommitSha: sha, createdAt: later, updatedAt: later,
    })
    await data.insert('story_thread_runs', {
      jobId: cleanJob, threadId: cleanThread.id, ownerUserId: alice, runOrder: 0,
    })
    assert.equal(await conversations.beginDeletion(alice, cleanThread.id, [cleanJob], '{}', later), true)
    assert.equal(await conversations.deletedJob(alice, cleanJob), true)
    assert.equal(await conversations.deletedJob(bob, cleanJob), false)
    assert.equal(await conversations.beginDeletion(alice, cleanThread.id, [cleanJob], '{}', later), true)

    await settings.putThreadPreferences(alice, story, 'tree', [root], at, [collection, 'ungrouped', 'removed'])
    assert.deepEqual((await settings.getThreadPreferences(alice, story))?.collapsedCollectionIds,
      [collection, 'ungrouped'])
    assert.equal(await settings.getThreadPreferences(bob, story), null)
    await settings.putDefaultModel(alice, { provider: 'openai', id: 'model' }, at)
    assert.deepEqual((await settings.getDefaultModel(alice))?.selection, {
      provider: 'openai', id: 'model',
    })

    const reopened = await fixture.reopenNavigation()
    assert.equal((await reopened.conversations.navigation(alice, story)).threads.find(t => t.id === root)?.title,
      'Final')
    assert.equal((await reopened.collections.selectedStory(alice)), story)
    assert.equal((await reopened.settings.getThreadPreferences(alice, story))?.view, 'tree')
    assert.equal((await reopened.conversations.deletion(alice, leaf.id))?.completedAt, later)
    assert.equal((await reopened.naturalStory.story(bob, story)), null)
    assert.equal((await reopened.dashboard.forOwner(bob)).stories.length, 1)
  })
}
