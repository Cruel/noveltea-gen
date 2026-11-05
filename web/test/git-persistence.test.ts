import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { listGitConnections } from '../src/lib/git-connections.server'
import { selectGitConnection, repositoryForStory } from '../src/lib/access.server'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'git-persistence-integration-tests-0123456789abcdefghijklmnopqrstuvwxyz',
  github: { clientId: 'test-gh', clientSecret: 'secret-gh' },
  gitlab: { clientId: 'test-gl', clientSecret: 'secret-gl' },
}
const now = '2026-11-05T00:00:00Z'

async function fixture() {
  const store = openStudioDatabase(':memory:')
  await migrateStudio(store, config)
  const ctx = await createStudioAuth(store, config).$context
  const alice = (await ctx.internalAdapter.createUser({
    name: 'Alice', email: 'alice@git-ports.test', emailVerified: true,
  }, { method: 'test' })).id
  const bob = (await ctx.internalAdapter.createUser({
    name: 'Bob', email: 'bob@git-ports.test', emailVerified: true,
  }, { method: 'test' })).id
  return { store, alice, bob }
}

test('Git connection identity is owner- and provider-scoped; reconnect keeps identity and bumps revision', async () => {
  const { store, alice, bob } = await fixture()
  try {
    const git = store.persistence.git
    const connection = {
      id: 'conn-a', provider: 'github' as const, providerAccountId: '222', login: 'alice',
      credentials: 'sealed-secret-a', accessExpiresAt: null, refreshExpiresAt: null, now,
    }
    await git.connect({ ...connection, owner: alice })
    await git.connect({ ...connection, id: 'conn-b', owner: bob, login: 'bob', credentials: 'sealed-secret-b' })
    assert.equal((await git.read(alice, 'conn-b')), null)
    assert.equal((await git.read(bob, 'conn-a')), null)
    assert.deepEqual((await git.list(alice)).map(item => item.id), ['conn-a'])
    assert.equal(await git.hasActive(alice, 'github'), true)
    assert.equal(await git.hasActive(alice, 'gitlab'), false)
    await git.connect({ ...connection, id: 'would-replace-id', owner: alice, credentials: 'sealed-new' })
    const updated = await git.read(alice, 'conn-a')
    assert.equal(updated?.id, 'conn-a')
    assert.equal(updated?.revision, 2)
    assert.equal(updated?.credentials, 'sealed-new')
    assert.equal(await git.disconnect(bob, 'conn-a', now), false)
    assert.equal(await git.disconnect(alice, 'conn-a', now), true)
    assert.equal((await git.read(alice, 'conn-a'))?.credentials, '')
    assert.equal(await git.hasActive(alice, 'github'), false)
    await assert.rejects(git.list(''), /Authenticated actor/)
  } finally { store.close() }
})

