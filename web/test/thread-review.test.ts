import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { migrateStudio } from './support/studio-database'
import { acquireCachedStory, continueCachedStory } from '../src/lib/git-cache.server'
import { readThreadChat } from '../src/lib/thread-chat.server'
import { readThreadReview, readThreadReviewDiff, requestThreadCorrection } from '../src/lib/thread-review.server'
import type { JobStartResult } from '../../src/job'

const config = {
  baseURL: 'http://localhost:3000', secret: 'review-test-secret-0123456789012345',
  github: { clientId: 'github', clientSecret: 'secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'secret' },
}
function git(root: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const event = (id: string, text: string) =>
  '---\nschema: "0.1"\ntype: event\nid: event.' + id + '\ntitle: "' +
  id + '"\nstatus: draft\n---\n\n' + text + '\n'
const at = '2026-11-09T00:00:00Z'

test('Turn review follows verified isolated lineage, partial publication, deletions and new correction Turns', {
  timeout: 180_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-thread-review-'))
  const keys = ['NT_GIT_CACHE_DIR', 'NT_STATE_DIR', 'NT_NATIVE_CLI']
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  process.env.NT_STATE_DIR = join(root, 'state')
  const store = openStudioDatabase(join(root, 'studio.sqlite'))
  try {
    await migrateStudio(store, config)
    const seed = studioSeed(store)
    const alice = randomUUID(), bob = randomUUID()
    await seed.user(alice); await seed.user(bob)
    const remote = join(root, 'remote')
    mkdirSync(join(remote, 'story', 'events'), { recursive: true })
    mkdirSync(join(remote, 'story', 'notes'), { recursive: true })
    writeFileSync(join(remote, 'story', 'events', 'bell.md'), event('bell', 'First bell'))
    writeFileSync(join(remote, 'story', 'events', 'old.md'), event('old', 'Retired event'))
    git(remote, 'init', '-q')
    git(remote, 'config', 'user.name', 'Author')
    git(remote, 'config', 'user.email', 'author@example.test')
    git(remote, 'add', '.')
    git(remote, 'commit', '-qm', 'base Story')
    const base = git(remote, 'rev-parse', 'HEAD')
    const repoId = randomUUID(), storyId = randomUUID(), threadId = randomUUID()
    await seed.repository({ id: repoId, ownerUserId: alice, provider: 'github',
      providerRepositoryId: '123', name: 'Owner/Story', createdAt: at })
    await seed.story({ id: storyId, ownerUserId: alice, repositoryId: repoId,
      directory: 'story', title: 'Story', createdAt: at, sourceCommitSha: base })
    await seed.thread({ id: threadId, ownerUserId: alice, storyId, title: 'Main',
      activityAt: at, createdAt: at })
    const firstId = randomUUID(), secondId = randomUUID()
    const first = await acquireCachedStory({ cacheDirectory: process.env.NT_GIT_CACHE_DIR!,
      ownerId: alice, repositoryId: 'github:123', remoteUrl: 'file://' + remote,
      token: 'unused', commit: base, directory: 'story', jobId: firstId,
      verifiedSizeBytes: Buffer.byteLength(event('bell', 'First bell')) +
        Buffer.byteLength(event('old', 'Retired event')), verifiedBlobCount: 2 })
    const commit = (job: JobStartResult, title: string) => {
      git(job.worktreeRoot, 'add', '-A', '--', 'story')
      git(job.worktreeRoot, 'commit', '-qm', title)
      const head = git(job.worktreeRoot, 'rev-parse', 'HEAD')
      mkdirSync(join(job.stateDir, 'revisions'), { recursive: true })
      writeFileSync(join(job.stateDir, 'revisions', 'verified-head.json'),
        JSON.stringify({ version: 1, jobId: job.jobId, headSha: head, workItemId: 'test' }))
      return head
    }
    const register = async (job: JobStartResult, thread: string, runOrder: number,
      task: string, parent: string) => {
      await seed.job({ id: job.jobId, ownerUserId: alice, storyId, title: task,
        sourceCommitSha: parent, generationThreadId: job.threadId + ':generation:web',
        generationRequestJson: JSON.stringify({ task, fixture: true }),
        status: 'completed', createdAt: at, updatedAt: at })
      await seed.threadRun({ jobId: job.jobId, ownerUserId: alice, threadId: thread, runOrder })
      await seed.queue({ jobId: job.jobId, ownerUserId: alice, intent: 'start',
        phase: 'finished', createdAt: at, updatedAt: at })
    }

    // Native validator stub runs only in the temp fixture. Catalog paths and
    // verified Git are real; this fixture cannot fabricate a different head.
    const cli = join(root, 'noveltea')
    writeFileSync(cli, `#!/usr/bin/env node
if (process.argv.length === 3 && process.argv[2] === '--version') {
  process.stdout.write('1.0.0\\n'); process.exit(0);
}
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[5];
const records = ['bell','old'].filter(id => fs.existsSync(path.join(root, 'events', id + '.md')))
  .map(id => ({path:'events/' + id + '.md', metadata:{
    type:'event', id:'event.' + id, title:id, status:'draft'}}));
process.stdout.write(JSON.stringify({protocolVersion:1, success:true, exitCode:0,
  diagnostics:[], catalog:{contractRevision:'0.1',records, diagnostics:[],
    coverage:{},authorization:{},
    protection:{status:'checked',base:process.argv[process.argv.indexOf('--base') + 1],
      authorizationVerified:false,complete:true,findings:[],impact:{changed:[],moved:[],affected:[]}}},
  readiness:{contractRevision:'0.1',stage:'review',view:'design',design:{stages:{}},approved:{stages:{}},outstanding:[]}}));
`)
    chmodSync(cli, 0o755)
    process.env.NT_NATIVE_CLI = cli

    writeFileSync(join(first.worktreeStoryRoot, 'events', 'bell.md'), event('bell', 'First revision'))
    unlinkSync(join(first.worktreeStoryRoot, 'events', 'old.md'))
    mkdirSync(join(first.worktreeStoryRoot, 'notes'), { recursive: true })
    writeFileSync(join(first.worktreeStoryRoot, 'notes', 'unindexed.md'), 'PRIVATE DRAFT NOTES')
    const sha1 = commit(first, 'Turn one')
    await register(first, threadId, 0, 'Change the first bell', base)
    // The completed assistant receipt is the authoritative validation boundary.
    await readThreadChat(store, alice, threadId)
    await store.persistence.continuation.settle(alice, firstId, sha1, at)

    const second = await continueCachedStory(first, secondId, sha1)
    writeFileSync(join(second.worktreeStoryRoot, 'events', 'bell.md'), event('bell', 'Second revision'))
    const sha2 = commit(second, 'Turn two')
    await register(second, threadId, 1, 'Change the bell again', sha1)
    const turn2 = randomUUID()
    await seed.message({ id: turn2, ownerUserId: alice, threadId, sequence: 3, role: 'user',
      status: 'queued', body: 'Change the bell again', phase: 'running', jobId: secondId,
      createdAt: at })
    await store.persistence.continuation.settle(alice, secondId, sha2, at)

    const turn1 = 'initial:' + firstId
    const chat = await readThreadChat(store, alice, threadId)
    assert.equal(chat.turnReceipts.find(turn => turn.id === turn1)?.executions[0]?.validatedSha, sha1)
    assert.equal(chat.turnReceipts.find(turn => turn.id === turn2)?.executions[0]?.validatedSha, sha2)

    const firstView = await readThreadReview(store, alice, threadId, { kind: 'turn', turnId: turn1 })
    assert.equal(firstView.baseSha, base)
    assert.equal(firstView.headSha, sha1)
    assert.equal(firstView.currentSha, sha2)
    assert.deepEqual(firstView.files.map(item => [item.path, item.status, item.recordId]), [
      ['events/bell.md', 'modified', 'event.bell'],
      ['events/old.md', 'deleted', 'event.old'],
      ['notes/unindexed.md', 'added', null],
    ])
    const firstDiff = await readThreadReviewDiff(store, alice, threadId,
      { kind: 'turn', turnId: turn1 }, 'events/old.md', sha2)
    assert.match(firstDiff.diff ?? '', /Retired event/)
    const privateDiff = await readThreadReviewDiff(store, alice, threadId,
      { kind: 'turn', turnId: turn1 }, 'notes/unindexed.md', sha2)
    assert.equal(privateDiff.diff, null)
    assert.doesNotMatch(JSON.stringify(firstView) + JSON.stringify(privateDiff), /PRIVATE DRAFT NOTES/)

    const secondView = await readThreadReview(store, alice, threadId, { kind: 'turn', turnId: turn2 })
    assert.equal(secondView.baseSha, sha1)
    assert.deepEqual(secondView.files.map(item => item.path), ['events/bell.md'])
    const cumulative = await readThreadReview(store, alice, threadId, { kind: 'cumulative' })
    assert.equal(cumulative.baseSha, base)
    assert.equal(cumulative.headSha, sha2)
    assert.deepEqual(cumulative.files.map(item => item.status), ['modified', 'deleted', 'added'])

    // A linked publication for Turn one becomes the exact unpublished baseline.
    await store.persistence.publications.save(alice, firstId, 'github', {
      targetBranch: 'main', remoteBranch: 'review', headSha: sha1, phase: 'linked',
      number: 1, url: 'https://example.test/pull/1',
    }, at)
    const afterPublish = await readThreadReview(store, alice, threadId, { kind: 'cumulative' })
    assert.equal(afterPublish.baseSha, sha1)
    assert.equal(afterPublish.headSha, sha2)
    assert.deepEqual(afterPublish.files.map(item => item.path), ['events/bell.md'])
    // An explicit update of the original draft links Turn two's exact SHA to
    // that earlier PR, leaving no unreviewed changes in the cumulative view.
    await store.persistence.publications.save(alice, firstId, 'github', {
      targetBranch: 'main', remoteBranch: 'review', headSha: sha2, phase: 'linked',
      number: 1, url: 'https://example.test/pull/1',
    }, at)
    const afterUpdate = await readThreadReview(store, alice, threadId, { kind: 'cumulative' })
    assert.equal(afterUpdate.publicationSha, sha2)
    assert.equal(afterUpdate.baseSha, sha2)
    assert.deepEqual(afterUpdate.files, [])

    await assert.rejects(() => readThreadReview(store, bob, threadId, { kind: 'cumulative' }), /not found/i)
    await assert.rejects(() => readThreadReviewDiff(store, alice, threadId,
      { kind: 'turn', turnId: turn1 }, 'events/bell.md', sha1), /Thread advanced/)
    await assert.rejects(() => readThreadReview(store, alice, threadId,
      { kind: 'turn', turnId: randomUUID() }), /no completed verified revision/)
    await assert.rejects(() => requestThreadCorrection(store, alice, threadId,
      { kind: 'turn', turnId: turn2 }, 'events/bell.md', 0, 'Make it gentler',
      sha1, sha2, randomUUID()), /Thread advanced/)
    assert.equal((await readThreadChat(store, alice, threadId)).messages.filter(m =>
      m.role === 'user' && m.phase === 'queued').length, 0)

    // A locally modified (unverified) worktree never becomes a review source,
    // even when a previous assistant receipt still points at a verified SHA.
    writeFileSync(join(second.worktreeStoryRoot, 'events', 'bell.md'), 'SECRET UNVERIFIED DRAFT')
    await assert.rejects(() => readThreadReview(store, alice, threadId,
      { kind: 'cumulative' }), /unverified files/)
    git(second.worktreeRoot, 'restore', '--', 'story/events/bell.md')

    const correction = randomUUID()
    await requestThreadCorrection(store, alice, threadId, { kind: 'turn', turnId: turn2 },
      'events/bell.md', 0, 'Make it gentler', sha2, sha2, correction)
    const response = await readThreadChat(store, alice, threadId)
    assert.match(response.messages.find(item => item.id === correction)?.content ?? '',
      /Selected diff hunk:[\s\S]*Make it gentler/)
    assert.equal(response.messages.find(item => item.id === correction)?.hasRevisionScope, 0)
    assert.equal(response.messages.find(item => item.id === correction)?.phase, 'queued')
    assert.equal(git(second.worktreeRoot, 'rev-parse', 'HEAD'), sha2)
    assert.equal(await store.testing.records.count('studio_sessions'), 2,
      'a queued correction cannot create a writer without ordinary admission')
    assert.equal(await store.testing.records.count('thread_protected_decisions'), 0,
      'review/correction never writes protected-decision approvals')
    assert.equal((await store.persistence.publications.get(alice, secondId, 'github')), null)

    // A fork uses its own initial SHA; parent unpublished Turn two and the
    // parent's PR are never inherited into the fork's cumulative review.
    const forkId = randomUUID(), forkJobId = randomUUID()
    await seed.thread({ id: forkId, ownerUserId: alice, storyId, parentThreadId: threadId,
      title: 'Fork', activityAt: at, createdAt: at })
    const fork = await continueCachedStory(first, forkJobId, sha1)
    writeFileSync(join(fork.worktreeStoryRoot, 'events', 'bell.md'), event('bell', 'Fork alternative'))
    const forkSha = commit(fork, 'Fork Turn')
    await seed.forkReceipt(forkJobId, alice, firstId, threadId, sha1, at)
    await register(fork, forkId, 0, 'Alternate bell', sha1)
    await readThreadChat(store, alice, forkId)
    await store.persistence.continuation.settle(alice, forkJobId, forkSha, at)
    const forkReview = await readThreadReview(store, alice, forkId, { kind: 'cumulative' })
    assert.equal(forkReview.baseSha, sha1)
    assert.equal(forkReview.headSha, forkSha)
    assert.equal(forkReview.publicationSha, null)
    assert.deepEqual(forkReview.files.map(item => item.path), ['events/bell.md'])
    assert.notEqual(forkSha, sha2)
    assert.equal((await readThreadReview(store, alice, threadId,
      { kind: 'cumulative' })).headSha, sha2)
  } finally {
    store.close()
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key]
      else process.env[key] = old[key]
    }
    removeTestTree(root)
  }
})
