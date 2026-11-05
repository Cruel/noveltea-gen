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
    const alice = randomUUID(), bob = randomUUID(), storyId = randomUUID(), repo = randomUUID()
    for (const owner of [alice, bob]) {
      db.sqlite.prepare(`INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?)`).run(owner, 'Author', owner + '@example.test', 1, Date.now(), Date.now())
    }
    const headSha = 'a'.repeat(40), jobId = randomUUID()
    db.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES (?,?,'github','123','Owner/Repo','now')`).run(repo, alice)
    db.sqlite.prepare(`INSERT INTO stories
      (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha)
      VALUES (?,?,?,'story','Story','now',?)`).run(storyId, alice, repo, headSha)
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
    const auth = createStudioAuth(db, config)
    const session = await (await auth.$context).internalAdapter.createSession(alice)
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
    assert.equal((db.sqlite.prepare('SELECT count(*) AS count FROM studio_sessions')
      .get() as { count: number }).count, 0,
    'rejected plans and missing credentials must not create jobs')

    db.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at)
      VALUES (?,?,?,'Story',?,'paused','now','now')`).run(jobId, alice, storyId, headSha)
    ensureRootThreads(db, alice, storyId)
    // Existing-job Conversations retain their legacy:UUID identity. The
    // composer must accept one of these while keeping the owner check.
    const legacyPreview = await previewNaturalStory(db, alice, 'legacy:' + jobId, brief)
    assert.equal(legacyPreview.storyId, storyId)
    await assert.rejects(() => previewNaturalStory(db, bob, 'legacy:' + jobId, brief), /not found/)
    assert.equal(associateNaturalThread(db, alice, chosen.id, jobId, brief), 'root:' + jobId)
    assert.equal(associateNaturalThread(db, alice, chosen.id, jobId, brief), 'root:' + jobId)
    assert.throws(() => associateNaturalThread(db, bob, chosen.id, jobId, brief), /not found/)
    assert.throws(() => associateNaturalThread(db, alice, other.id, jobId, brief), /already belongs/)
    const navigation = await listStoryConversations(db, alice, storyId)
    assert.equal(navigation.conversations.find(item => item.id === chosen.id)?.threads.length, 1)
    assert.equal(navigation.conversations.find(item => item.id === chosen.id)?.threads[0]?.title, brief)
    assert.equal(navigation.conversations.some(item => item.id === 'legacy:' + jobId), false)
    assert.deepEqual((await readThreadChat(db, alice, 'root:' + jobId)).messages, [])
    assert.deepEqual(db.sqlite.pragma('foreign_key_check'), [])
  } finally { db.sqlite.close() }
})
