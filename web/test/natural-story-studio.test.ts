import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from './support/studio-database'
import { ensureRootThreads, listStoryNavigation } from '../src/lib/threads.server'
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
    const otherStory = randomUUID()
    await db.persistence.onboarding.importStory({
      id: otherStory, owner: alice, repositoryId: repo, directory: 'other',
      title: 'Other Story', createdAt: 'now', commitSha: headSha,
    })
    const brief = 'Write a fantasy visual novel about a lost astronomer.'
    const preview = await previewNaturalStory(db, alice, storyId, brief)
    assert.equal(preview.plan.task, brief)
    assert.equal(preview.headSha, headSha)
    assert.equal(preview.plan.reviewRequired, false)
    assert.equal(preview.plan.contract.scope.depth, 'composition')
    assert.equal(preview.defaultModel, null)
    assert.deepEqual(preview.models, [])
    await assert.rejects(() => previewNaturalStory(db, bob, storyId, brief), /not found/)
    await assert.rejects(() => previewNaturalStory(db, alice, randomUUID(), brief), /not found/)
    const unresolved = await previewNaturalStory(db, alice, storyId, 'Revise the conversation')
    assert.equal(unresolved.turnPlan, null, 'without native canon no first Turn may inherit a global writer')
    assert.equal(unresolved.plan.stages.length, 0)
    assert.match(unresolved.plan.clarification ?? '', /existing canonical Story/)
    const ambiguous = await previewNaturalStory(db, alice, storyId, 'Only brainstorm plot ideas')
    assert.equal(ambiguous.plan.reviewRequired, true)
    assert.ok(ambiguous.plan.clarification)
    const session = await adapter.createSession(alice)
    const headers = new Headers({ cookie: 'better-auth.session_token=' + session.token + '.' +
      createHmac('sha256', config.secret).update(session.token).digest('base64') })
    const candidate = { storyId, jobId: randomUUID(), headSha, prompt: brief }
    await assert.rejects(() => launchNaturalStory(auth, db,
      new Headers({ ...Object.fromEntries(headers), origin: 'https://evil.example' }), config.baseURL,
      candidate), /Cross-origin/)
    await assert.rejects(() => launchNaturalStory(auth, db, headers, config.baseURL,
      { ...candidate, headSha: 'b'.repeat(40) }), /revision changed/)
    await assert.rejects(() => launchNaturalStory(auth, db, headers, config.baseURL,
      { ...candidate, limits: { modelCalls: -1 } }), /Budget limits/)
    for (const limits of [{ activeSeconds: -1 }, { cpu: 0 }, { memoryMiB: 4 },
      { pids: 2 }, { cpu: 2, dockerOptions: '--privileged' }]) {
      await assert.rejects(() => launchNaturalStory(auth, db, headers, config.baseURL,
        { ...candidate, limits: limits as typeof candidate & { cpu?: number } }), /Budget limit|Unsupported job budget/)
    }
    await assert.rejects(() => launchNaturalStory(auth, db, headers, config.baseURL,
      { ...candidate, prompt: 'Only brainstorm plot ideas' }), /outline or ideation/)
    await assert.rejects(() => launchNaturalStory(auth, db, headers, config.baseURL,
      candidate), /Connect a Pi model/)
    assert.equal(await db.persistence.generation.jobs.identity(candidate.jobId), null,
      'rejected plans and missing credentials must not create jobs')

    await db.persistence.generation.jobs.register(alice, jobId, storyId, 'Story', headSha, 'now')
    await ensureRootThreads(db, alice, storyId)
    assert.equal(await associateNaturalThread(db, alice, storyId, jobId, brief), 'root:' + jobId)
    assert.equal(await associateNaturalThread(db, alice, storyId, jobId, brief), 'root:' + jobId)
    await assert.rejects(() => associateNaturalThread(db, bob, storyId, jobId, brief), /not found/)
    await assert.rejects(() => associateNaturalThread(db, alice, otherStory, jobId, brief), /already belongs/)
    const navigation = await listStoryNavigation(db, alice, storyId)
    assert.equal(navigation.threads.length, 1)
    assert.equal(navigation.threads[0]?.title, brief)
    assert.deepEqual((await readThreadChat(db, alice, 'root:' + jobId)).messages, [])
  } finally { db.close() }
})
