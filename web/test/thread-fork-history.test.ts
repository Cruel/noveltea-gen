import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { JobStartResult } from '../../src/job'
import { removeTestTree } from '../../test/helpers'
import { openStudioDatabase } from '../src/db/connection'
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
    const conversation = randomUUID(), jobId = randomUUID()
    db.sqlite.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
      .run(owner, 'Author', 'author@local.test', 1, Date.now(), Date.now())
    db.sqlite.prepare(`INSERT INTO repositories (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES (?,?,'github','provider','Repo','now')`).run(repo, owner)
    db.sqlite.prepare(`INSERT INTO stories (id,owner_user_id,repository_id,directory,title,created_at)
      VALUES (?,?,?,'story','Story','now')`).run(story, owner, repo)
    db.sqlite.prepare(`INSERT INTO story_conversations (id,owner_user_id,story_id,title,created_at,updated_at)
      VALUES (?,?,?,'Character exploration','now','now')`).run(conversation, owner, story)
    for (const [id, parent] of [[parentThread, null], [childThread, parentThread]] as const) {
      db.sqlite.prepare(`INSERT INTO story_threads
        (id,owner_user_id,conversation_id,parent_thread_id,title,activity_at,created_at)
        VALUES (?,?,?,?,'Branch','now','now')`).run(id, owner, conversation, parent)
    }
    const messages = db.sqlite.prepare(`INSERT INTO story_thread_messages
      (id,owner_user_id,thread_id,sequence,role,status,body,verified_commit_sha,created_at)
      VALUES (?,?,?,?,'user',?,?,?,'now')`)
    messages.run(randomUUID(), owner, parentThread, 0, 'delivered', 'Initial direction', initial)
    messages.run(randomUUID(), owner, parentThread, 1, 'delivered', 'World feedback', forkSha)
    messages.run(randomUUID(), owner, parentThread, 2, 'delivered', 'Character feedback', futureSha)
    messages.run(randomUUID(), owner, parentThread, 3, 'queued', 'In-flight steering', null)
    const source = { worktreeRoot: root, baseSha: initial, jobId } as JobStartResult
    // A #81 chat read may seed a legacy pinned request without a separate
    // verification receipt. It must not suppress the #79 baseline fallback.
    const seededThread = randomUUID()
    db.sqlite.prepare(`INSERT INTO story_threads
      (id,owner_user_id,conversation_id,title,activity_at,created_at)
      VALUES (?,?,?,'Chat seeded','now','now')`).run(seededThread, owner, conversation)
    messages.run(randomUUID(), owner, seededThread, 0, 'delivered', 'Rendered unverified chat', null)
    assert.deepEqual(snapshotForkBoundaryHistory(db, owner, seededThread, source,
      'Pinned author task', 'now', forkSha).map(m => m.body), ['Pinned author task'])
    const frozen = snapshotForkBoundaryHistory(db, owner, parentThread, source,
      'Pinned author task', 'now', forkSha)
    assert.deepEqual(frozen.map(m => m.body), ['Initial direction', 'World feedback'])
    const parentRows = () => db.sqlite.prepare(`SELECT body,status,verified_commit_sha FROM story_thread_messages
      WHERE thread_id=? ORDER BY sequence`).all(parentThread)
    const original = parentRows()
    messages.run(randomUUID(), owner, parentThread, 4, 'delivered', 'New live parent update', forkSha)
    recordForkBoundaryHistory(db, owner, childThread, frozen, 'Keep the new branch focused', 'later')
    const child = db.sqlite.prepare(`SELECT role,status,body,origin_message_id AS origin,verified_commit_sha AS sha
      FROM story_thread_messages WHERE thread_id=? ORDER BY sequence`).all(childThread) as Array<{
        role: string; status: string; body: string; origin: string | null; sha: string | null
      }>
    assert.deepEqual(child.map(m => m.body),
      ['Initial direction', 'World feedback', 'Keep the new branch focused'])
    assert.deepEqual(child.map(m => m.status), ['delivered', 'delivered', 'queued'])
    assert.deepEqual(child.map(m => m.sha), [initial, forkSha, null])
    assert.equal(child[0]?.role, 'user')
    assert.ok(child[0]?.origin)
    assert.equal(parentRows().length, original.length + 1)
    assert.deepEqual(parentRows().slice(0, original.length), original)
    assert.deepEqual(db.sqlite.pragma('foreign_key_check'), [])
    assert.deepEqual(snapshotForkBoundaryHistory(db, owner, parentThread, source,
      'Pinned author task', 'now', initial).map(m => m.body), ['Initial direction'],
      'a branch from before World excludes World and later messages')
  } finally {
    db.sqlite.close()
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
    const snapshot = snapshotForkBoundaryHistory(db, 'owner', 'nonexistent-thread',
      source, 'Original request', '2026-11-01T00:00:00Z', sha)
    assert.deepEqual(snapshot.map(m => m.body), ['Original request'])
    assert.equal(snapshot[0]?.verifiedSha, sha)
    assert.equal((db.sqlite.prepare('SELECT COUNT(*) AS n FROM story_thread_messages').get() as { n: number }).n, 0)
  } finally {
    db.sqlite.close()
    removeTestTree(root)
  }
})
