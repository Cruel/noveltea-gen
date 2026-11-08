import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { JobStartResult } from '../../src/job'
import { removeTestTree } from '../../test/helpers'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { migrateStudio } from '../src/db/migrations'
import { snapshotForkBoundaryHistory, recordForkBoundaryHistory } from '../src/lib/thread-fork-history.server'

const config = {
  baseURL: 'http://localhost:3000', secret: 'thread-fork-test-secret-0123456789abcdef',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

test('real Git ancestry freezes only verified history at the checkpoint, excluding future and queued messages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-fork-history-'))
  const db = openStudioDatabase(':memory:')
  try {
    await migrateStudio(db, config)
    git(root, 'init', '-q')
    git(root, 'config', 'user.name', 'Author')
    git(root, 'config', 'user.email', 'test@example.local')
    const commit = (name: string) => {
      writeFileSync(join(root, 'story.txt'), name)
      git(root, 'add', '.')
      git(root, 'commit', '-qm', name)
      return git(root, 'rev-parse', 'HEAD')
    }
    const initial = commit('initial')
    const forkSha = commit('World verified')
    const futureSha = commit('Character verified')
    const owner = randomUUID(), story = randomUUID(), repo = randomUUID()
    const parentThread = randomUUID(), childThread = randomUUID()
    const jobId = randomUUID()
    const seed = studioSeed(db)
    ;(await seed.user(owner))
    ;(await seed.repository({ id: repo, ownerUserId: owner, provider: 'github',
      providerRepositoryId: 'provider', name: 'Repo', createdAt: 'now' }))
    ;(await seed.story({ id: story, ownerUserId: owner, repositoryId: repo,
      directory: 'story', title: 'Story', createdAt: 'now' }))
    for (const [id, parent] of [[parentThread, null], [childThread, parentThread]] as const) {
      (await seed.thread({ id, ownerUserId: owner, storyId: story,
        parentThreadId: parent, title: 'Branch', activityAt: 'now', createdAt: 'now' }))
    }
    const addMessage = async (id: string, ownerUserId: string, threadId: string,
      sequence: number, status: string, body: string, verifiedCommitSha: string | null) => {
      ;(await db.testing.records.insert('story_thread_messages', { id, ownerUserId, threadId,
        sequence, role: 'user', status, body, verifiedCommitSha, createdAt: 'now' }))
    }
    await addMessage(randomUUID(), owner, parentThread, 0, 'delivered', 'Initial direction', initial)
    await addMessage(randomUUID(), owner, parentThread, 1, 'delivered', 'World feedback', forkSha)
    await addMessage(randomUUID(), owner, parentThread, 2, 'delivered', 'Character feedback', futureSha)
    await addMessage(randomUUID(), owner, parentThread, 3, 'queued', 'In-flight steering', null)
    const source = { worktreeRoot: root, baseSha: initial, jobId } as JobStartResult
    // A #81 chat read may seed a legacy pinned request without a separate
    // verification receipt. It must not suppress the #79 baseline fallback.
    const seededThread = randomUUID()
    ;(await db.testing.records.insert('story_threads', { id: seededThread, ownerUserId: owner,
      storyId: story, title: 'Chat seeded', activityAt: 'now', createdAt: 'now' }))
    await addMessage(randomUUID(), owner, seededThread, 0, 'delivered', 'Rendered unverified chat', null)
    assert.deepEqual((await snapshotForkBoundaryHistory(db, owner, seededThread, source,
      'Pinned author task', 'now', forkSha)).map(m => m.body), ['Pinned author task'])
    const frozen = await snapshotForkBoundaryHistory(db, owner, parentThread, source,
      'Pinned author task', 'now', forkSha)
    assert.deepEqual(frozen.map(m => m.body), ['Initial direction', 'World feedback'])
    const parentRows = async () => (await db.testing.records.all<{
      body: string; status: string; verifiedCommitSha: string | null
    }>('story_thread_messages', { threadId: parentThread }, { by: 'sequence' }))
      .map(({ body, status, verifiedCommitSha }) => ({ body, status, verifiedCommitSha }))
    const original = await parentRows()
    await addMessage(randomUUID(), owner, parentThread, 4, 'delivered', 'New live parent update', forkSha)
    await recordForkBoundaryHistory(db, owner, childThread, frozen, 'Keep the new branch focused', 'later')
    const child = (await db.testing.records.all<{
      role: string; status: string; body: string; originMessageId: string | null;
      verifiedCommitSha: string | null
    }>('story_thread_messages', { threadId: childThread }, { by: 'sequence' }))
      .map(row => ({ ...row, origin: row.originMessageId, sha: row.verifiedCommitSha }))
    assert.deepEqual(child.map(m => m.body),
      ['Initial direction', 'World feedback', 'Keep the new branch focused'])
    assert.deepEqual(child.map(m => m.status), ['delivered', 'delivered', 'queued'])
    assert.deepEqual(child.map(m => m.sha), [initial, forkSha, null])
    assert.equal(child[0]?.role, 'user')
    assert.ok(child[0]?.origin)
    assert.equal((await parentRows()).length, original.length + 1)
    assert.deepEqual((await parentRows()).slice(0, original.length), original)
    assert.deepEqual((await db.testing.foreignKeyViolations()), [])
    assert.deepEqual((await snapshotForkBoundaryHistory(db, owner, parentThread, source,
      'Pinned author task', 'now', initial)).map(m => m.body), ['Initial direction'],
      'a branch from before World excludes World and later messages')
    // A live steering receipt may be imported late, after a newer Thread run
    // has completed. Message sequence alone must not inherit that newer run,
    // even if it happened to produce the same verified Story commit.
    const laterJob = randomUUID()
    ;(await db.testing.records.insert('studio_sessions', { id: laterJob, ownerUserId: owner,
      storyId: story, title: 'Later follow-up', sourceCommitSha: forkSha,
      status: 'completed', createdAt: 'now', updatedAt: 'now' }))
    ;(await db.testing.records.insert('story_thread_runs', { jobId: laterJob, ownerUserId: owner,
      threadId: parentThread, runOrder: 1 }))
    const lateId = randomUUID()
    await addMessage(lateId, owner, parentThread, 5, 'delivered', 'Newer follow-up', forkSha)
    ;(await db.testing.records.update('story_thread_messages', { id: lateId }, { jobId: laterJob }))
    assert.ok((await snapshotForkBoundaryHistory(db, owner, parentThread, source,
      'Pinned author task', 'now', forkSha, 6)).some(row => row.body === 'Newer follow-up'))
    const causal = await snapshotForkBoundaryHistory(db, owner, parentThread, source,
      'Pinned author task', 'now', forkSha, 6, 0)
    assert.ok(!causal.some(row => row.body === 'Newer follow-up'),
      'a later run is excluded independently of message timestamp and selected SHA')
  } finally {
    db.close()
    removeTestTree(root)
  }
})

test('legacy generation request is inherited without modifying the source Thread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-fork-legacy-'))
  const db = openStudioDatabase(':memory:')
  try {
    await migrateStudio(db, config)
    git(root, 'init', '-q')
    git(root, 'config', 'user.name', 'Author')
    git(root, 'config', 'user.email', 'author@example.local')
    writeFileSync(join(root, 'start.txt'), 'start')
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'Initial')
    const sha = git(root, 'rev-parse', 'HEAD')
    const source = { worktreeRoot: root, baseSha: sha, jobId: randomUUID() } as JobStartResult
    const snapshot = await snapshotForkBoundaryHistory(db, 'owner', 'nonexistent-thread',
      source, 'Original request', '2026-11-01T00:00:00Z', sha)
    assert.deepEqual(snapshot.map(m => m.body), ['Original request'])
    assert.equal(snapshot[0]?.verifiedSha, sha)
    assert.equal((await db.testing.records.count('story_thread_messages')), 0)
  } finally {
    db.close()
    removeTestTree(root)
  }
})
