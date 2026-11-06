import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { createConversation, ensureRootThreads, listStoryConversations } from '../src/lib/threads.server'
import { associateNaturalThread, previewNaturalStory, launchNaturalStory } from '../src/lib/natural-story.server'
import { createStudioAuth } from '../src/lib/auth'
import { readThreadChat } from '../src/lib/thread-chat.server'

const config = {
  baseURL: 'http://localhost:3000', secret: 'natural-story-test-secret-012345678901234567890',
  github: { clientId: 'github', clientSecret: 'secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'secret' },
}

test('natural prompt preview and initial Thread registration are owner scoped and retry safe', async () => {
  const db = openStudioDatabase(':memory:')
  try {
    await migrateStudio(db, config)
    const auth = createStudioAuth(db, config)
    const adapter = (await auth.$context).internalAdapter
    const alice = (await adapter.createUser({
      name: 'Alice', email: 'alice@example.test', emailVerified: true,
    }, { method: 'test' })).id
    const bob = (await adapter.createUser({
      name: 'Bob', email: 'bob@example.test', emailVerified: true,
    }, { method: 'test' })).id
    const storyId = randomUUID(), repo = randomUUID()
    const headSha = 'a'.repeat(40), jobId = randomUUID()
    await db.persistence.repositories.upsert(alice, 'github', '123', 'Owner/Repo', null, repo, 'now')
    await db.persistence.onboarding.importStory({
      id: storyId, owner: alice, repositoryId: repo, directory: 'story',
      title: 'Story', createdAt: 'now', commitSha: headSha,
    })
    const chosen = await createConversation(db, alice, storyId)
    const other = await createConversation(db, alice, storyId)
    const brief = 'Write a fantasy visual novel about a lost astronomer.'
    const preview = await previewNaturalStory(db, alice, chosen.id, brief)
    assert.equal(preview.plan.task, brief)
    assert.equal(preview.headSha, headSha)
    assert.equal(preview.plan.reviewRequired, false)
    assert.equal(preview.plan.contract.scope.depth, 'composition')
    assert.equal(preview.defaultModel, null)
    assert.deepEqual(preview.models, [])
    await assert.rejects(() => previewNaturalStory(db, bob, chosen.id, brief), /not found/)
    await assert.rejects(() => previewNaturalStory(db, alice, randomUUID(), brief), /not found/)
    const ambiguous = await previewNaturalStory(db, alice, chosen.id, 'Only brainstorm plot ideas')
    assert.equal(ambiguous.plan.reviewRequired, true)
    assert.ok(ambiguous.plan.clarification)
    const session = await adapter.createSession(alice)
    const headers = new Headers({ cookie: 'better-auth.session_token=' + session.token + '.' +
      createHmac('sha256', config.secret).update(session.token).digest('base64') })
    const candidate = { conversationId: chosen.id, jobId: randomUUID(), headSha, prompt: brief }
    await assert.rejects(() => launchNaturalStory(auth, db,
      new Headers({ ...Object.fromEntries(headers), origin: 'https://evil.example' }), config.baseURL,
      candidate), /Cross-origin/)
    await assert.rejects(() => launchNaturalStory(auth, db, headers, config.baseURL,
      { ...candidate, headSha: 'b'.repeat(40) }), /revision changed/)
    await assert.rejects(() => launchNaturalStory(auth, db, headers, config.baseURL,
      { ...candidate, limits: { modelCalls: -1 } }), /Budget limits/)
    await assert.rejects(() => launchNaturalStory(auth, db, headers, config.baseURL,
      { ...candidate, prompt: 'Only brainstorm plot ideas' }), /outline or ideation/)
    await assert.rejects(() => launchNaturalStory(auth, db, headers, config.baseURL,
      candidate), /Connect a Pi model/)
    assert.equal(await db.persistence.generation.jobs.identity(candidate.jobId), null,
      'rejected plans and missing credentials must not create jobs')

    await db.persistence.generation.jobs.register(alice, jobId, storyId, 'Story', headSha, 'now')
    await ensureRootThreads(db, alice, storyId)
    // Existing-job Conversations retain their legacy:UUID identity. The
    // composer must accept one of these while keeping the owner check.
    const legacyPreview = await previewNaturalStory(db, alice, 'legacy:' + jobId, brief)
    assert.equal(legacyPreview.storyId, storyId)
    await assert.rejects(() => previewNaturalStory(db, bob, 'legacy:' + jobId, brief), /not found/)
    assert.equal(await associateNaturalThread(db, alice, chosen.id, jobId, brief), 'root:' + jobId)
    assert.equal(await associateNaturalThread(db, alice, chosen.id, jobId, brief), 'root:' + jobId)
    await assert.rejects(() => associateNaturalThread(db, bob, chosen.id, jobId, brief), /not found/)
    await assert.rejects(() => associateNaturalThread(db, alice, other.id, jobId, brief), /already belongs/)
    const navigation = await listStoryConversations(db, alice, storyId)
    assert.equal(navigation.conversations.find(item => item.id === chosen.id)?.threads.length, 1)
    assert.equal(navigation.conversations.find(item => item.id === chosen.id)?.threads[0]?.title, brief)
    assert.equal(navigation.conversations.some(item => item.id === 'legacy:' + jobId), false)
    assert.deepEqual((await readThreadChat(db, alice, 'root:' + jobId)).messages, [])
  } finally { db.close() }
})
