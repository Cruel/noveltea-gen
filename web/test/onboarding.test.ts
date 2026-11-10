import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from './support/studio-database'
import { createStudioAuth } from '../src/lib/auth'
import { onboardingRequest, blankOnboardingDraft, reviewedOnboarding } from '../src/lib/onboarding.server'

const config = {
  baseURL: 'http://localhost:3000', secret: 'onboarding-test-secret-0123456789abcdefgh',
  github: { clientId: 'gh', clientSecret: 'gh-secret' },
  gitlab: { clientId: 'gl', clientSecret: 'gl-secret' },
}
const repo = '11111111-1111-4111-8111-111111111111'
test('owner can answer multiple discovery rounds, resume after restart, and review a pinned canonical contract', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-onboarding-'))
  const file = join(root, 'studio.sqlite')
  let store = openStudioDatabase(file)
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const alice = await ctx.internalAdapter.createUser({
      name: 'Alice', email: 'alice@example.test', emailVerified: true,
    }, { method: 'test' })
    const bob = await ctx.internalAdapter.createUser({
      name: 'Bob', email: 'bob@example.test', emailVerified: true,
    }, { method: 'test' })
    const cookie = async (id: string) => {
      const session = await ctx.internalAdapter.createSession(id)
      return 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', config.secret).update(session.token).digest('base64')
    }
    const own = await cookie(alice.id), foreign = await cookie(bob.id)
    await store.persistence.repositories.upsert(alice.id, 'github', '1',
      'test/repo', null, repo, '2026-11-01')
    const call = async (method: 'GET' | 'PUT' | 'POST', workspace = 'projects/demo',
      body?: unknown, session = own, origin = config.baseURL) => {
      const response = await onboardingRequest(auth, store,
        new Request(config.baseURL + '/api/onboarding?' +
          new URLSearchParams({repositoryId: repo, workspace}), {
          method, headers: {cookie: session, origin},
          ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}),
        }), config.baseURL)
      return { status: response.status, body: await response.json() as any }
    }
    assert.equal((await call('GET', '', undefined, '')).status, 401)
    const denied = await call('GET', '', undefined, foreign)
    assert.equal(denied.status, 404, JSON.stringify(denied.body))
    assert.equal((await call('PUT', '', {revision: 0, draft: blankOnboardingDraft()}, own, 'https://evil.test')).status, 403)
    assert.equal((await call('GET', '.story-inbox')).status, 400)
    assert.equal((await call('GET', '../outside')).status, 400)
    assert.equal((await call('GET', 'projects/demo/story')).body.target, 'projects/demo/story')
    assert.equal((await call('GET', 'story')).body.target, 'story')
    const opened = await call('GET')
    assert.equal(opened.status, 200)
    assert.equal(opened.body.revision, 0)
    assert.equal(opened.body.target, 'projects/demo/story')
    const round1 = { ...opened.body.draft,
      title: 'The Last Bell', premise: 'A bell disappears', central_conflict: 'The town hides the truth',
    }
    assert.throws(() => reviewedOnboarding(round1), /Answer all discovery/)
    const save = await call('PUT', 'projects/demo', { revision: 0, draft: round1 })
    assert.equal(save.status, 200)
    assert.equal(save.body.revision, 1)
    assert.equal((await call('POST', 'projects/demo', {revision: 1})).status, 422)
    assert.equal((await call('POST', 'projects/demo', {revision: 1}, foreign)).status, 404)
    assert.equal((await call('POST', 'projects/demo', {revision: 1}, own, 'https://evil.test')).status, 403)
    assert.equal((await call('PUT', 'projects/demo', { revision: 0, draft: round1 })).status, 409)
    assert.equal((await call('PUT', 'projects/demo', { revision: 1,
      draft: { ...round1, extra: 'unauthorized' } })).status, 422)
    const round2 = { ...round1, genre: 'Mystery', tone: 'Somber',
      player_experience: 'Investigate two competing accounts', scope: 'One town' }
    assert.equal((await call('PUT', 'projects/demo', {revision: 1, draft: round2})).status, 200)
    store.close()
    store = openStudioDatabase(file)
    const restarted = createStudioAuth(store, config)
    const reopened = await onboardingRequest(restarted, store,
      new Request(config.baseURL + '/api/onboarding?' +
        new URLSearchParams({ repositoryId: repo, workspace: 'projects/demo' }),
        { headers: { cookie: own } }), config.baseURL)
    assert.equal(reopened.status, 200)
    const persisted = await reopened.json() as any
    assert.equal(persisted.revision, 2)
    assert.equal(persisted.draft.player_experience, round2.player_experience)
    const completed = { ...round2, decision: 'The town cannot hide all evidence',
      body: 'The bell signals a moral choice.', task: 'Build a branching mystery',
      constraints: 'Two player outcomes\nNo forced ending' }
    const final = await onboardingRequest(restarted, store,
      new Request(config.baseURL + '/api/onboarding?' +
        new URLSearchParams({repositoryId: repo, workspace: 'projects/demo'}), {
        method: 'PUT', headers: {cookie: own, origin: config.baseURL},
        body: JSON.stringify({ revision: 2, draft: completed }),
      }), config.baseURL)
    assert.equal(final.status, 200)
    const approval = await onboardingRequest(restarted, store,
      new Request(config.baseURL + '/api/onboarding?' +
        new URLSearchParams({repositoryId: repo, workspace: 'projects/demo'}), {
        method: 'POST', headers: {cookie: own, origin: config.baseURL},
        body: JSON.stringify({ revision: 3 }),
      }), config.baseURL)
    assert.equal(approval.status, 200)
    const approved = await approval.json() as any
    assert.equal(approved.target, 'projects/demo/story')
    assert.equal(approved.task, completed.task)
    assert.equal(approved.foundation.decision, completed.decision)
    assert.equal(approved.foundation.constraints, undefined)
    const proposal = reviewedOnboarding(completed)
    assert.equal(proposal.foundation.decision, completed.decision)
    assert.equal(proposal.task, completed.task)
    assert.deepEqual(proposal.contract.scope, {
      kind: 'full-story', depth: 'composition', targets: [], branches: [],
    })
    assert.deepEqual(proposal.contract.constraints, ['Two player outcomes', 'No forced ending'])
    assert.equal((await store.persistence.dashboard.forOwner(alice.id)).stories.length, 0,
      'Saving discovery does not write Git or silently register a Story')
  } finally { store.close(); rmSync(root, {recursive: true, force: true}) }
})
