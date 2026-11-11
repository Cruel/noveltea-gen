import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { removeTestTree } from '../../test/helpers'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createStudioAuth } from '../src/lib/auth'
import { verifiedGithubInitialFoundation } from '../src/lib/github-initial-foundation.server'
import { verifiedReusableStoryFoundation } from '../src/lib/story-foundation-reuse.server'
import { pinReusedFoundation, readReusedFoundation } from '../../src/chat-reused-foundation'
import { validateStoryJob } from '../../src/validator'
import { renderFoundation } from '../../src/foundation-record'
import { pinChatApprovedFoundation } from '../../src/chat-approved-foundation'
import { runFoundationJob } from '../../src/foundation'
import { createSkillSnapshot } from '../../src/snapshot'
import { nativeExecutable } from '../../src/validator'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from './support/studio-database'
import { isVerifiedInitializedDraft, prepareCachedJob } from '../src/lib/cached-jobs.server'
import { trustedHead } from '../../src/revision'
import { initializeStoryBranch, initialStoryDocument } from '../src/lib/git-cache.server'

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('shared GitHub job controller reopens only the saved unpublished initialization draft', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-github-reopen-'))
  const oldState = process.env.NT_STATE_DIR
  const oldCache = process.env.NT_GIT_CACHE_DIR
  const oldSkills = process.env.NT_SKILL_CACHE_DIR
  const oldConfig = process.env.NT_CONFIG_FILE
  process.env.NT_SKILL_CACHE_DIR = join(root, 'skill-cache')
  process.env.NT_STATE_DIR = join(root, 'state')
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  const store = openStudioDatabase(join(root, 'studio.sqlite'))
  try {
    const config = {
      baseURL: 'http://localhost:3000',
      secret: 'github-reopen-test-secret-12345678901234567890',
      github: { clientId: 'github', clientSecret: 'github-secret' },
      gitlab: { clientId: 'gitlab', clientSecret: 'gitlab-secret' },
    }
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const context = await auth.$context
    const owner = await context.internalAdapter.createUser({
      name: 'Author', email: 'author@example.test', emailVerified: true,
    }, { method: 'test' })
    const remote = join(root, 'remote.git')
    const source = join(root, 'source')
    mkdirSync(source)
    git(root, 'init', '-q', '--bare', '--initial-branch=main', remote)
    git(source, 'init', '-q', '--initial-branch=main')
    git(source, 'config', 'user.email', 'author@example.test')
    git(source, 'config', 'user.name', 'Author')
    writeFileSync(join(source, 'README.md'), 'Existing repository baseline\n')
    git(source, 'add', 'README.md')
    git(source, 'commit', '-qm', 'Original baseline')
    git(source, 'remote', 'add', 'origin', remote)
    git(source, 'push', '-q', 'origin', 'main')
    const pinned = git(source, 'rev-parse', 'HEAD')
    const jobId = '22222222-2222-4222-8222-222222222222'
    const storyId = '33333333-3333-4333-8333-333333333333'
    const repositoryId = '44444444-4444-4444-8444-444444444444'
    const title = 'Draft Mystery'
    const sourceInput = {
      cacheDirectory: process.env.NT_GIT_CACHE_DIR, ownerId: owner.id,
      repositoryId: 'github:123', remoteUrl: 'file://' + remote,
      token: 'test-git-credential', directory: 'new-story',
      commit: pinned, jobId, title, verifiedSizeBytes: 0, verifiedBlobCount: 0,
    }
    const initialized = await initializeStoryBranch(sourceInput)
    assert.notEqual(initialized.headSha, pinned)
    const now = new Date().toISOString()
    await store.persistence.repositories.upsert(owner.id, 'github', '123',
      'Acme/Repo', null, repositoryId, now)
    await store.persistence.onboarding.importStory({
      id: storyId, owner: owner.id, repositoryId, directory: 'new-story',
      title, createdAt: now, commitSha: pinned,
      contentSha256: createHash('sha256').update(initialStoryDocument(title)).digest('hex'),
    })
    await store.persistence.generation.jobs.register(
      owner.id, jobId, storyId, title, pinned, now)

    const request = (id: string) => new Request('http://localhost:3000/api/github/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storyId, jobId: id, commit: pinned }),
    })
    const reopen = await prepareCachedJob(store, owner.id, sourceInput.token, 'github',
      request(jobId), async (row, commit, existingJob) => {
        assert.equal(row.title, title)
        assert.equal(commit, pinned)
        assert.equal(existingJob, true)
        return { remoteUrl: sourceInput.remoteUrl, reopenDraft: true }
      })
    assert.equal(reopen.baseSha, pinned)
    assert.equal(reopen.headSha, initialized.headSha)
    assert.equal(await trustedHead(initialized), initialized.headSha)
    assert.equal(await isVerifiedInitializedDraft(initialized), true)
    assert.equal(git(remote, 'rev-parse', 'main'), pinned)

    // A newly submitted first Chat Turn has its own UUID. The controller
    // permits exactly one duplicate-safe initialization *placeholder* on that
    // isolated job; it cannot invent a different Creative Direction or skip
    // remote membership/commit verification.
    const firstChatId = '66666666-6666-4666-8666-666666666666'
    const fresh = await prepareCachedJob(store, owner.id, sourceInput.token, 'github',
      request(firstChatId), async (_row, commit, alreadyRegistered) => {
        assert.equal(commit, pinned)
        assert.equal(alreadyRegistered, false)
        return { remoteUrl: sourceInput.remoteUrl, initializeDraft: true as const }
      })
    assert.equal(fresh.baseSha, pinned)
    assert.notEqual(fresh.headSha, pinned)
    const firstJob = await import('../../src/job').then(mod => mod.startStoryJob({
      story: initialized.storyRoot, job: firstChatId,
    }, false))
    assert.equal(await trustedHead(firstJob), fresh.headSha)
    assert.equal(await isVerifiedInitializedDraft(firstJob), true)
    assert.equal(git(firstJob.worktreeRoot, 'diff', '--name-only', pinned, 'HEAD'),
      'new-story/creative-direction/foundation.md')
    assert.equal(git(firstJob.worktreeRoot, 'rev-list', '--count', pinned + '..HEAD'), '1')
    const repeated = await prepareCachedJob(store, owner.id, sourceInput.token, 'github',
      request(firstChatId), async () =>
        ({ remoteUrl: sourceInput.remoteUrl, reopenDraft: true as const }))
    assert.equal(repeated.headSha, fresh.headSha)
    assert.equal(git(remote, 'rev-parse', 'main'), pinned)

    if (existsSync(nativeExecutable())) {
      const skillRepo = join(root, 'skill-source')
      mkdirSync(join(skillRepo, 'skills', 'nt-story-discovery'), { recursive: true })
      mkdirSync(join(skillRepo, 'skills', 'nt-catalog', 'references'), { recursive: true })
      git(skillRepo, 'init', '-q')
      for (const name of ['nt-story-discovery', 'nt-catalog'])
        writeFileSync(join(skillRepo, 'skills', name, 'SKILL.md'),
          '---\nname: ' + name + '\ndescription: Tests\n---\nOriginal skills\n')
      for (const name of ['records.md', 'authority-and-validation.md', 'glossary.md'])
        writeFileSync(join(skillRepo, 'skills', 'nt-catalog', 'references', name), '# Catalog\n')
      git(skillRepo, 'add', '.')
      git(skillRepo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
        'commit', '-qm', 'Pinned test skills')
      const configFile = join(root, 'skills-config.json')
      writeFileSync(configFile, JSON.stringify({ novelteaSkills: skillRepo, skillDiscovery: 'explicit-only' }))
      process.env.NT_CONFIG_FILE = configFile
      const snapshot = await createSkillSnapshot({
        discovery: 'explicit-only', novelteaSkills: skillRepo,
        skillDirs: [], requiredSkills: ['nt-story-discovery', 'nt-catalog'],
      })
      assert.ok(snapshot)
      const originalRequest = 'Make me a mystery game'
      const foundation = {
        id: 'foundation', title: 'Last Bell', premise: 'A bell is stolen at midnight',
        central_conflict: 'A town must reveal the truth or protect the culprit',
        genre: 'Mystery', tone: 'Suspenseful',
        player_experience: 'Interview townspeople and make significant decisions',
        scope: 'One coastal town',
        body: 'An old bell disappears and a village investigates.',
        decisions: [
          { id: 'original-request', statement: originalRequest,
            origin: 'user' as const, authority: 'user-protected' as const },
          { id: 'chosen-setting', statement: 'The town is on a stormy coast',
            origin: 'agent' as const, authority: 'delegated' as const },
        ],
      }
      await pinChatApprovedFoundation(firstJob, {
        jobId: firstJob.jobId, sourceSha: pinned, firstTurnId: firstChatId,
        scope: 'whole-story', originalObjective: originalRequest,
        proposalDigest: 'b'.repeat(64), skillId: snapshot!.id, foundation,
        creativeMode: 'autonomous', provider: 'openai', model: 'gpt-6-luna',
      })
      const result = await runFoundationJob({
        story: firstJob.storyRoot, job: firstChatId, task: originalRequest,
        envelope: '', skillsSource: skillRepo, provider: 'openai', model: 'gpt-6-luna',
      })
      assert.equal(result.status, 'committed')
      assert.equal(readFileSync(join(firstJob.worktreeStoryRoot,
        'creative-direction/foundation.md'), 'utf8'), renderFoundation(foundation))
      assert.equal(git(firstJob.worktreeRoot, 'rev-list', '--count', pinned + '..HEAD'), '2')
      assert.equal(await trustedHead(firstJob), result.commitSha)
      assert.equal(git(remote, 'rev-parse', 'main'), pinned)
    }

    // A previously approved (non-placeholder) GitHub initialization is still
    // unpublished at the pinned remote source. The original onboarding job is
    // the sole source of its reviewed content; the fresh first Chat Turn must
    // use its exact one-file committed bytes instead of interviewing again.
    const approvedInitId = '77777777-7777-4777-8777-777777777777'
    const approvedStoryId = '88888888-8888-4888-8888-888888888888'
    const approvedChatId = '99999999-9999-4999-8999-999999999999'
    const authored = renderFoundation({
      id: 'foundation', title: 'Approved Story',
      premise: 'A forgotten town hides evidence', central_conflict: 'Who can know the truth?',
      genre: 'Mystery', tone: 'Suspense', player_experience: 'Investigate the clues',
      scope: 'A compact narrative', body: 'An approved and authored Creative Direction.',
      decisions: [{ id: 'original-author', statement: 'Keep the mystery grounded',
        origin: 'user', authority: 'user-protected' }],
    })
    const approvedDigest = createHash('sha256').update(authored).digest('hex')
    const approvedInput = { ...sourceInput, jobId: approvedInitId,
      directory: 'approved-story', title: 'Approved Story' }
    const originalApproved = await initializeStoryBranch({
      ...approvedInput, foundationMarkdown: authored,
    })
    const createdAt = new Date(Date.now() + 10_000).toISOString()
    await store.persistence.onboarding.commitGithubInitialization({
      id: approvedStoryId, owner: owner.id, repositoryId,
      directory: 'approved-story', title: 'Approved Story',
      createdAt, commitSha: pinned, contentSha256: approvedDigest,
    }, approvedInitId)
    assert.equal(await store.persistence.naturalStory.originalInitializationJob(
      owner.id, approvedStoryId), approvedInitId)
    const selected = await verifiedGithubInitialFoundation(
      store, owner.id, approvedStoryId, pinned, approvedDigest)
    assert.equal(selected, authored)
    await assert.rejects(verifiedGithubInitialFoundation(
      store, owner.id, approvedStoryId, pinned, 'f'.repeat(64)), /digest/)
    const approved = await prepareCachedJob(store, owner.id, sourceInput.token, 'github',
      new Request('http://localhost:3000/api/github/jobs', {
        method: 'POST', body: JSON.stringify({
          storyId: approvedStoryId, jobId: approvedChatId, commit: pinned,
        }),
      }), async (_row, _commit, existingJob) => {
        assert.equal(existingJob, false)
        return { remoteUrl: sourceInput.remoteUrl,
          initializeDraft: true as const, foundationMarkdown: selected }
      })
    const reusedJob = await import('../../src/job').then(mod => mod.startStoryJob({
      story: originalApproved.storyRoot, job: approvedChatId,
    }, false))
    assert.equal(await trustedHead(reusedJob), approved.headSha)
    assert.equal(await verifiedReusableStoryFoundation(reusedJob,
      await validateStoryJob(reusedJob)), true)
    const copied = readFileSync(join(reusedJob.worktreeStoryRoot,
      'creative-direction/foundation.md'), 'utf8')
    assert.equal(copied, authored)
    await pinReusedFoundation(reusedJob, 'Only the existing Creative Direction')
    assert.equal((await readReusedFoundation(reusedJob))?.sourceSha, pinned)
    assert.equal(git(reusedJob.worktreeRoot, 'rev-list', '--count', pinned + '..HEAD'), '1')
    assert.equal(git(originalApproved.worktreeRoot, 'rev-parse', 'HEAD'),
      originalApproved.headSha)
    assert.equal(git(remote, 'rev-parse', 'main'), pinned)

    // Even a buggy provider callback cannot turn a missing initialization
    // manifest into a new job through the reopened-draft path.
    await assert.rejects(
      prepareCachedJob(store, owner.id, sourceInput.token, 'github',
        request('55555555-5555-4555-8555-555555555555'),
        async () => ({ remoteUrl: sourceInput.remoteUrl, reopenDraft: true })),
      /could not be created or reopened safely/,
    )
    assert.equal((await store.persistence.dashboard.forOwner(owner.id)).recentSessions.length, 4)
  } finally {
    store.close()
    if (oldState === undefined) delete process.env.NT_STATE_DIR
    else process.env.NT_STATE_DIR = oldState
    if (oldCache === undefined) delete process.env.NT_GIT_CACHE_DIR
    else process.env.NT_GIT_CACHE_DIR = oldCache
    if (oldSkills === undefined) delete process.env.NT_SKILL_CACHE_DIR
    else process.env.NT_SKILL_CACHE_DIR = oldSkills
    if (oldConfig === undefined) delete process.env.NT_CONFIG_FILE
    else process.env.NT_CONFIG_FILE = oldConfig
    removeTestTree(root)
  }
})