test('repository import never changes an existing Git binding without verified rebinding', async () => {
  const { store, alice, bob } = await fixture()
  try {
    const { git, repositories: catalog, onboarding } = store.persistence
    const connect = async (id: string, owner: string, provider: 'github' | 'gitlab') =>
      git.connect({ id, owner, provider, providerAccountId: id, login: id,
        credentials: 'sealed', accessExpiresAt: null, refreshExpiresAt: null, now })
    await connect('conn-alice', alice, 'github')
    await connect('conn-other', alice, 'github')
    await connect('conn-gitlab', alice, 'gitlab')
    await connect('conn-bob', bob, 'github')
    const original = await catalog.upsert(alice, 'github', '101', 'alice/game',
      'conn-alice', 'repo-a', now)
    const repeat = await catalog.upsert(alice, 'github', '101', 'alice/renamed',
      'conn-other', 'unused-new-id', now)
    assert.equal(repeat.id, original.id)
    assert.equal(repeat.connectionId, 'conn-alice', 'import cannot silently switch Git credentials')
    assert.equal(repeat.name, 'alice/renamed')
    assert.equal(await catalog.get(bob, original.id), null)
    assert.equal(await catalog.get(alice, original.id, 'gitlab'), null)
    assert.equal(await catalog.rebind(bob, repeat, 'conn-bob'), false)
    assert.equal(await catalog.rebind(alice, repeat, 'conn-gitlab'), false)
    assert.equal(await catalog.rebind(alice, repeat, 'conn-bob'), false)
    await assert.rejects(catalog.upsert(alice, 'github', '999', 'alien/repo',
      'conn-bob', 'invalid-repo', now), /owner-scoped/)
    await assert.rejects(catalog.upsert(alice, 'github', '999', 'alien/repo',
      'conn-gitlab', 'invalid-repo', now), /owner-scoped/)
    assert.equal(await catalog.get(alice, 'invalid-repo'), null)
    assert.equal(await catalog.rebind(alice, { ...repeat, name: 'outdated' }, 'conn-other'), false)
    assert.equal(await catalog.rebind(alice, repeat, 'conn-other'), true)
    assert.equal((await catalog.get(alice, original.id))?.connectionId, 'conn-other')
    const foreign = await catalog.upsert(bob, 'github', '101', 'bob/game',
      'conn-bob', 'repo-b', now)
    assert.equal(foreign.id, 'repo-b', 'two Studio users may import the same provider repository ID')
    const differentProvider = await catalog.upsert(alice, 'gitlab', '101', 'alice/game',
      'conn-gitlab', 'repo-gl', now)
    assert.equal(differentProvider.id, 'repo-gl')
    assert.deepEqual((await catalog.identities(alice)).map(r => r.provider).sort(), ['github', 'gitlab'])
    const story = { id: 'story-a', owner: alice, repositoryId: original.id,
      directory: 'story', title: 'Story A', createdAt: now, commitSha: 'a'.repeat(40) }
    assert.equal((await onboarding.importStory(story)).id, 'story-a')
    const replay = await onboarding.importStory({ ...story, id: 'story-replay',
      title: 'Story updated', commitSha: 'b'.repeat(40) })
    assert.equal(replay.id, story.id)
    assert.equal(replay.title, 'Story updated')
    assert.equal(replay.commitSha, 'b'.repeat(40))
    assert.equal(await catalog.repositoryForStory(bob, story.id, 'github'), null)
    assert.equal(await catalog.repositoryForStory(alice, story.id, 'gitlab'), null)
    assert.equal(await catalog.repositoryForStory(alice, story.id, 'github'), original.id)
    await assert.rejects(onboarding.importStory({ ...story, id: 'foreign',
      owner: bob }), /FOREIGN KEY|another owner/)
    await assert.rejects(onboarding.createStory({ ...story, id: 'duplicate' }), /UNIQUE/)
  } finally { store.close() }
})

