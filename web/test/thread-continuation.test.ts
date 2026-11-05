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
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
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
    const parent = await acquireCachedStory({ cacheDirectory: process.env.NT_GIT_CACHE_DIR!,
      ownerId: user, repositoryId: 'github:123', remoteUrl: 'file://' + remote,
      token: '', directory: 'story', commit: sha, jobId: parentId })
    const request = { story: parent.storyRoot, job: parent.jobId,
      task: 'Original generation request', contract, fixture: true }
    store.sqlite.prepare(`INSERT INTO studio_sessions (id,owner_user_id,story_id,title,
      source_commit_sha,status,created_at,updated_at,generation_request_json,
      generation_thread_id,generation_config_json)
      VALUES (?,?,?,'Story',?,'completed','now','now',?,?,?)`)
      .run(parentId, user, storyId, sha, JSON.stringify(request),
        parent.threadId + ':generation:web', JSON.stringify({
          version: 1, headSha: sha, task: request.task, contract, limits: {}, model: null }))
    store.sqlite.prepare(`INSERT INTO generation_run_queue
      (job_id,owner_user_id,intent,phase,created_at,updated_at)
      VALUES (?,?,'start','finished','now','now')`).run(parentId, user)
    ensureRootThreads(store, user, storyId)
    await claimServerGeneration(parent, parent.threadId + ':generation:web', request)
    const graph = openWebGenerationGraph(join(parent.stateDir, 'web-generation.sqlite'))
    await graph.graph.updateState({ configurable: { thread_id: parent.threadId + ':generation:web' } },
      { request, status: 'completed', completedStages: [] })
    await graph.graph.updateState({ configurable: { thread_id: parent.threadId + ':generation:web' } },
      { status: 'completed' }, 'completion_decision')
    graph.saver.db.close()
    const first = randomUUID(), second = randomUUID()
    enqueueThreadMessage(store, user, threadId, first, 'Expand the ending')
    enqueueThreadMessage(store, user, threadId, second, 'Then explore the aftermath')
    await Promise.all([advanceThread(store, user, threadId), advanceThread(store, user, threadId)])
    const chat = readThreadChat(store, user, threadId)
    assert.equal(chat.messages.find(m => m.id === first)?.phase, 'blocked')
    assert.equal(chat.messages.find(m => m.id === second)?.phase, 'queued')
    assert.match(chat.messages.at(-1)?.content ?? '', /no reviewed revision scope/i)
    assert.deepEqual(chat.runs.map(run => run.jobId), [parentId])
    assert.equal(git(parent.worktreeRoot, 'rev-parse', 'HEAD'), sha)
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
