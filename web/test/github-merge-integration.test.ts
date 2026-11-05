import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createStudioAuth } from '../src/lib/auth'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from '../src/db/migrations'
import { prepareCachedJob } from '../src/lib/cached-jobs.server'
import { initializeStoryBranch } from '../src/lib/git-cache.server'

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('shared GitHub job controller reopens only the saved unpublished initialization draft', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-github-reopen-'))
  const oldState = process.env.NT_STATE_DIR
  const oldCache = process.env.NT_GIT_CACHE_DIR
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
    store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES (?,?, 'github','123','Acme/Repo',?)`)
      .run(repositoryId, owner.id, now)
    store.sqlite.prepare(`INSERT INTO stories
      (id,owner_user_id,repository_id,directory,title,source_commit_sha,created_at)
      VALUES (?,?,?,'new-story',?,?,?)`)
      .run(storyId, owner.id, repositoryId, title, pinned, now)
    store.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at)
      VALUES (?,?,?,?,?,'paused',?,?)`)
      .run(jobId, owner.id, storyId, title, pinned, now, now)

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
    assert.equal(git(remote, 'rev-parse', 'main'), pinned)

    // Even a buggy provider callback cannot turn a missing initialization
    // manifest into a new job through the reopened-draft path.
    await assert.rejects(
      prepareCachedJob(store, owner.id, sourceInput.token, 'github',
        request('55555555-5555-4555-8555-555555555555'),
        async () => ({ remoteUrl: sourceInput.remoteUrl, reopenDraft: true })),
      /could not be created or reopened safely/,
    )
    assert.equal((store.sqlite.prepare('SELECT COUNT(*) AS n FROM studio_sessions').get() as { n: number }).n, 1)
  } finally {
    store.sqlite.close()
    if (oldState === undefined) delete process.env.NT_STATE_DIR
    else process.env.NT_STATE_DIR = oldState
    if (oldCache === undefined) delete process.env.NT_GIT_CACHE_DIR
    else process.env.NT_GIT_CACHE_DIR = oldCache
    rmSync(root, { recursive: true, force: true })
  }
})