test('OAuth states, GitHub installation states, refresh leases, and Pi credentials enforce single-use/CAS', async () => {
  const { store, alice, bob } = await fixture()
  try {
    const { git, repositories: catalog, piCredentials: vault } = store.persistence
    await git.startFlow(alice, 'github', 'state-1', 'verifier', 1000, 500)
    assert.equal(await git.consumeFlow('state-1', 'gitlab', 500), null)
    assert.deepEqual(await git.consumeFlow('state-1', 'github', 500),
      { owner: alice, verifier: 'verifier' })
    assert.equal(await git.consumeFlow('state-1', 'github', 500), null)
    await git.startFlow(alice, 'github', 'expired', 'x', 1000, 500)
    assert.equal(await git.consumeFlow('expired', 'github', 1001), null)
    await catalog.beginInstall({ stateHash: 'install-hash', owner: alice,
      desired: 'Alice/Story', connectionId: null, createdAt: 500, expiresAt: 1000 }, 500)
    assert.equal(await catalog.consumeInstall(bob, 'install-hash', 501), null)
    assert.deepEqual(await catalog.consumeInstall(alice, 'install-hash', 501),
      { desired: 'Alice/Story', connectionId: null })
    assert.equal(await catalog.consumeInstall(alice, 'install-hash', 501), null)
    await catalog.deferInstall(bob, 'install-hash', 2000)
    assert.deepEqual(await catalog.pendingInstallNames(alice, 1500), [],
      'foreign owner cannot change the installation expiration')
    await catalog.deferInstall(alice, 'install-hash', 2000)
    assert.deepEqual(await catalog.pendingInstallNames(alice, 1500), ['Alice/Story'])
    await catalog.clearPendingInstall(bob, 'alice/story')
    assert.deepEqual(await catalog.pendingInstallNames(alice, 1500), ['Alice/Story'])
    await catalog.clearPendingInstall(alice, 'alice/story')
    assert.deepEqual(await catalog.pendingInstallNames(alice, 1500), [])
    await git.connect({ id: 'lease-conn', owner: alice, provider: 'github',
      providerAccountId: '333', login: 'lease', credentials: 'v1', now,
      accessExpiresAt: 100, refreshExpiresAt: 2000 })
    assert.equal(await git.acquireRefreshLease(bob, 'lease-conn', 1, 'steal', 600, 500), false)
    assert.equal(await git.acquireRefreshLease(alice, 'lease-conn', 1, 'lease-1', 600, 500), true)
    assert.equal(await git.acquireRefreshLease(alice, 'lease-conn', 1, 'lease-2', 650, 500), false)
    assert.equal(await git.finishRefresh(alice, 'lease-conn', 1, 'wrong', {
      credentials: 'stolen', accessExpiresAt: 1000, refreshExpiresAt: 2000, now,
    }), false)
    assert.equal(await git.finishRefresh(alice, 'lease-conn', 1, 'lease-1', {
      credentials: 'v2', accessExpiresAt: 1000, refreshExpiresAt: 2000, now,
    }), true)
    assert.equal(await git.finishRefresh(alice, 'lease-conn', 1, 'lease-1', {
      credentials: 'bad', accessExpiresAt: 1000, refreshExpiresAt: 2000, now,
    }), false)
    assert.equal((await git.read(alice, 'lease-conn'))?.revision, 2)
    assert.equal((await git.read(alice, 'lease-conn'))?.credentials, 'v2')
    await git.requireReauthorization(alice, 'lease-conn', 1)
    assert.equal((await git.read(alice, 'lease-conn'))?.status, 'connected',
      'stale revision cannot reauthorize a refreshed connection')
    await git.failRefresh(alice, 'lease-conn', 'lease-1')
    assert.equal((await git.read(alice, 'lease-conn'))?.status, 'connected',
      'stale lease cannot invalidate a refreshed connection')
    assert.equal(await vault.compareAndSwap(alice, 'openai', 'encrypted-a', null), true)
    assert.equal(await vault.compareAndSwap(alice, 'openai', 'encrypted-b', null), false)
    assert.equal(await vault.compareAndSwap(alice, 'openai', 'encrypted-b', 2), false)
    assert.equal(await vault.compareAndSwap(alice, 'openai', 'encrypted-b', 1), true)
    assert.equal((await vault.read(alice, 'openai'))?.ciphertext, 'encrypted-b')
    assert.equal((await vault.read(alice, 'openai'))?.revision, 2)
    assert.equal(await vault.read(bob, 'openai'), null)
    await vault.delete(bob, 'openai')
    assert.equal((await vault.read(alice, 'openai'))?.ciphertext, 'encrypted-b')
    await vault.delete(alice, 'openai')
    assert.equal(await vault.read(alice, 'openai'), null)
  } finally { store.close() }
})

