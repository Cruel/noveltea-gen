import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { migrateStudio } from './support/studio-database'
import { acquireCachedStory, continueCachedStory } from '../src/lib/git-cache.server'
import { readThreadChat } from '../src/lib/thread-chat.server'
import { resolveThreadPublication } from '../src/lib/thread-publication.server'
import type { JobStartResult } from '../../src/job'

const config = {
  baseURL: 'http://localhost:3000', secret: 'thread-publication-selection-test-secret-123456',
  github: { clientId: 'github', clientSecret: 'secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'secret' },
}
const at = '2026-11-09T00:00:00Z'
function git(path: string, ...args: string[]) {
  const run = spawnSync('git', args, { cwd: path, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout.trim()
}
const story = (text: string) =>
  '---\nschema: "0.1"\ntype: event\nid: event.bell\ntitle: "Bell"\nstatus: draft\n---\n\n' + text + '\n'

test('Thread publication pins latest validated Turn, explicit linked branch and review authority across restarts', {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-thread-publication-'))
  const old = Object.fromEntries(['NT_GIT_CACHE_DIR', 'NT_STATE_DIR'].map(key => [key, process.env[key]]))
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  process.env.NT_STATE_DIR = join(root, 'state')
  const file = join(root, 'studio.sqlite')
  let store = openStudioDatabase(file)
  try {
    await migrateStudio(store, config)
    const seed = studioSeed(store)
    const alice = randomUUID(), bob = randomUUID()
    await seed.user(alice)
    await seed.user(bob)
    const source = join(root, 'source')
    mkdirSync(join(source, 'story', 'events'), { recursive: true })
    writeFileSync(join(source, 'story', 'events', 'bell.md'), story('Baseline'))
    git(source, 'init', '-q')
    git(source, 'config', 'user.name', 'Author')
    git(source, 'config', 'user.email', 'author@example.test')
    git(source, 'add', '.')
    git(source, 'commit', '-qm', 'Original Story')
    const base = git(source, 'rev-parse', 'HEAD')
    const repo = randomUUID(), storyId = randomUUID(), thread = randomUUID()
    await seed.repository({ id: repo, ownerUserId: alice, provider: 'github',
      providerRepositoryId: '123', name: 'Acme/Story', createdAt: at })
    await seed.story({ id: storyId, ownerUserId: alice, repositoryId: repo,
      directory: 'story', title: 'Story', createdAt: at, sourceCommitSha: base })
    await seed.thread({ id: thread, ownerUserId: alice, storyId,
      title: 'Main', activityAt: at, createdAt: at })
    const firstId = randomUUID(), secondId = randomUUID()
    const first = await acquireCachedStory({
      cacheDirectory: process.env.NT_GIT_CACHE_DIR!, ownerId: alice,
      repositoryId: 'github:123', remoteUrl: 'file://' + source, token: '',
      commit: base, directory: 'story', jobId: firstId,
      verifiedSizeBytes: Buffer.byteLength(story('Baseline')), verifiedBlobCount: 1,
    })
    const commit = (job: JobStartResult, description: string) => {
      git(job.worktreeRoot, 'add', '-A', '--', 'story')
      git(job.worktreeRoot, 'commit', '-qm', description)
      const head = git(job.worktreeRoot, 'rev-parse', 'HEAD')
      mkdirSync(join(job.stateDir, 'revisions'), { recursive: true })
      writeFileSync(join(job.stateDir, 'revisions', 'verified-head.json'),
        JSON.stringify({ version: 1, jobId: job.jobId, headSha: head, workItemId: 'test' }))
      return head
    }
    const register = async (job: JobStartResult, order: number, baseline: string) => {
      await seed.job({ id: job.jobId, ownerUserId: alice, storyId,
        title: 'Turn ' + order, status: 'completed', sourceCommitSha: baseline,
        generationThreadId: job.threadId + ':generation:web',
        generationRequestJson: JSON.stringify({ task: 'Update bell', fixture: true }),
        createdAt: at, updatedAt: at })
      await seed.threadRun({ jobId: job.jobId, ownerUserId: alice, threadId: thread, runOrder: order })
      await seed.queue({ jobId: job.jobId, ownerUserId: alice,
        intent: 'start', phase: 'finished', createdAt: at, updatedAt: at })
    }
    writeFileSync(join(first.worktreeStoryRoot, 'events', 'bell.md'), story('First Turn'))
    const sha1 = commit(first, 'First verified Turn')
    await register(first, 0, base)
    await readThreadChat(store, alice, thread)
    await store.persistence.continuation.settle(alice, firstId, sha1, at)

    const second = await continueCachedStory(first, secondId, sha1)
    writeFileSync(join(second.worktreeStoryRoot, 'events', 'bell.md'), story('Second Turn'))
    const sha2 = commit(second, 'Second verified Turn')
    await register(second, 1, sha1)
    const message = randomUUID()
    await seed.message({ id: message, ownerUserId: alice, threadId: thread,
      sequence: 3, role: 'user', status: 'queued', body: 'Change the bell again',
      phase: 'running', jobId: secondId, createdAt: at })
    await store.persistence.continuation.settle(alice, secondId, sha2, at)

    await store.persistence.publications.save(alice, firstId, 'github', {
      targetBranch: 'main', remoteBranch: first.branch, headSha: sha1,
      phase: 'linked', number: 17, url: 'https://github.com/Acme/Story/pull/17',
    }, at)
    const option = { threadId: thread, action: 'update' as const, linkJobId: firstId }
    const current = await resolveThreadPublication(store, alice, option)
    assert.equal(current.headSha, sha2)
    assert.equal(current.job.jobId, secondId)
    assert.equal(current.recordJobId, firstId)
    assert.equal(current.remoteBranch, first.branch)
    assert.equal(current.linked?.receipt.headSha, sha1)
    assert.deepEqual(current.review, { passed: 0, skipped: 0 })
    assert.equal((await store.persistence.publications.get(alice, firstId, 'github'))?.headSha, sha1,
      'inspecting and completing later Turns never update the remote publication')

    const separate = await resolveThreadPublication(store, alice, {
      threadId: thread, action: 'create',
    })
    assert.equal(separate.recordJobId, secondId)
    assert.equal(separate.remoteBranch, second.branch)
    assert.equal(separate.linked, null)

    // A fork starts from private parent history. Its Job base is the parent
    // checkpoint, while publication must still pin the imported upstream SHA.
    const forkThread = randomUUID(), forkId = randomUUID()
    await seed.thread({ id: forkThread, ownerUserId: alice, storyId,
      parentThreadId: thread, title: 'Alternative', activityAt: at, createdAt: at })
    const fork = await continueCachedStory(first, forkId, sha1)
    writeFileSync(join(fork.worktreeStoryRoot, 'events', 'bell.md'), story('Forked Turn'))
    const forkSha = commit(fork, 'Forked verified Turn')
    await seed.forkReceipt(forkId, alice, firstId, thread, sha1, at)
    await seed.job({ id: forkId, ownerUserId: alice, storyId, title: 'Fork Turn',
      status: 'completed', sourceCommitSha: sha1,
      generationThreadId: fork.threadId + ':generation:web',
      generationRequestJson: JSON.stringify({ task: 'Fork story', fixture: true }),
      createdAt: at, updatedAt: at })
    await seed.threadRun({ jobId: forkId, ownerUserId: alice, threadId: forkThread, runOrder: 0 })
    await seed.queue({ jobId: forkId, ownerUserId: alice, intent: 'start',
      phase: 'finished', createdAt: at, updatedAt: at })
    await readThreadChat(store, alice, forkThread)
    await store.persistence.continuation.settle(alice, forkId, forkSha, at)
    const forkSelection = await resolveThreadPublication(store, alice, {
      threadId: forkThread, action: 'create',
    })
    assert.equal(forkSelection.job.baseSha, sha1)
    assert.equal(forkSelection.rootBaseSha, base)
    assert.equal(forkSelection.headSha, forkSha)
    assert.equal(forkSelection.recordJobId, forkId)
    assert.equal(forkSelection.publications.length, 0,
      'forked Thread must not inherit its parent PR for automatic updates')

    await assert.rejects(resolveThreadPublication(store, bob, option), /not found/i)
    await assert.rejects(resolveThreadPublication(store, alice, {
      threadId: thread, action: 'update', linkJobId: secondId,
    }), /linked draft/i)

    // A new process uses the same immutable owner-scoped Thread lineage.
    store.close()
    store = openStudioDatabase(file)
    await migrateStudio(store, config)
    const restarted = await resolveThreadPublication(store, alice, option)
    assert.equal(restarted.recordJobId, firstId)
    assert.equal(restarted.headSha, sha2)

    // A planned specialist whose source-backed review evidence is missing
    // never becomes publishable by confirming "partial" in the UI.
    writeFileSync(join(second.stateDir, 'turn-plan.json'), '{}')
    await assert.rejects(resolveThreadPublication(store, alice, option),
      /lack verifiable semantic review selection/)
    unlinkSync(join(second.stateDir, 'turn-plan.json'))

    // Stale persisted validated HEAD cannot be substituted by a frontend SHA.
    writeFileSync(join(second.stateDir, 'revisions', 'verified-head.json'),
      JSON.stringify({ version: 1, jobId: secondId, headSha: 'f'.repeat(40), workItemId: 'tampered' }))
    await assert.rejects(resolveThreadPublication(store, alice, option), /trusted|verified|revision|HEAD/i)
    // Any pending earlier push intent must be reconciled, rather than
    // silently creating a second remote publication.
    writeFileSync(join(second.stateDir, 'revisions', 'verified-head.json'),
      JSON.stringify({ version: 1, jobId: secondId, headSha: sha2, workItemId: 'test' }))
    await store.persistence.publications.save(alice, secondId, 'github', {
      targetBranch: 'main', remoteBranch: second.branch, headSha: sha2,
      phase: 'pending', number: null, url: null,
    }, at)
    await assert.rejects(resolveThreadPublication(store, alice, option),
      /earlier publication is pending/)
    const pendingRetry = await resolveThreadPublication(store, alice, {
      threadId: thread, action: 'create',
    })
    assert.equal(pendingRetry.recordJobId, secondId,
      'retrying an uncertain current push must use its original branch identity')
    await store.testing.records.update('github_publications', { jobId: secondId },
      { headSha: 'd'.repeat(40) })
    await assert.rejects(resolveThreadPublication(store, alice, {
      threadId: thread, action: 'create',
    }), /pending publication pins another checkpoint/)
  } finally {
    store.close()
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
})
