import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createStudioAuth } from '../src/lib/auth'
import { openStudioDatabase, migrateStudio } from './support/studio-database'
import { onboardingRequest } from '../src/lib/onboarding.server'
import { initializeStoryBranch, initialStoryDocument } from '../src/lib/git-cache.server'
import { prepareCachedJob } from '../src/lib/cached-jobs.server'
import { trustedHead } from '../../src/revision'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'onboarding-recovery-secret-0123456789abcd',
  github: { clientId: 'github', clientSecret: 'github-secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'gitlab-secret' },
}
const repoId = '11111111-1111-4111-8111-111111111111'
const storyId = '22222222-2222-4222-8222-222222222222'
const jobId = '33333333-3333-4333-8333-333333333333'
const title = 'The Classroom Loop'

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('after a frontend/server restart, onboarding recovers its original Story job without rewriting Git', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-onboarding-resume-'))
  const env = { state: process.env.NT_STATE_DIR, cache: process.env.NT_GIT_CACHE_DIR }
  process.env.NT_STATE_DIR = join(root, 'state')
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  const db = join(root, 'studio.sqlite')
  let store = openStudioDatabase(db)
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const owner = await ctx.internalAdapter.createUser({
      name: 'Author', email: 'author@example.test', emailVerified: true,
    }, { method: 'test' })
    const session = await ctx.internalAdapter.createSession(owner.id)
    const cookie = 'better-auth.session_token=' + session.token + '.' +
      createHmac('sha256', config.secret).update(session.token).digest('base64')
    await store.persistence.repositories.upsert(owner.id, 'github', '123',
      'Acme/Repo', null, repoId, new Date().toISOString())

    const remote = join(root, 'remote.git')
    const source = join(root, 'source')
    mkdirSync(source)
    git(root, 'init', '-q', '--bare', '--initial-branch=main', remote)
    git(source, 'init', '-q', '--initial-branch=main')
    git(source, 'config', 'user.name', 'Tester')
    git(source, 'config', 'user.email', 'tester@example.test')
    writeFileSync(join(source, 'README.md'), 'Existing remote repository\n')
    git(source, 'add', '.')
    git(source, 'commit', '-qm', 'Initial remote')
    git(source, 'remote', 'add', 'origin', remote)
    git(source, 'push', '-q', 'origin', 'main')
    const base = git(source, 'rev-parse', 'HEAD')
    const input = {
      cacheDirectory: process.env.NT_GIT_CACHE_DIR!, ownerId: owner.id,
      repositoryId: 'github:123', remoteUrl: 'file://' + remote,
      token: 'unused', directory: 'new-test/story', commit: base,
      jobId, title, verifiedSizeBytes: 0, verifiedBlobCount: 0,
    }
    const initialized = await initializeStoryBranch(input)
    const stamp = new Date().toISOString()
    await store.persistence.onboarding.commitGithubInitialization({
      id: storyId, owner: owner.id, repositoryId: repoId, directory: input.directory,
      title, createdAt: stamp, commitSha: base,
      contentSha256: createHash('sha256').update(initialStoryDocument(title)).digest('hex'),
    }, jobId)
    await assert.rejects(() => trustedHead(initialized), /advanced without a trusted revision/)

    const get = (authInstance: typeof auth, sessionCookie: string) => onboardingRequest(authInstance, store,
      new Request(config.baseURL + '/api/onboarding?' + new URLSearchParams({
        repositoryId: repoId, workspace: 'new-test',
      }), { headers: { cookie: sessionCookie } }), config.baseURL)
    const first = await get(auth, cookie)
    assert.equal(first.status, 200)
    const firstBody = await first.json() as any
    assert.equal(firstBody.initialized.kind, 'recoverable')
    assert.equal(firstBody.initialized.created.jobId, jobId)
    assert.equal(firstBody.initialized.created.baseSha, base)
    assert.equal(firstBody.initialized.created.headSha, initialized.headSha)
    assert.equal(firstBody.initialized.created.story.title, title)
    assert.equal(firstBody.initialized.configured, false)
    assert.equal(git(remote, 'rev-parse', 'main'), base)

    store.close()
    store = openStudioDatabase(db)
    const restarted = createStudioAuth(store, config)
    const recovered = await get(restarted, cookie)
    assert.equal(recovered.status, 200)
    assert.equal((await recovered.json() as any).initialized.created.jobId, jobId)
    const prepared = await prepareCachedJob(store, owner.id, input.token, 'github',
      new Request(config.baseURL + '/api/github/jobs', {
        method: 'POST', body: JSON.stringify({ storyId, jobId, commit: base }),
      }), async () => ({ remoteUrl: input.remoteUrl, reopenDraft: true as const }))
    assert.equal(prepared.headSha, initialized.headSha)
    assert.equal(await trustedHead(initialized), initialized.headSha)
    assert.equal(git(initialized.worktreeRoot, 'rev-list', '--count', base + '..HEAD'), '1')
    assert.equal(git(remote, 'rev-parse', 'main'), base)

    const foreign = await get(restarted, '')
    assert.equal(foreign.status, 401)
  } finally {
    store.close()
    for (const [key, previous] of [['NT_STATE_DIR', env.state], ['NT_GIT_CACHE_DIR', env.cache]] as const) {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
    rmSync(root, { recursive: true, force: true })
  }
})
