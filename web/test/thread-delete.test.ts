import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { deleteThread } from '../src/lib/thread-deletion.server'
import { archiveThread, listStoryNavigation } from '../src/lib/threads.server'
import { selectNavigationThreads } from '../src/lib/thread-navigation'
import { selectedJob, restoreJob } from '../src/lib/fixture-jobs.server'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { migrateStudio } from '../src/db/migrations'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'thread-deletion-integration-test-secret-012345678901',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}
const at = '2026-11-01T00:00:00.000Z'
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function physicalBytes(path: string): number {
  if (!existsSync(path)) return 0
  const s = lstatSync(path)
  return s.size + (s.isDirectory() ? readdirSync(path)
    .reduce((bytes, name) => bytes + physicalBytes(join(path, name)), 0) : 0)
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nt-thread-delete-'))
  const priorState = process.env.NT_STATE_DIR, priorCache = process.env.NT_GIT_CACHE_DIR
  const state = join(root, 'state'), cache = join(root, 'cache')
  process.env.NT_STATE_DIR = state
  process.env.NT_GIT_CACHE_DIR = cache
  const remote = join(root, 'remote')
  mkdirSync(join(remote, 'story', 'creative-direction'), { recursive: true })
  git(remote, 'init', '-q')
  git(remote, 'config', 'user.email', 'test@example.com')
  git(remote, 'config', 'user.name', 'Test')
  writeFileSync(join(remote, 'story', 'creative-direction', 'foundation.md'), 'Retain original Story canon\n')
  git(remote, 'add', '.')
  git(remote, 'commit', '-qm', 'Initial Story')
  const sha = git(remote, 'rev-parse', 'HEAD')
  const owner = randomUUID(), stranger = randomUUID(), repository = randomUUID(), story = randomUUID()
  const store = openStudioDatabase(join(root, 'studio.sqlite'))
  await migrateStudio(store, config)
  const seed = studioSeed(store)
  for (const id of [owner, stranger]) await seed.user(id)
  await seed.repository({ id: repository, ownerUserId: owner, name: 'Local Git test',
    provider: 'github', providerRepositoryId: 'repo', createdAt: at })
  await seed.story({ id: story, ownerUserId: owner, repositoryId: repository,
    directory: 'story', title: 'Story', sourceCommitSha: sha, createdAt: at })
  const input = { cacheDirectory: cache, ownerId: owner, repositoryId: 'github:repo',
    remoteUrl: 'file://' + remote, token: '', commit: sha, directory: 'story' }
  async function job(id = randomUUID()) {
    const physical = await acquireCachedStory({ ...input, jobId: id })
    await seed.job({ id, ownerUserId: owner, storyId: story, title: id,
      sourceCommitSha: sha, status: 'completed', createdAt: at, updatedAt: at })
    return physical
  }
  async function dispose() {
    await Promise.resolve(store.close())
    if (priorState === undefined) delete process.env.NT_STATE_DIR
    else process.env.NT_STATE_DIR = priorState
    if (priorCache === undefined) delete process.env.NT_GIT_CACHE_DIR
    else process.env.NT_GIT_CACHE_DIR = priorCache
    rmSync(root, { recursive: true, force: true })
  }
  return { store, seed, owner, stranger, story, job, dispose }
}

test('deletion reclaims a leaf worktree, Git ref and private state without affecting shared Git base', async () => {
  const f = await fixture()
  try {
    const parent = await f.job()
    const thread = (await listStoryNavigation(f.store, f.owner, f.story)).threads[0]!
    await assert.rejects(deleteThread(f.store, f.stranger, thread.id), /not found/i)
    assert.equal(existsSync(parent.worktreeRoot), true)
    git(parent.gitRoot, 'branch', 'externally-retained', parent.headSha)
    mkdirSync(join(parent.stateDir, 'foundation-sessions'))
    const transcript = join(parent.stateDir, 'foundation-sessions', 'session.jsonl')
    const graphStore = join(parent.stateDir, 'web-generation.sqlite')
    writeFileSync(transcript, '{"type":"session","id":"test"}\n')
    writeFileSync(graphStore, 'private checkpoint data')
    const expectedBytes = physicalBytes(parent.worktreeRoot) + physicalBytes(parent.stateDir)
    const outcome = await deleteThread(f.store, f.owner, thread.id)
    assert.equal(outcome.state, 'complete')
    if (outcome.state !== 'complete') return
    assert.equal(outcome.bytes, expectedBytes, 'accounted resource bytes match the exact on-disk snapshot')
    assert.equal(outcome.preservedReceipts, false)
    assert.equal(existsSync(parent.worktreeRoot), false)
    assert.equal(existsSync(parent.stateDir), false)
    assert.equal(existsSync(transcript), false, 'private Pi transcript is reclaimed')
    assert.equal(existsSync(graphStore), false, 'private graph checkpoint store is reclaimed')
    assert.equal(existsSync(parent.gitRoot), true)
    assert.doesNotMatch(git(parent.gitRoot, 'branch', '--list'), /noveltea-gen/)
    assert.equal(git(parent.gitRoot, 'rev-parse', 'externally-retained'), parent.headSha,
      'the deletion never prunes externally referenced Git objects')
    await assert.rejects(selectedJob(f.store, f.owner, parent.jobId), /permanently deleted/i)
    assert.deepEqual(await deleteThread(f.store, f.owner, thread.id), outcome)
    const tombstone = (await listStoryNavigation(f.store, f.owner, f.story)).threads[0]!
    assert.ok(tombstone.deletionCompleteAt)
    assert.deepEqual(selectNavigationThreads([tombstone], 'active'), [])
    assert.deepEqual(await f.store.testing.foreignKeyViolations(), [])
  } finally { await f.dispose() }
})

