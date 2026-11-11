import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTestTree } from '../../test/helpers'
import { test } from 'node:test'
import { openStudioDatabase, migrateStudio } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { openStoryThread } from '../src/lib/story-threads.server'

const config = {
  baseURL: 'http://localhost:3000', secret: 'foundation-only-completion-secret-1234567890',
  github: { clientId: 'github', clientSecret: 'secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'secret' },
}

test('foundation-only completion is owner-scoped, idempotent and never queues full-Story work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-foundation-completion-'))
  let db = openStudioDatabase(join(root, 'studio.sqlite'))
  try {
    await migrateStudio(db, config)
    const seed = studioSeed(db)
    const owner = randomUUID(), outsider = randomUUID(), repo = randomUUID()
    const storyId = randomUUID(), jobId = randomUUID()
    const sha = 'a'.repeat(40), at = new Date().toISOString()
    await seed.user(owner)
    await seed.user(outsider)
    await seed.repository({ id: repo, ownerUserId: owner,
      provider: 'github', providerRepositoryId: '42', name: 'Owner/Story', createdAt: at })
    await seed.story({ id: storyId, ownerUserId: owner, repositoryId: repo,
      directory: 'story', title: 'Story', sourceCommitSha: sha, createdAt: at })
    const objective = 'Only the creative direction for a mystery game'
    await db.persistence.naturalStory.beginFirstTurn(owner, storyId, jobId, objective, at)
    await db.persistence.generation.jobs.register(owner, jobId, storyId, 'Story', sha, at)
    await db.persistence.conversations.reconcileRoots(owner, storyId)
    await assert.rejects(() =>
      db.persistence.naturalStory.finishFoundationOnly(outsider, storyId, jobId))
    await db.persistence.naturalStory.finishFoundationOnly(owner, storyId, jobId)
    await db.persistence.naturalStory.finishFoundationOnly(owner, storyId, jobId)
    const thread = await openStoryThread(db, owner, storyId, 'root:' + jobId)
    assert.equal(thread.state.messages[0]?.phase, 'finished')
    assert.equal(thread.state.messages[0]?.jobId, jobId)
    assert.deepEqual(thread.state.turns, [{ id: jobId, executionIds: [jobId] }])
    assert.equal((await db.persistence.generation.jobs.state(owner, jobId))?.status, 'completed')
    assert.equal(await db.persistence.generation.queue.record(jobId), null)
    assert.equal((await db.persistence.naturalStory.beginFirstTurn(owner,
      storyId, jobId, objective, at)).state, 'admitted')
    assert.deepEqual(await db.testing.foreignKeyViolations(), [])
    await db.close()
    db = openStudioDatabase(join(root, 'studio.sqlite'))
    const restored = await openStoryThread(db, owner, storyId, 'root:' + jobId)
    assert.deepEqual(restored.state.turns, [{ id: jobId, executionIds: [jobId] }])
    assert.equal(restored.state.messages[0]?.phase, 'finished')
    await db.persistence.naturalStory.finishFoundationOnly(owner, storyId, jobId)
    assert.equal(await db.persistence.generation.queue.record(jobId), null)
  } finally { void db.close(); removeTestTree(root) }
})
