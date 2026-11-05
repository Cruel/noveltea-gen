import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from '../src/db/migrations'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { ensureRootThreads } from '../src/lib/threads.server'
import { readThreadChat } from '../src/lib/thread-chat.server'
import { sendAuthorUpdate } from '../../src/author-updates'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import {
  selectCausalRecoveryPoint, previewThreadMessageEdit, syncAppliedAuthorMessages,
  branchEditedThreadMessage,
} from '../src/lib/thread-message-edit.server'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const config = { baseURL: 'http://localhost:3000', secret: 'thread-edit-test-secret-01234567890123456',
  github: { clientId: 'test', clientSecret: 'test' }, gitlab: { clientId: 'test', clientSecret: 'test' } }
const contract = { scope: { kind: 'full-story' as const, depth: 'composition' as const,
  targets: [], branches: [] }, constraints: [],
  envelope: { presentation: 'Visual novel', hardLimits: [], preferences: [] } }

test('edited message between specialist commits forks from last finalized pre-application point, never the later commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-message-causal-'))
  try {
    git(dir, 'init', '-q')
    git(dir, 'config', 'user.email', 'test@example.local')
    git(dir, 'config', 'user.name', 'Author')
    const commit = (text: string) => {
      writeFileSync(join(dir, 'story.md'), text)
      git(dir, 'add', '.')
      git(dir, 'commit', '-qm', text)
      return git(dir, 'rev-parse', 'HEAD')
    }
    const initial = commit('baseline')
    const foundation = commit('foundation')
    const world = commit('world-finalized')
    const interim = commit('steering-applied-to-world')
    const character = commit('character-finalized')
    const current = commit('later changes')
    const points = [
      { commitSha: foundation, proofDigest: '1'.repeat(64), workItem: 'foundation', eligible: true },
      { commitSha: world, proofDigest: '2'.repeat(64), workItem: 'world-foundations', eligible: true },
      { commitSha: interim, proofDigest: '3'.repeat(64), workItem: 'interim', eligible: false },
      { commitSha: character, proofDigest: '4'.repeat(64), workItem: 'character-foundations', eligible: true },
    ]
    // The pinned acknowledgement is at the exact causal boundary after the
    // intermediate edit, not a timestamp or graph checkpoint from later.
    assert.equal(selectCausalRecoveryPoint(dir, points, interim)?.commitSha, world)
    assert.equal(selectCausalRecoveryPoint(dir, points, world)?.commitSha, world)
    assert.equal(selectCausalRecoveryPoint(dir, points, current)?.commitSha, character)
    assert.equal(selectCausalRecoveryPoint(dir, points, initial), null)
    assert.equal(selectCausalRecoveryPoint(dir, points, 'f'.repeat(40)), null)
    assert.equal(selectCausalRecoveryPoint(dir, [{ ...points[1]!, eligible: false }], interim), null)
    assert.equal(git(dir, 'rev-parse', 'HEAD'), current, 'selection never changes the parent')
  } finally { removeTestTree(dir) }
})

