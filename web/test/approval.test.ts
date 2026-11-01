import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { approvalRequest } from '../src/lib/approval.server'
import { verifyAuthorEvidence } from '../../src/author-evidence'

const config = { baseURL: 'http://localhost:3000', secret: 'approval-test-secret-0123456789abcdefghijklmnopqrstuvwxyz',
  github: { clientId: 'github', clientSecret: 'secret' }, gitlab: { clientId: 'gitlab', clientSecret: 'secret' } }

test('authenticated owner records an exact durable decision; foreign users, inline claims and nonce replay cannot approve', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-web-approval-'))
  const previous = { state: process.env.NT_STATE_DIR, cache: process.env.NT_GIT_CACHE_DIR }
  process.env.NT_STATE_DIR = join(root, 'state')
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  const store = openStudioDatabase(join(root, 'studio.sqlite'))
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config), ctx = await auth.$context
    const alice = await ctx.internalAdapter.createUser({ name: 'Alice', email: 'alice@test.example', emailVerified: true }, { method: 'test' })
    const bob = await ctx.internalAdapter.createUser({ name: 'Bob', email: 'bob@test.example', emailVerified: true }, { method: 'test' })
    const cookie = async (id: string) => {
      const s = await ctx.internalAdapter.createSession(id)
      return 'better-auth.session_token=' + s.token + '.' + createHmac('sha256', config.secret).update(s.token).digest('base64')
    }
    const aliceCookie = await cookie(alice.id), bobCookie = await cookie(bob.id)
    const repo = join(root, 'source'); mkdirSync(join(repo, 'story'), { recursive: true })
    writeFileSync(join(repo, 'story/README.md'), 'Approval fixture\n')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
    git('init', '-q'); git('config', 'user.name', 'Author'); git('config', 'user.email', 'author@test.example')
    git('add', '.'); git('commit', '-qm', 'baseline')
    const commit = git('rev-parse', 'HEAD'), jobId = randomUUID(), storyId = randomUUID(), repositoryId = randomUUID()
    const job = await acquireCachedStory({ cacheDirectory: process.env.NT_GIT_CACHE_DIR!, ownerId: alice.id,
      repositoryId: 'github:123', remoteUrl: 'file://' + repo, token: '', directory: 'story', commit, jobId })
    store.sqlite.prepare(`INSERT INTO repositories (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES (?,?,'github','123','Author/Story','2026-10-31')`).run(repositoryId, alice.id)
    store.sqlite.prepare(`INSERT INTO stories (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha)
      VALUES (?,?,?,'story','Story','2026-10-31',?)`).run(storyId, alice.id, repositoryId, commit)
    store.sqlite.prepare(`INSERT INTO studio_sessions (id,owner_user_id,story_id,title,status,source_commit_sha,created_at,updated_at)
      VALUES (?,?,?,'Job','paused',?,'2026-10-31','2026-10-31')`).run(jobId, alice.id, storyId, commit)
    const plan = { version: 1, contract: { scope: 'fixture' }, items: [] }, contract = { scope: 'revised fixture' }
    const digest = createHash('sha256').update(JSON.stringify({ plan, head: commit, contract })).digest('hex')
    writeFileSync(join(job.stateDir, 'architecture.json'), JSON.stringify({ jobId, threadId: job.threadId,
      baseSha: commit, expectedHead: commit, phase: 'ready', plan,
      proposal: { version: 2, digest, baselineHead: commit, contract } }))
    const post = (body: unknown, session = aliceCookie, origin = config.baseURL) => approvalRequest(auth, store,
      new Request(config.baseURL + '/api/approvals', { method: 'POST', headers: {
        origin, cookie: session, 'content-type': 'application/json' }, body: JSON.stringify(body) }), config.baseURL)
    const request = { action: 'request', jobId, id: 'plan-one', kind: 'plan' }
    assert.equal((await post(request, '')).status, 401)
    assert.equal((await post(request, bobCookie)).status, 404)
    assert.equal((await post(request, aliceCookie, 'https://evil.example')).status, 403)
    const staged = await post(request); assert.equal(staged.status, 200, await staged.clone().text())
    const pending = await staged.json()
    assert.equal(pending.phase, 'awaiting-controller')
    const decide = { action: 'decide', jobId, id: pending.id, nonce: pending.nonce, proposalSha256: digest, decision: 'approved' }
    assert.equal((await post({ ...decide, principal: 'user:' + alice.id })).status, 400)
    assert.equal((await post(decide, bobCookie)).status, 404)
    assert.equal((await post({ ...decide, nonce: randomUUID() })).status, 409)
    const approved = await post(decide); assert.equal(approved.status, 200, await approved.clone().text())
    const saved = await approved.json()
    assert.equal(saved.principal, 'user:' + alice.id)
    assert.equal(saved.source, 'trusted-web')
    assert.deepEqual(await (await post(decide)).json(), saved)
    assert.equal((await post({ ...decide, decision: 'rejected' })).status, 409)
    assert.equal(verifyAuthorEvidence(job, { receiptId: pending.id, nonce: pending.nonce }).payload.proposalSha256, digest)
    assert.equal(git('rev-parse', 'HEAD'), commit)
  } finally {
    store.sqlite.close()
    for (const [key, value] of [['NT_STATE_DIR', previous.state], ['NT_GIT_CACHE_DIR', previous.cache]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})