test('Git and repository consumers respect injected async persistence ports instead of SQLite', async () => {
  const { store, alice } = await fixture()
  try {
    const originalGit = store.persistence.git
    const originalRepositories = store.persistence.repositories
    let requestedOwner: string | null = null
    store.persistence.git = {
      ...originalGit,
      async list(owner) {
        requestedOwner = owner
        return [{ id: 'injected-connection', provider: 'github',
          accountId: '123', login: 'mock-account', status: 'connected', accessExpiresAt: null }]
      },
      async read(owner, id) {
        assert.equal(owner, alice)
        return id === 'injected-connection' ? {
          id, owner, provider: 'github', providerAccountId: '123', login: 'mock-account',
          credentials: 'not-needed', status: 'connected', revision: 1,
          accessExpiresAt: null, refreshExpiresAt: null,
          refreshLeaseId: null, refreshLeaseUntil: null,
        } : null
      },
    }
    store.persistence.repositories = {
      ...originalRepositories,
      async repositoryForStory(owner, id, provider) {
        assert.equal(owner, alice)
        assert.equal(id, 'injected-story')
        assert.equal(provider, 'github')
        return 'injected-repository'
      },
    }
    assert.deepEqual((await listGitConnections(store, alice)).map(item => item.login), ['mock-account'])
    assert.equal(requestedOwner, alice)
    assert.equal(await selectGitConnection(store, alice, 'github'), 'injected-connection')
    assert.equal(await selectGitConnection(store, alice, 'github', 'injected-connection'),
      'injected-connection')
    assert.equal(await repositoryForStory(store, alice, 'injected-story', 'github'),
      'injected-repository')
    assert.equal(await repositoryForStory(store, alice, null, 'github'), undefined)
  } finally { store.close() }
})

test('onboarding revisions conflict safely and GitHub Story registration is all-or-nothing', async () => {
  const { store, alice, bob } = await fixture()
  try {
    const catalog = store.persistence.repositories
    const onboard = store.persistence.onboarding
    const repo = await catalog.upsert(alice, 'github', '300', 'alice/game', null, 'repo-a', now)
    assert.equal(await onboard.saveDraft(alice, repo.id, 'story', 0, '{"title":"First"}', now), true)
    assert.equal(await onboard.saveDraft(alice, repo.id, 'story', 0, '{"title":"Stale"}', now), false)
    assert.deepEqual(await onboard.draft(alice, repo.id, 'story'),
      { revision: 1, draftJson: '{"title":"First"}' })
    assert.equal(await onboard.saveDraft(alice, repo.id, 'story', 1, '{"title":"Second"}', now), true)
    assert.equal(await onboard.draft(bob, repo.id, 'story'), null)
    assert.equal(await onboard.saveConversation(alice, repo.id, 'story', 1, '{"phase":"start"}', null, now), true)
    assert.equal(await onboard.saveConversation(alice, repo.id, 'story', 1, '{"phase":"race"}', null, now), false)
    assert.equal(await onboard.saveConversation(alice, repo.id, 'story', 2, '{"phase":"good"}', 1, now), true)
    assert.equal(await onboard.saveConversation(alice, repo.id, 'story', 3, '{"phase":"stale"}', 1, now), false)
    assert.deepEqual(await onboard.conversation(alice, repo.id, 'story'),
      { revision: 2, state: '{"phase":"good"}' })
    assert.equal(await onboard.conversation(bob, repo.id, 'story'), null)
    await assert.rejects(onboard.saveDraft(bob, repo.id, 'story', 0, '{}', now), /FOREIGN KEY/)
    const story = { id: 'story-one', owner: alice, repositoryId: repo.id,
      directory: 'first/story', title: 'First Story', createdAt: now,
      commitSha: 'a'.repeat(40), contentSha256: 'b'.repeat(64) }
    await onboard.commitGithubInitialization(story, 'job-one')
    await onboard.commitGithubInitialization(story, 'job-one')
    assert.equal((await onboard.story(alice, repo.id, story.directory))?.contentSha256, story.contentSha256)
    assert.deepEqual(await onboard.initializationJob('job-one'),
      { storyId: 'story-one', ownerId: alice, commitSha: story.commitSha })
    const other = { ...story, id: 'story-two', directory: 'second/story' }
    await assert.rejects(onboard.commitGithubInitialization(other, 'job-one'),
      /Initialization job|conflict|UNIQUE/)
    assert.equal(await onboard.story(alice, repo.id, other.directory), null,
      'failed registration must not leave an orphan Story')
    assert.equal(await onboard.story(bob, repo.id, story.directory), null)
  } finally { store.close() }
})