test('real author-update receipt pins a steering edit between commits; missing recovery point fails closed', {
  timeout: 60_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-message-boundary-'))
  const oldState = process.env.NT_STATE_DIR, oldCache = process.env.NT_GIT_CACHE_DIR
  process.env.NT_STATE_DIR = join(root, 'state')
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  const db = openStudioDatabase(join(root, 'db.sqlite'))
  try {
    await migrateStudio(db, config)
    const user = randomUUID(), repoId = randomUUID(), storyId = randomUUID()
    const jobId = randomUUID(), threadId = 'root:' + jobId
    db.sqlite.prepare(`INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt)
      VALUES (?,'Author',?,1,0,0)`).run(user, user + '@example.test')
    db.sqlite.prepare(`INSERT INTO repositories (id,owner_user_id,provider,
      provider_repository_id,name,created_at) VALUES (?,?,'github','123','Repo','now')`).run(repoId, user)
    const remote = join(root, 'remote')
    mkdirSync(join(remote, 'story'), { recursive: true })
    writeFileSync(join(remote, 'story', 'story.md'), 'initial')
    git(remote, 'init', '-q')
    git(remote, 'config', 'user.email', 'test@example.local')
    git(remote, 'config', 'user.name', 'Author')
    git(remote, 'add', '.')
    git(remote, 'commit', '-qm', 'initial')
    const base = git(remote, 'rev-parse', 'HEAD')
    db.sqlite.prepare(`INSERT INTO stories (id,owner_user_id,repository_id,directory,title,
      created_at,source_commit_sha) VALUES (?,?,?,'story','Story','now',?)`)
      .run(storyId, user, repoId, base)
    const parent = await acquireCachedStory({ cacheDirectory: process.env.NT_GIT_CACHE_DIR!,
      ownerId: user, repositoryId: 'github:123', remoteUrl: 'file://' + remote,
      token: '', directory: 'story', commit: base, jobId })
    const request = { story: parent.storyRoot, job: jobId, task: 'Original request', contract, fixture: true }
    db.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at,
      generation_request_json,generation_thread_id,generation_config_json)
      VALUES (?,?,?,'Story',?,'running','now','now',?,?,?)`)
      .run(jobId, user, storyId, base, JSON.stringify(request),
        parent.threadId + ':generation:web', JSON.stringify({
          version: 1, headSha: base, task: request.task, contract, limits: {}, model: null,
        }))
    ensureRootThreads(db, user, storyId)
    const first = (await readThreadChat(db, user, threadId))
    assert.equal(first.messages.length, 1)
    // The job's real author-update receipt captures the HEAD on application,
    // before any later specialist commit. Do not infer application from receipt
    // mtime or the parent worktree's current HEAD.
    const storyPath = join(parent.worktreeStoryRoot, 'story.md')
    git(parent.worktreeRoot, 'config', 'user.email', 'test@example.local')
    git(parent.worktreeRoot, 'config', 'user.name', 'Author')
    const commit = (content: string) => {
      writeFileSync(storyPath, content)
      git(parent.worktreeRoot, 'add', '.')
      git(parent.worktreeRoot, 'commit', '-qm', content)
      return git(parent.worktreeRoot, 'rev-parse', 'HEAD')
    }
    commit('world')
    const pinned = commit('intermediate-before-steering')
    const sent = await sendAuthorUpdate(parent, {
      id: 'between-specialists', kind: 'idea', payload: { original: 'Give the witness an alibi' },
    })
    mkdirSync(join(parent.stateDir, 'author-updates', 'receipts'), { recursive: true })
    writeFileSync(join(parent.stateDir, 'author-updates', 'receipts', 'between-specialists.json'),
      JSON.stringify({ ...sent, phase: 'applied', pinned: {
        jobId, threadId: parent.threadId, branch: parent.branch, baseSha: base, headSha: pinned,
        planVersion: null, skillSnapshot: null, piSessions: {},
      } }))
    const after = commit('later-specialist-work')
    await syncAppliedAuthorMessages(db, user, threadId)
    await syncAppliedAuthorMessages(db, user, threadId)
    const chat = (await readThreadChat(db, user, threadId))
    assert.equal(chat.messages.length, 2)
    const steer = chat.messages[1]!
    assert.equal(steer.status, 'delivered')
    assert.equal(steer.content, 'Give the witness an alibi')
    const shown = await previewThreadMessageEdit(db, user, threadId, steer.id,
      'Give the witness a false alibi')
    assert.equal(shown.appliedBeforeSha, pinned)
    assert.notEqual(shown.appliedBeforeSha, after)
    assert.equal(shown.checkpoint, null, 'never invent an intermediate finalized checkpoint')
    assert.match(shown.limitation ?? '', /Restart from the original pinned Story source/i)
    await assert.rejects(() => branchEditedThreadMessage(db, user, {
      threadId, messageId: steer.id, edited: 'Give the witness a false alibi', childId: randomUUID(),
      commitSha: after, proofDigest: 'f'.repeat(64),
    }), /Restart from the original pinned Story source/i)
    await assert.rejects(() => previewThreadMessageEdit(db, randomUUID(), threadId,
      steer.id, 'Give the witness a false alibi'), /not found/)
    await assert.rejects(() => previewThreadMessageEdit(db, user, threadId, steer.id,
      steer.content), /changed/)
    assert.equal((db.sqlite.prepare('SELECT COUNT(*) AS n FROM checkpoint_forks').get() as { n: number }).n, 0)
    assert.equal(git(parent.worktreeRoot, 'rev-parse', 'HEAD'), after)
    assert.deepEqual(db.sqlite.pragma('foreign_key_check'), [])
  } finally {
    db.sqlite.close()
    if (oldState === undefined) delete process.env.NT_STATE_DIR
    else process.env.NT_STATE_DIR = oldState
    if (oldCache === undefined) delete process.env.NT_GIT_CACHE_DIR
    else process.env.NT_GIT_CACHE_DIR = oldCache
    removeTestTree(root)
  }
})