test('completed parent deletion retains child lineage, independent Git checkout and source receipts', async () => {
  const f = await fixture()
  try {
    const parent = await f.job()
    const parentThread = (await listStoryNavigation(f.store, f.owner, f.story)).threads[0]!
    const child = await f.job()
    const id = 'fork:' + child.jobId
    await f.seed.thread({ id, ownerUserId: f.owner,
      storyId: parentThread.storyId, parentThreadId: parentThread.id,
      title: 'Independent child', activityAt: at, createdAt: at })
    await f.seed.forkReceipt(child.jobId, f.owner, parent.jobId, parentThread.id, child.baseSha, at)
    await f.seed.threadRun({ jobId: child.jobId, ownerUserId: f.owner, threadId: id, runOrder: 0 })
    const originalChildHead = git(child.worktreeRoot, 'rev-parse', 'HEAD')
    const retainedReceipt = join(parent.stateDir, 'architecture.json')
    const retainedCheckpoint = join(parent.stateDir, 'recovery-checkpoints', 'source.json')
    mkdirSync(join(parent.stateDir, 'recovery-checkpoints'))
    writeFileSync(retainedReceipt, '{"phase":"committed","plan":{"version":1}}')
    writeFileSync(retainedCheckpoint, '{"status":"finalized"}')
    const sessionDir = join(parent.stateDir, 'character-world-sessions')
    const privateTranscript = join(sessionDir, 'session.jsonl')
    const privateGraph = join(parent.stateDir, 'web-generation.sqlite')
    const privateBudget = join(parent.stateDir, 'pi-budget.json')
    mkdirSync(sessionDir)
    writeFileSync(privateTranscript, 'private Pi model conversation')
    writeFileSync(privateGraph, 'private graph checkpoint')
    writeFileSync(privateBudget, 'private model accounting')
    const expectedReclaimed = physicalBytes(parent.worktreeRoot) + physicalBytes(sessionDir) +
      physicalBytes(privateGraph) + physicalBytes(privateBudget)
    const originalStateBytes = physicalBytes(parent.stateDir)
    const result = await deleteThread(f.store, f.owner, parentThread.id)
    assert.equal(result.state, 'complete')
    if (result.state !== 'complete') return
    assert.equal(result.preservedReceipts, true)
    assert.equal(result.bytes, expectedReclaimed, 'reports worktree and disposable-state reclamation')
    assert.equal(existsSync(parent.worktreeRoot), false)
    assert.equal(existsSync(parent.stateDir), true, 'source evidence retained for child provenance')
    assert.equal(existsSync(join(parent.stateDir, 'job.json')), true)
    assert.equal(existsSync(retainedReceipt), true)
    assert.equal(existsSync(retainedCheckpoint), true)
    assert.equal(existsSync(privateTranscript), false, 'source Pi transcript must not survive deletion')
    assert.equal(existsSync(privateGraph), false, 'source graph state must not survive deletion')
    assert.equal(existsSync(privateBudget), false, 'source runtime accounting must not survive deletion')
    assert.ok(physicalBytes(parent.stateDir) < originalStateBytes)
    assert.deepEqual(await deleteThread(f.store, f.owner, parentThread.id), result,
      'repeat deletion reports the same reclaimed bytes without reprocessing evidence')
    assert.equal(existsSync(child.worktreeRoot), true)
    assert.equal(git(child.worktreeRoot, 'rev-parse', 'HEAD'), originalChildHead)
    assert.equal((await restoreJob((await f.store.persistence.generation.jobs.selected(f.owner, child.jobId))!, f.owner)).jobId, child.jobId)
    const threads = (await listStoryNavigation(f.store, f.owner, f.story)).threads
    assert.equal(threads.find(row => row.id === id)?.parentThreadId, parentThread.id)
    assert.equal(threads.find(row => row.id === id)?.status, 'completed')
    assert.equal(threads.find(row => row.id === parentThread.id)?.status, 'deleted')
    assert.deepEqual(await f.store.testing.foreignKeyViolations(), [])
  } finally { await f.dispose() }
})

