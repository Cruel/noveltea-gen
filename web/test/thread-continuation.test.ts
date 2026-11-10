import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { openWebGenerationGraph } from '../../src/web-fixture-runtime'
import { claimServerGeneration } from '../../src/generation-owner'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { migrateStudio } from './support/studio-database'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { enqueueThreadMessage, advanceThread, readThreadChat } from '../src/lib/thread-chat.server'
import { ensureRootThreads } from '../src/lib/threads.server'

const config = { baseURL: 'http://localhost:3000', secret: 'thread-successor-test-012345678901234567890',
  github: { clientId: 'test', clientSecret: 'test' }, gitlab: { clientId: 'test', clientSecret: 'test' } }
const contract = {
  scope: { kind: 'full-story' as const, depth: 'composition' as const, targets: [], branches: [] },
  constraints: [], envelope: { presentation: 'Dialogue-led novel', hardLimits: [], preferences: [] },
}
const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

test('legacy unscoped Thread messages cannot inherit a full-Story writer on a completed continuation', {
  timeout: 60_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-thread-continuation-'))
  const before = Object.fromEntries(['NT_STATE_DIR', 'NT_GIT_CACHE_DIR', 'NT_STUDIO_SKILLS_SOURCE']
    .map(key => [key, process.env[key]]))
  process.env.NT_STATE_DIR = join(root, 'state')
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  delete process.env.NT_STUDIO_SKILLS_SOURCE
  const store = openStudioDatabase(join(root, 'studio.sqlite'))
  try {
    await migrateStudio(store, config)
    const user = randomUUID(), repoId = randomUUID(), storyId = randomUUID()
    const parentId = randomUUID(), threadId = 'root:' + parentId
    const seed = studioSeed(store)
    ;(await seed.user(user, 0))
    ;(await seed.repository({ id: repoId, ownerUserId: user, provider: 'github',
      providerRepositoryId: '123', name: 'Repo', createdAt: 'now' }))
    const remote = join(root, 'remote')
    mkdirSync(join(remote, 'story'), { recursive: true })
    writeFileSync(join(remote, 'story', 'story.md'), '# Previously committed Story\n')
    git(remote, 'init', '-q')
    git(remote, 'config', 'user.name', 'Author')
    git(remote, 'config', 'user.email', 'author@example.test')
    git(remote, 'add', '.')
    git(remote, 'commit', '-qm', 'Story baseline')
    const sha = git(remote, 'rev-parse', 'HEAD')
    ;(await seed.story({ id: storyId, ownerUserId: user, repositoryId: repoId,
      directory: 'story', title: 'Story', createdAt: 'now', sourceCommitSha: sha }))
    const parent = await acquireCachedStory({ cacheDirectory: process.env.NT_GIT_CACHE_DIR!,
      ownerId: user, repositoryId: 'github:123', remoteUrl: 'file://' + remote,
      token: '', directory: 'story', commit: sha, jobId: parentId })
    const request = { story: parent.storyRoot, job: parent.jobId,
      task: 'Original generation request', contract, fixture: true }
    ;(await seed.job({ id: parentId, ownerUserId: user, storyId, title: 'Story',
      sourceCommitSha: sha, status: 'completed', createdAt: 'now', updatedAt: 'now',
      generationRequestJson: JSON.stringify(request),
      generationThreadId: parent.threadId + ':generation:web',
      generationConfigJson: JSON.stringify({
        version: 1, headSha: sha, task: request.task, contract, limits: {}, model: null,
      }) }))
    ;(await seed.queue({ jobId: parentId, ownerUserId: user, intent: 'start',
      phase: 'finished', createdAt: 'now', updatedAt: 'now' }))
    await ensureRootThreads(store, user, storyId)
    await claimServerGeneration(parent, parent.threadId + ':generation:web', request)
    const graph = openWebGenerationGraph(join(parent.stateDir, 'web-generation.sqlite'))
    await graph.graph.updateState({ configurable: { thread_id: parent.threadId + ':generation:web' } },
      { request, status: 'completed', completedStages: [] })
    await graph.graph.updateState({ configurable: { thread_id: parent.threadId + ':generation:web' } },
      { status: 'completed' }, 'completion_decision')
    graph.saver.db.close()
    const first = randomUUID(), second = randomUUID()
    await enqueueThreadMessage(store, user, threadId, first, 'Expand the ending')
    await enqueueThreadMessage(store, user, threadId, second, 'Then explore the aftermath')
    await Promise.all([advanceThread(store, user, threadId), advanceThread(store, user, threadId)])
    const chat = (await readThreadChat(store, user, threadId))
    assert.equal(chat.messages.find(m => m.id === first)?.phase, 'queued')
    assert.equal(chat.messages.find(m => m.id === second)?.phase, 'queued')
    assert.equal(chat.messages.at(-1)?.content, 'Then explore the aftermath')
    assert.deepEqual(chat.runs.map(run => run.jobId), [parentId])
    assert.equal(git(parent.worktreeRoot, 'rev-parse', 'HEAD'), sha)
    assert.deepEqual((await store.testing.foreignKeyViolations()), [])
  } finally {
    store.close()
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
})
