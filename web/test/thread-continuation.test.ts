import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { openWebGenerationGraph } from '../../src/web-fixture-runtime'
import { claimServerGeneration } from '../../src/generation-owner'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { selectedJob, restoreJob, pinnedRequest, inspectRegisteredJob } from '../src/lib/fixture-jobs.server'
import { enqueueThreadMessage, advanceThread, readThreadChat, settleThreadRun } from '../src/lib/thread-chat.server'
import { ensureRootThreads } from '../src/lib/threads.server'

const config = { baseURL: 'http://localhost:3000', secret: 'thread-successor-test-012345678901234567890',
  github: { clientId: 'test', clientSecret: 'test' }, gitlab: { clientId: 'test', clientSecret: 'test' } }
const contract = {
  scope: { kind: 'full-story' as const, depth: 'composition' as const, targets: [], branches: [] },
  constraints: [], envelope: { presentation: 'Dialogue-led novel', hardLimits: [], preferences: [] },
}
const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

test('completed Thread follow-ups allocate one sequential job per message from the verified Git baseline', {
  timeout: 60_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-thread-continuation-'))
  const before = Object.fromEntries(['NT_STATE_DIR', 'NT_GIT_CACHE_DIR', 'NT_STUDIO_SKILLS_SOURCE']
    .map(key => [key, process.env[key]]))
  const state = join(root, 'state'), cache = join(root, 'cache')
  process.env.NT_STATE_DIR = state
  process.env.NT_GIT_CACHE_DIR = cache
  delete process.env.NT_STUDIO_SKILLS_SOURCE
  const store = openStudioDatabase(join(root, 'studio.sqlite'))
  try {
    await migrateStudio(store, config)
    const user = randomUUID(), repoId = randomUUID(), storyId = randomUUID()
    const parentId = randomUUID(), threadId = 'root:' + parentId
    store.sqlite.prepare(`INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt)
      VALUES (?,'Author',?,1,0,0)`).run(user, user + '@example.test')
    store.sqlite.prepare(`INSERT INTO repositories (id,owner_user_id,provider,
      provider_repository_id,name,created_at) VALUES (?,?,'github','123','Repo','now')`)
      .run(repoId, user)
    const remote = join(root, 'remote')
    mkdirSync(join(remote, 'story'), { recursive: true })
    writeFileSync(join(remote, 'story', 'story.md'), '# Previously committed Story\n')
    git(remote, 'init', '-q')
    git(remote, 'config', 'user.name', 'Author')
    git(remote, 'config', 'user.email', 'author@example.test')
    git(remote, 'add', '.')
    git(remote, 'commit', '-qm', 'Story baseline')
    const sha = git(remote, 'rev-parse', 'HEAD')
    store.sqlite.prepare(`INSERT INTO stories (id,owner_user_id,repository_id,directory,title,
      created_at,source_commit_sha) VALUES (?,?,?,'story','Story','now',?)`)
      .run(storyId, user, repoId, sha)
    const parent = await acquireCachedStory({ cacheDirectory: cache, ownerId: user,
      repositoryId: 'github:123', remoteUrl: 'file://' + remote, token: '',
      directory: 'story', commit: sha, jobId: parentId })
    const initialRequest = { story: parent.storyRoot, job: parent.jobId,
      task: 'Original generation request', contract, fixture: true }
    const draft = { version: 1, headSha: sha, task: initialRequest.task, contract,
      limits: { steps: 3 }, model: null }
    store.sqlite.prepare(`INSERT INTO studio_sessions (id,owner_user_id,story_id,title,
      source_commit_sha,status,created_at,updated_at,generation_request_json,
      generation_thread_id,generation_config_json)
      VALUES (?,?,?,'Story',?,'completed','now','now',?,?,?)`)
      .run(parentId, user, storyId, sha, JSON.stringify(initialRequest),
        parent.threadId + ':generation:web', JSON.stringify(draft))
    store.sqlite.prepare(`INSERT INTO generation_run_queue
      (job_id,owner_user_id,intent,phase,created_at,updated_at)
      VALUES (?,?,'start','finished','now','now')`).run(parentId, user)
    ensureRootThreads(store, user, storyId)
    // The persisted graph checkpoint and controller-owner receipt are required
    // by the same inspection path used for production admission.
    await claimServerGeneration(parent, parent.threadId + ':generation:web', initialRequest)
    const graph = openWebGenerationGraph(join(parent.stateDir, 'web-generation.sqlite'))
    await graph.graph.updateState({ configurable: { thread_id: parent.threadId + ':generation:web' } },
      { request: initialRequest, status: 'completed', completedStages: [] })
    await graph.graph.updateState({ configurable: { thread_id: parent.threadId + ':generation:web' } },
      { status: 'completed' }, 'completion_decision')
    const snapshot = await graph.graph.getState({ configurable: { thread_id: parent.threadId + ':generation:web' } })
    assert.equal((snapshot.values as { status?: string }).status, 'completed', JSON.stringify(snapshot.values))
    graph.saver.db.close()
    const sourceStatus = await inspectRegisteredJob(store, selectedJob(store, user, parentId), user)
    assert.equal(sourceStatus.status, 'completed', JSON.stringify(sourceStatus))
    const firstId = randomUUID(), secondId = randomUUID()
    enqueueThreadMessage(store, user, threadId, firstId, 'Expand the ending')
    enqueueThreadMessage(store, user, threadId, secondId, 'Then explore the aftermath')
    await Promise.all([advanceThread(store, user, threadId), advanceThread(store, user, threadId)])
    const firstRow = store.sqlite.prepare(`SELECT r.job_id AS jobId,r.run_order AS runOrder,
      q.phase FROM story_thread_runs r JOIN generation_run_queue q ON q.job_id=r.job_id
      WHERE r.thread_id=? AND r.run_order=1`).get(threadId) as
      { jobId: string; runOrder: number; phase: string } | undefined
    assert.equal(firstRow?.jobId, firstId)
    assert.equal(firstRow.phase, 'queued')
    assert.equal((store.sqlite.prepare(`SELECT count(*) AS total FROM story_thread_runs
      WHERE thread_id=?`).get(threadId) as { total: number }).total, 2)
    const first = await restoreJob(selectedJob(store, user, firstId), user)
    assert.equal(first.baseSha, sha)
    assert.notEqual(first.threadId, parent.threadId)
    assert.equal(readFileSync(join(first.worktreeStoryRoot, 'story.md'), 'utf8'),
      '# Previously committed Story\n')
    assert.equal(existsSync(join(first.stateDir, 'web-generation.sqlite')), false,
      'a successor must have a fresh graph history')
    assert.equal(existsSync(join(first.stateDir, 'pi-budget.json')), false,
      'the prior budget and receipts must not be copied')
    const saved = selectedJob(store, user, firstId)
    const newPinned = pinnedRequest(saved, first)!
    assert.equal(newPinned.task, 'Expand the ending')
    assert.deepEqual(newPinned.contract, contract)
    assert.equal(newPinned.fixture, true)
    assert.deepEqual(JSON.parse(saved.configJson!).limits, { steps: 3 })
    assert.equal(store.sqlite.prepare(`SELECT phase FROM story_thread_messages
      WHERE id=?`).get(secondId) !== undefined, true)
    assert.deepEqual(readThreadChat(store, user, threadId).messages
      .filter(item => item.role === 'user').map(item => item.content),
      ['Original generation request', 'Expand the ending', 'Then explore the aftermath'])

    // Simulate the agent recording the first graph outcome: only *then* can
    // settlement admit a second run; it must use the already verified state.
    store.sqlite.prepare(`UPDATE generation_run_queue SET phase='finished' WHERE job_id=?`).run(firstId)
    store.sqlite.prepare(`UPDATE studio_sessions SET status='completed' WHERE id=?`).run(firstId)
    await claimServerGeneration(first, first.threadId + ':generation:web', newPinned)
    const completed = openWebGenerationGraph(join(first.stateDir, 'web-generation.sqlite'))
    await completed.graph.updateState({ configurable: { thread_id: first.threadId + ':generation:web' } },
      { request: newPinned, completedStages: [] })
    await completed.graph.updateState({ configurable: { thread_id: first.threadId + ':generation:web' } },
      { status: 'completed' }, 'completion_decision')
    completed.saver.db.close()
    await settleThreadRun(store, user, firstId)
    const delivered = store.sqlite.prepare(`SELECT status,verified_commit_sha AS verifiedSha
      FROM story_thread_messages WHERE id=?`).get(firstId) as
      { status: string; verifiedSha: string | null }
    assert.deepEqual(delivered, { status: 'delivered', verifiedSha: sha })
    const secondRow = store.sqlite.prepare(`SELECT r.job_id AS jobId,r.run_order AS runOrder
      FROM story_thread_runs r WHERE r.thread_id=? AND r.run_order=2`).get(threadId) as
      { jobId: string; runOrder: number } | undefined
    assert.equal(secondRow?.jobId, secondId)
    const second = await restoreJob(selectedJob(store, user, secondId), user)
    assert.equal(second.baseSha, sha)
    assert.notEqual(second.threadId, first.threadId)
    assert.equal(pinnedRequest(selectedJob(store, user, secondId), second)?.task,
      'Then explore the aftermath')
    await settleThreadRun(store, user, firstId)
    const messages = readThreadChat(store, user, threadId).messages
    assert.equal(messages.filter(item => item.id === 'assistant:' + firstId).length, 1)
    assert.equal(messages.find(item => item.id === firstId)?.phase, 'finished')
    assert.equal(messages.find(item => item.id === secondId)?.phase, 'running')
    assert.deepEqual(store.sqlite.pragma('foreign_key_check'), [])
  } finally {
    store.sqlite.close()
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
})
