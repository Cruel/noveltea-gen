import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
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
    const seed = studioSeed(db)
    ;(await seed.user(user, 0))
    ;(await seed.repository({ id: repoId, ownerUserId: user, provider: 'github',
      providerRepositoryId: '123', name: 'Repo', createdAt: 'now' }))
    const remote = join(root, 'remote')
    mkdirSync(join(remote, 'story'), { recursive: true })
    writeFileSync(join(remote, 'story', 'story.md'), 'initial')
    git(remote, 'init', '-q')
    git(remote, 'config', 'user.email', 'test@example.local')
    git(remote, 'config', 'user.name', 'Author')
    git(remote, 'add', '.')
    git(remote, 'commit', '-qm', 'initial')
    const base = git(remote, 'rev-parse', 'HEAD')
    ;(await seed.story({ id: storyId, ownerUserId: user, repositoryId: repoId,
      directory: 'story', title: 'Story', createdAt: 'now', sourceCommitSha: base }))
    const parent = await acquireCachedStory({ cacheDirectory: process.env.NT_GIT_CACHE_DIR!,
      ownerId: user, repositoryId: 'github:123', remoteUrl: 'file://' + remote,
      token: '', directory: 'story', commit: base, jobId })
    const request = { story: parent.storyRoot, job: jobId, task: 'Original request', contract, fixture: true }
    ;(await seed.job({ id: jobId, ownerUserId: user, storyId, title: 'Story',
      sourceCommitSha: base, status: 'running', createdAt: 'now', updatedAt: 'now',
      generationRequestJson: JSON.stringify(request),
      generationThreadId: parent.threadId + ':generation:web',
      generationConfigJson: JSON.stringify({
        version: 1, headSha: base, task: request.task, contract, limits: {}, model: null,
      }) }))
    await ensureRootThreads(db, user, storyId)
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
    assert.equal((await db.testing.records.count('checkpoint_forks')), 0)
    assert.equal(git(parent.worktreeRoot, 'rev-parse', 'HEAD'), after)
    assert.deepEqual((await db.testing.foreignKeyViolations()), [])
  } finally {
    db.close()
    if (oldState === undefined) delete process.env.NT_STATE_DIR
    else process.env.NT_STATE_DIR = oldState
    if (oldCache === undefined) delete process.env.NT_GIT_CACHE_DIR
    else process.env.NT_GIT_CACHE_DIR = oldCache
    removeTestTree(root)
  }
})