test('a symlink disguised as retained ancestry evidence blocks cleanup before Git removal', async () => {
  const f = await fixture()
  try {
    const parent = await f.job()
    const thread = (await listStoryNavigation(f.store, f.owner, f.story)).threads[0]!
    const child = await f.job()
    await f.seed.thread({ id: 'fork:' + child.jobId, ownerUserId: f.owner,
      storyId: thread.storyId, parentThreadId: thread.id,
      title: 'Child', activityAt: at, createdAt: at })
    await f.seed.forkReceipt(child.jobId, f.owner, parent.jobId, thread.id, child.baseSha, at)
    await f.seed.threadRun({ jobId: child.jobId, ownerUserId: f.owner,
      threadId: 'fork:' + child.jobId, runOrder: 0 })
    symlinkSync('job.json', join(parent.stateDir, 'architecture.json'))
    await assert.rejects(deleteThread(f.store, f.owner, thread.id), /symlink/i)
    assert.equal(existsSync(parent.worktreeRoot), true)
    assert.equal(existsSync(child.worktreeRoot), true)
  } finally { await f.dispose() }
})

test('dirty state refuses cleanup; partial Git removal is retryable and does not erase descendants', async () => {
  const f = await fixture()
  try {
    const parent = await f.job()
    const thread = (await listStoryNavigation(f.store, f.owner, f.story)).threads[0]!
    const extra = join(parent.worktreeStoryRoot, 'uncommitted.md')
    writeFileSync(extra, 'Unreviewed author edit\n')
    await assert.rejects(deleteThread(f.store, f.owner, thread.id), /dirty|checkout/i)
    const pending = await f.store.persistence.conversations.deletion(f.owner, thread.id)
    assert.ok(pending?.deletedAt && !pending.completedAt && pending.planJson)
    assert.equal(existsSync(parent.worktreeRoot), true)
    rmSync(extra)
    // Crash simulation: the first physical step happened, but its ref and
    // durable Studio reservation remain. The retry completes safely.
    git(parent.gitRoot, 'worktree', 'remove', '--', parent.worktreeRoot)
    assert.ok(git(parent.gitRoot, 'branch', '--list').includes('noveltea-gen'))
    const done = await deleteThread(f.store, f.owner, thread.id)
    assert.equal(done.state, 'complete')
    assert.equal(existsSync(parent.stateDir), false)
    assert.equal(existsSync(parent.worktreeRoot), false)
    assert.deepEqual(await f.store.testing.foreignKeyViolations(), [])
  } finally { await f.dispose() }
})

test('pending child forks and linked publications veto deletion before any physical change', async () => {
  const f = await fixture()
  try {
    const parent = await f.job()
    const thread = (await listStoryNavigation(f.store, f.owner, f.story)).threads[0]!
    const child = randomUUID()
    await f.store.testing.records.insert('checkpoint_forks', {
      childId: child, ownerUserId: f.owner, sourceJobId: parent.jobId,
      sourceBaseSha: parent.baseSha, commitSha: parent.headSha,
      bundleJson: '{}', draftJson: '{}', createdAt: at, guidance: '',
    })
    await assert.rejects(deleteThread(f.store, f.owner, thread.id), /unfinished child/i)
    await f.store.testing.records.delete('checkpoint_forks', { childId: child })
    await f.store.testing.records.insert('github_publications', {
      jobId: parent.jobId, ownerUserId: f.owner, targetBranch: 'main',
      remoteBranch: 'publication', headSha: parent.headSha,
      phase: 'linked', prNumber: 12, prUrl: 'https://example.test/pull/12', updatedAt: at,
    })
    await assert.rejects(deleteThread(f.store, f.owner, thread.id), /published review branch/i)
    assert.equal((await f.store.persistence.conversations.deletion(f.owner, thread.id))?.deletedAt, null)
    assert.equal(existsSync(parent.worktreeRoot), true)
    await f.store.testing.records.delete('github_publications', { jobId: parent.jobId })
    assert.equal((await deleteThread(f.store, f.owner, thread.id)).state, 'complete')
    assert.deepEqual(await f.store.testing.foreignKeyViolations(), [])
  } finally { await f.dispose() }
})

test('unsettled continuation and Pi delivery block deletion before worktree cleanup', async () => {
  const f = await fixture()
  try {
    const parent = await f.job()
    const thread = (await listStoryNavigation(f.store, f.owner, f.story)).threads[0]!
    const id = randomUUID()
    await f.seed.message({ id, ownerUserId: f.owner, threadId: thread.id,
      sequence: 0, role: 'user', status: 'queued', phase: 'preparing',
      body: 'Prepare a safe follow-up', createdAt: at })
    await assert.rejects(deleteThread(f.store, f.owner, thread.id), /Unsettled Thread continuation/i)
    assert.equal((await f.store.persistence.conversations.deletion(f.owner, thread.id))?.deletedAt, null)
    assert.equal(existsSync(parent.worktreeRoot), true)
    await f.store.testing.records.update('story_thread_messages', { id }, { phase: 'queued' })
    await f.store.testing.records.insert('thread_live_inputs', {
      messageId: id, ownerUserId: f.owner, threadId: thread.id, sourceJobId: parent.jobId,
      mode: 'steer', state: 'sdk-queued', createdAt: at,
    })
    await assert.rejects(deleteThread(f.store, f.owner, thread.id), /Unsettled Thread continuation/i)
    await f.store.testing.records.update('story_thread_messages', { id }, { phase: 'finished' })
    await f.store.testing.records.update('thread_live_inputs', { messageId: id }, { state: 'delivered' })
    assert.equal((await deleteThread(f.store, f.owner, thread.id)).state, 'complete')
    assert.deepEqual(await f.store.testing.foreignKeyViolations(), [])
  } finally { await f.dispose() }
})

test('archived checkpoints remain recoverable while deleted runs cannot be re-enqueued', async () => {
  const f = await fixture()
  try {
    const parent = await f.job()
    const thread = (await listStoryNavigation(f.store, f.owner, f.story)).threads[0]!
    await archiveThread(f.store, f.owner, thread.id)
    assert.equal((await restoreJob(await selectedJob(f.store, f.owner, parent.jobId), f.owner)).jobId,
      parent.jobId, 'archive has no execution-side effects')
    await f.store.testing.records.update('studio_sessions', { id: parent.jobId }, { status: 'paused' })
    assert.equal((await deleteThread(f.store, f.owner, thread.id)).state, 'complete')
    await assert.rejects(f.store.persistence.generation.queue.enqueue(f.owner, parent.jobId,
      'start', 'prepared', at, '{}', 'some-thread'), /Deleted Thread/i)
    assert.deepEqual(await f.store.testing.foreignKeyViolations(), [])
  } finally { await f.dispose() }
})

test('an unexpected writer lock blocks physical deletion and the saved plan can be retried', async () => {
  const f = await fixture()
  try {
    const parent = await f.job()
    const thread = (await listStoryNavigation(f.store, f.owner, f.story)).threads[0]!
    const lock = join(parent.stateDir, '.story-job-running')
    mkdirSync(lock)
    await assert.rejects(deleteThread(f.store, f.owner, thread.id), /lock/i)
    assert.equal(existsSync(parent.worktreeRoot), true)
    assert.equal(existsSync(parent.stateDir), true)
    rmSync(lock, { recursive: true })
    assert.equal((await deleteThread(f.store, f.owner, thread.id)).state, 'complete')
    assert.equal(existsSync(parent.worktreeRoot), false)
    assert.deepEqual(await f.store.testing.foreignKeyViolations(), [])
  } finally { await f.dispose() }
})

test('changed Git branch identity blocks cleanup and active work first receives a cancellation request', async () => {
  const f = await fixture()
  try {
    const parent = await f.job()
    const thread = (await listStoryNavigation(f.store, f.owner, f.story)).threads[0]!
    await f.store.testing.records.update('studio_sessions', { id: parent.jobId }, { status: 'running' })
    const pending = await deleteThread(f.store, f.owner, thread.id)
    assert.equal(pending.state, 'pending')
    assert.equal((await f.store.persistence.conversations.deletion(f.owner, thread.id))?.deletedAt, null)
    assert.equal(existsSync(parent.worktreeRoot), true)
    await f.store.testing.records.update('studio_sessions', { id: parent.jobId }, { status: 'cancelled' })
    const extra = join(parent.worktreeStoryRoot, 'changed.md')
    writeFileSync(extra, 'New author draft\n')
    await assert.rejects(deleteThread(f.store, f.owner, thread.id), /dirty|checkout/i)
    git(parent.worktreeRoot, 'add', '.')
    git(parent.worktreeRoot, '-c', 'user.email=test@example.com',
      '-c', 'user.name=Test', 'commit', '-qm', 'Different HEAD')
    await assert.rejects(deleteThread(f.store, f.owner, thread.id), /branch moved|identity changed/i)
    assert.equal(existsSync(parent.worktreeRoot), true)
    assert.equal(existsSync(parent.stateDir), true)
  } finally { await f.dispose() }
})
