import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { openKyselyFeatureFixture } from './support/studio-database'

const at = '2026-11-09T12:00:00Z'
const sha = 'a'.repeat(40)
const digest = 'b'.repeat(64)
const pg = process.env.NT_TEST_PG_URL
if (process.env.NT_REQUIRE_KYSELY_PROOF === '1' && !pg)
  throw new Error('NT_TEST_PG_URL required for mandatory Git conformance on both databases')

for (const backend of ['sqlite', 'postgres'] as const) {
  test(
    `${backend}: shared Git, repository, onboarding and credential contracts`,
    {
      skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL for PostgreSQL conformance',
      timeout: 120_000,
    },
    async (t) => {
      const fixture = await openKyselyFeatureFixture(backend)
      t.after(() => fixture.close())
      const { git, repositories: repos, onboarding, piCredentials: vault, records: data } = fixture
      const alice = await fixture.owner()
      const bob = await fixture.owner()
      const aliceConnection = randomUUID(),
        otherConnection = randomUUID()
      const bobConnection = randomUUID(),
        gitlabConnection = randomUUID()
      const repositoryId = randomUUID(),
        bobRepositoryId = randomUUID(),
        otherRepository = randomUUID()
      const storyId = randomUUID(),
        jobId = randomUUID()
      const credentials = 'encrypted:opaque-bytes+not-a-plaintext-token'

      await t.test('identity, ownership, single-use OAuth and fenced refresh', async () => {
        await fixture.account(alice, 'github')
        await fixture.account(alice, 'gitlab')
        await fixture.account(bob, 'github')
        assert.equal((await git.legacyAccounts(alice, 'github')).length, 1)
        assert.equal((await git.legacyAccounts(bob, 'github')).length, 1)
        assert.deepEqual(await git.legacyAccounts(alice, 'gitlab').then((items) => items.length), 1)
        await assert.rejects(git.list(''), /Authenticated actor/)

        await git.startFlow(alice, 'github', 'flow-1', 'pkce-verifier', 1000, 500)
        assert.equal(await git.consumeFlow('flow-1', 'gitlab', 501), null)
        assert.deepEqual(await git.consumeFlow('flow-1', 'github', 501), {
          owner: alice,
          verifier: 'pkce-verifier',
        })
        assert.equal(await git.consumeFlow('flow-1', 'github', 501), null)
        await git.startFlow(alice, 'github', 'flow-expired', 'secret', 1000, 500)
        assert.equal(await git.consumeFlow('flow-expired', 'github', 1001), null)

        const connection = {
          owner: alice,
          provider: 'github' as const,
          providerAccountId: 'provider-42',
          login: 'alice',
          credentials,
          accessExpiresAt: 100,
          refreshExpiresAt: 1500,
          now: at,
        }
        await git.connect({ ...connection, id: aliceConnection })
        await git.connect({ ...connection, id: otherConnection, providerAccountId: 'provider-43' })
        await git.connect({
          ...connection,
          id: gitlabConnection,
          provider: 'gitlab',
          providerAccountId: 'provider-42',
        })
        await git.connect({ ...connection, id: bobConnection, owner: bob, login: 'bob' })
        assert.equal(await git.hasActive(alice, 'github'), true)
        assert.equal(await git.hasActive(alice, 'gitlab'), true)
        assert.equal(await git.read(bob, aliceConnection), null)
        assert.equal(await git.read(alice, bobConnection), null)
        assert.equal((await git.list(alice)).length, 3)
        assert.equal((await git.read(alice, aliceConnection))?.credentials, credentials)

        assert.equal(await git.acquireRefreshLease(bob, aliceConnection, 1, 'stolen', 600, 500), false)
        assert.equal(await git.acquireRefreshLease(alice, aliceConnection, 1, 'lease-1', 600, 500), true)
        assert.equal(await git.acquireRefreshLease(alice, aliceConnection, 1, 'lease-2', 700, 500), false)
        assert.equal(
          await git.finishRefresh(alice, aliceConnection, 1, 'wrong', {
            credentials: 'tampered',
            accessExpiresAt: 1000,
            refreshExpiresAt: null,
            now: at,
          }),
          false,
        )
        await git.requireReauthorization(alice, aliceConnection, 1, 'wrong')
        assert.equal((await git.read(alice, aliceConnection))?.status, 'connected')
        assert.equal(
          await git.finishRefresh(alice, aliceConnection, 1, 'lease-1', {
            credentials: 'encrypted:rotated',
            accessExpiresAt: 1200,
            refreshExpiresAt: 1800,
            now: at,
          }),
          true,
        )
        assert.equal(
          await git.finishRefresh(alice, aliceConnection, 1, 'lease-1', {
            credentials: 'stale',
            accessExpiresAt: null,
            refreshExpiresAt: null,
            now: at,
          }),
          false,
        )
        await git.failRefresh(alice, aliceConnection, 'lease-1')
        await git.requireReauthorization(alice, aliceConnection, 1)
        assert.equal((await git.read(alice, aliceConnection))?.status, 'connected')
        assert.equal((await git.read(alice, aliceConnection))?.revision, 2)
        assert.equal((await git.read(alice, aliceConnection))?.credentials, 'encrypted:rotated')
        assert.equal(await git.acquireRefreshLease(alice, aliceConnection, 2, 'new-lease', 650, 500), true)
        assert.equal(
          await git.acquireRefreshLease(alice, aliceConnection, 2, 'later', 700, 650),
          false,
          'lease expiry is strict, not inclusive',
        )
        assert.equal(await git.acquireRefreshLease(alice, aliceConnection, 2, 'later', 700, 651), true)
        await git.failRefresh(alice, aliceConnection, 'new-lease')
        assert.equal((await git.read(alice, aliceConnection))?.status, 'connected')
        await git.failRefresh(alice, aliceConnection, 'later')
        assert.equal((await git.read(alice, aliceConnection))?.status, 'reauthorize')
        await git.connect({ ...connection, id: randomUUID(), credentials: 'encrypted:reconnected' })
        const reconnected = await git.read(alice, aliceConnection)
        assert.equal(reconnected?.id, aliceConnection, 'provider identity keeps stable ID')
        assert.equal(reconnected?.revision, 3)
        assert.equal(reconnected?.status, 'connected')
        assert.equal(reconnected?.credentials, 'encrypted:reconnected')
        assert.equal(reconnected?.refreshLeaseId, null)
        assert.equal(await git.disconnect(bob, aliceConnection, at), false)
        assert.equal(await git.disconnect(alice, aliceConnection, at), true)
        assert.equal((await git.read(alice, aliceConnection))?.credentials, '')
        assert.equal((await git.read(alice, aliceConnection))?.refreshExpiresAt, null)
        assert.equal(await git.acquireRefreshLease(alice, aliceConnection, 4, 'blocked', 1000, 500), false)
        assert.equal((await git.read(bob, bobConnection))?.credentials, credentials)
        await git.connect({ ...connection, id: randomUUID() })
        assert.equal((await git.read(alice, aliceConnection))?.revision, 5)
      })

      await t.test('binding integrity, verified rebind, installation states and onboarding CAS', async () => {
        const original = await repos.upsert(
          alice,
          'github',
          'repo-88',
          'Alice/Story',
          aliceConnection,
          repositoryId,
          at,
        )
        const renamed = await repos.upsert(
          alice,
          'github',
          'repo-88',
          'Alice/Renamed',
          otherConnection,
          randomUUID(),
          at,
        )
        assert.equal(renamed.id, original.id)
        assert.equal(renamed.connectionId, aliceConnection, 'discovery never silently rebinds')
        assert.equal(renamed.name, 'Alice/Renamed')
        assert.equal(await repos.get(bob, original.id), null)
        assert.equal(await repos.get(alice, original.id, 'gitlab'), null)
        assert.equal(await repos.rebind(alice, renamed, bobConnection), false)
        assert.equal(await repos.rebind(alice, renamed, gitlabConnection), false)
        assert.equal(await repos.rebind(bob, renamed, bobConnection), false)
        assert.equal(await repos.rebind(alice, { ...renamed, name: 'stale' }, otherConnection), false)
        assert.equal(await repos.rebind(alice, renamed, otherConnection), true)
        assert.equal((await repos.get(alice, repositoryId))?.connectionId, otherConnection)
        assert.equal(await repos.rebind(alice, { ...renamed, connectionId: otherConnection }, null), true)
        assert.equal((await repos.get(alice, repositoryId))?.connectionId, null)
        await fixture.account(alice, 'github')
        assert.equal(await repos.rebind(alice, renamed, null), false, 'ambiguous login cannot bind')
        await assert.rejects(
          repos.upsert(alice, 'github', 'alien', 'Other/Story', bobConnection, randomUUID(), at),
          /owner-scoped/,
        )
        await assert.rejects(
          repos.upsert(alice, 'github', 'alien', 'Other/Story', gitlabConnection, randomUUID(), at),
          /owner-scoped/,
        )
        assert.equal((await repos.identities(alice)).length, 1)
        await repos.upsert(bob, 'github', 'repo-88', 'Bob/Story', bobConnection, bobRepositoryId, at)
        await repos.upsert(alice, 'gitlab', 'repo-88', 'Alice/GL', gitlabConnection, otherRepository, at)
        assert.equal((await repos.identities(alice)).length, 2, 'identity includes provider and owner')
        await assert.rejects(
          data.insert('repositories', {
            id: randomUUID(),
            ownerUserId: bob,
            provider: 'github',
            providerRepositoryId: 'forged',
            name: 'Forged',
            connectionId: otherConnection,
            createdAt: at,
          }),
          /foreign key|constraint|owner\/provider mismatch/i,
        )
        await assert.rejects(
          data.insert('repositories', {
            id: randomUUID(),
            ownerUserId: alice,
            provider: 'gitlab',
            providerRepositoryId: 'forged-provider',
            name: 'Forged Provider',
            connectionId: otherConnection,
            createdAt: at,
          }),
          /foreign key|constraint/i,
        )
        assert.equal(await repos.rebind(alice, { ...renamed, connectionId: null }, otherConnection), true)
        await assert.rejects(
          data.update('git_connections', { id: otherConnection }, { provider: 'gitlab' }),
          /foreign key|constraint/i,
        )
        await assert.rejects(
          data.update('repositories', { id: repositoryId }, { provider: 'gitlab' }),
          /foreign key|constraint/i,
        )
        await assert.rejects(
          data.insert('git_connections', {
            id: randomUUID(),
            ownerUserId: alice,
            provider: 'github',
            providerAccountId: 'provider-43',
            login: 'duplicate',
            credentials: 'sealed',
            createdAt: at,
            updatedAt: at,
          }),
          /unique|constraint|duplicate/i,
        )

        await assert.rejects(
          repos.beginInstall(
            {
              stateHash: 'foreign-install',
              owner: bob,
              desired: null,
              connectionId: otherConnection,
              createdAt: 500,
              expiresAt: 1000,
            },
            500,
          ),
          /foreign key|constraint/i,
        )
        await assert.rejects(
          repos.beginInstall(
            {
              stateHash: 'wrong-provider-install',
              owner: alice,
              desired: null,
              connectionId: gitlabConnection,
              createdAt: 500,
              expiresAt: 1000,
            },
            500,
          ),
          /foreign key|constraint/i,
        )
        await repos.beginInstall(
          {
            stateHash: 'install-hash',
            owner: alice,
            desired: 'Alice/Story',
            connectionId: otherConnection,
            createdAt: 500,
            expiresAt: 1000,
          },
          500,
        )
        await assert.rejects(
          data.update('github_install_flows', { stateHash: 'install-hash' }, { ownerUserId: bob }),
          /foreign key|constraint/i,
        )
        assert.equal(await repos.consumeInstall(bob, 'install-hash', 501), null)
        assert.deepEqual(await repos.consumeInstall(alice, 'install-hash', 501), {
          desired: 'Alice/Story',
          connectionId: otherConnection,
        })
        assert.equal(await repos.consumeInstall(alice, 'install-hash', 501), null)
        await repos.deferInstall(bob, 'install-hash', 2000)
        assert.deepEqual(await repos.pendingInstallNames(alice, 1500), [])
        await repos.deferInstall(alice, 'install-hash', 2000)
        assert.deepEqual(await repos.pendingInstallNames(alice, 1500), ['Alice/Story'])
        await repos.clearPendingInstall(bob, 'alice/story')
        assert.deepEqual(await repos.pendingInstallNames(alice, 1500), ['Alice/Story'])
        await repos.clearPendingInstall(alice, 'alice/story')
        assert.deepEqual(await repos.pendingInstallNames(alice, 1500), [])

        assert.equal(
          await onboarding.saveDraft(alice, repositoryId, 'story', 0, '{"title":"first"}', at),
          true,
        )
        assert.equal(
          await onboarding.saveDraft(alice, repositoryId, 'story', 0, '{"title":"stale"}', at),
          false,
        )
        assert.equal(
          await onboarding.saveDraft(alice, repositoryId, 'story', 1, '{"title":"second"}', at),
          true,
        )
        assert.deepEqual(await onboarding.draft(alice, repositoryId, 'story'), {
          revision: 2,
          draftJson: '{"title":"second"}',
        })
        assert.equal(await onboarding.draft(bob, repositoryId, 'story'), null)
        await assert.rejects(
          onboarding.saveDraft(bob, repositoryId, 'story', 0, '{}', at),
          /foreign key|constraint/i,
        )
        assert.equal(await onboarding.saveConversation(alice, repositoryId, 'story', 1, '{}', null, at), true)
        assert.equal(
          await onboarding.saveConversation(alice, repositoryId, 'story', 1, '{}', null, at),
          false,
        )
        assert.equal(
          await onboarding.saveConversation(alice, repositoryId, 'story', 2, '{"ok":true}', 1, at),
          true,
        )
        assert.equal(await onboarding.saveConversation(alice, repositoryId, 'story', 3, '{}', 1, at), false)
        assert.deepEqual(await onboarding.conversation(alice, repositoryId, 'story'), {
          revision: 2,
          state: '{"ok":true}',
        })
        assert.equal(await onboarding.conversation(bob, repositoryId, 'story'), null)
      })

      await t.test(
        'Story registration is atomic; import preserves identity and original digest',
        async () => {
          const story = {
            id: storyId,
            owner: alice,
            repositoryId,
            directory: 'path/story',
            title: 'First',
            createdAt: at,
            commitSha: sha,
            contentSha256: digest,
          }
          await onboarding.commitGithubInitialization(story, jobId)
          await onboarding.commitGithubInitialization(story, jobId)
          assert.deepEqual(await onboarding.initializationJob(jobId), {
            ownerId: alice,
            storyId,
            commitSha: sha,
          })
          assert.deepEqual(await onboarding.githubInitialization(alice, repositoryId, 'path/story'), {
            storyId, jobId, title: 'First', baseSha: sha, configured: false,
          })
          assert.equal(await onboarding.githubInitialization(bob, repositoryId, 'path/story'), null)
          assert.equal(await onboarding.githubInitialization(alice, repositoryId, 'other/story'), null)
          assert.equal(await repos.repositoryForStory(alice, storyId, 'github'), repositoryId)
          assert.equal(await repos.repositoryForStory(bob, storyId, 'github'), null)
          assert.equal(await repos.repositoryForStory(alice, storyId, 'gitlab'), null)
          assert.equal((await onboarding.story(alice, repositoryId, 'path/story'))?.contentSha256, digest)
          await assert.rejects(
            onboarding.commitGithubInitialization(
              {
                ...story,
                id: randomUUID(),
                directory: 'second/path',
              },
              jobId,
            ),
            /Initialization job identity/,
          )
          assert.equal(
            await onboarding.story(alice, repositoryId, 'second/path'),
            null,
            'conflicting job rolls back newly inserted Story',
          )
          const updated = await onboarding.importStory({
            ...story,
            id: randomUUID(),
            title: 'Updated',
            commitSha: 'f'.repeat(40),
          })
          assert.equal(updated.id, storyId)
          assert.equal(updated.title, 'Updated')
          assert.equal(updated.commitSha, 'f'.repeat(40))
          await onboarding.importStory({ ...story, contentSha256: 'c'.repeat(64) })
          assert.equal((await onboarding.story(alice, repositoryId, 'path/story'))?.contentSha256, digest)
          await assert.rejects(
            onboarding.importStory({ ...story, id: randomUUID(), owner: bob }),
            /foreign key|another owner|constraint/i,
          )
          await assert.rejects(onboarding.createStory({ ...story, id: randomUUID() }), /unique|constraint/i)
          const glStory = { ...story, id: randomUUID(), repositoryId: otherRepository, directory: 'gl/path' }
          assert.equal((await onboarding.createStory(glStory)).id, glStory.id)
          assert.equal((await onboarding.story(alice, otherRepository, 'gl/path'))?.contentSha256, null)
        },
      )

      await t.test(
        'encrypted credential CAS, multi-user isolation, retries and database reopen',
        async () => {
          assert.equal(await vault.compareAndSwap(alice, 'openai', credentials, null), true)
          assert.equal(await vault.compareAndSwap(alice, 'openai', 'duplicate', null), false)
          assert.equal(await vault.compareAndSwap(alice, 'openai', 'stale', 2), false)
          assert.equal(await vault.compareAndSwap(alice, 'openai', 'encrypted:new', 1), true)
          assert.equal((await vault.read(alice, 'openai'))?.revision, 2)
          assert.equal((await vault.read(alice, 'openai'))?.ciphertext, 'encrypted:new')
          assert.equal(await vault.read(bob, 'openai'), null)
          assert.deepEqual(
            (await vault.list(alice)).map((row) => row.provider),
            ['openai'],
          )
          await vault.delete(bob, 'openai')
          assert.equal((await vault.read(alice, 'openai'))?.ciphertext, 'encrypted:new')
          assert.deepEqual(
            await Promise.all([
              vault.compareAndSwap(alice, 'openai', 'raced-first', 2),
              vault.compareAndSwap(alice, 'openai', 'raced-second', 2),
            ]).then((items) => items.filter(Boolean).length),
            1,
            'one CAS winner despite race',
          )
          const after = await fixture.reopenGit()
          assert.equal((await after.git.read(alice, aliceConnection))?.revision, 5)
          assert.equal((await after.repositories.get(alice, repositoryId))?.name, 'Alice/Renamed')
          assert.equal(
            (await after.onboarding.story(alice, repositoryId, 'path/story'))?.contentSha256,
            digest,
          )
          assert.equal((await after.onboarding.initializationJob(jobId))?.storyId, storyId)
          assert.equal((await after.onboarding.githubInitialization(alice, repositoryId, 'path/story'))?.jobId, jobId)
          assert.equal((await after.piCredentials.read(alice, 'openai'))?.revision, 3)
          assert.equal(await after.piCredentials.read(bob, 'openai'), null)
          await after.piCredentials.delete(alice, 'openai')
          assert.equal(await after.piCredentials.read(alice, 'openai'), null)

          // The native composite FK must coexist with the legacy nullable
          // connection FK's SET NULL action, preserving owner/provider fields.
          await after.repositories.beginInstall(
            {
              stateHash: 'delete-cascade-install',
              owner: alice,
              desired: null,
              connectionId: otherConnection,
              createdAt: 501,
              expiresAt: 1200,
            },
            501,
          )
          await assert.rejects(
            data.insert('github_install_flows', {
              stateHash: 'invalid-provider-install',
              ownerUserId: alice,
              provider: 'gitlab',
              connectionId: otherConnection,
              createdAt: 501,
              expiresAt: 1200,
              status: 'started',
            }),
            /check|constraint/i,
          )
          assert.equal(await data.delete('git_connections', { id: otherConnection }), 1)
          const unbound = await after.repositories.get(alice, repositoryId)
          assert.equal(unbound?.connectionId, null)
          assert.equal(unbound?.provider, 'github')
          const flow = await data.first<{
            connectionId: string | null
            ownerUserId: string
            provider: string
          }>('github_install_flows', { stateHash: 'delete-cascade-install' })
          assert.equal(flow?.connectionId, null)
          assert.equal(flow?.ownerUserId, alice)
          assert.equal(flow?.provider, 'github')

          // Epoch milliseconds exceed PostgreSQL int4. Exercise the real
          // shared Git ports on both drivers, including bigint readback,
          // compare/lease predicates, installation timestamps and reconnect.
          const nowMs = 1_800_000_000_000
          const expires = nowMs + 3_600_000
          await after.git.startFlow(alice, 'github', 'epoch-flow', 'pkce-epoch', expires, nowMs)
          assert.deepEqual(await after.git.consumeFlow('epoch-flow', 'github', nowMs + 100), {
            owner: alice, verifier: 'pkce-epoch',
          })
          const epochConnectionId = randomUUID()
          await after.git.connect({
            id: epochConnectionId, owner: alice, provider: 'github',
            providerAccountId: 'epoch-provider', login: 'epoch-login',
            credentials: 'encrypted:epoch', accessExpiresAt: expires,
            refreshExpiresAt: expires + 60_000, now: at,
          })
          assert.equal((await after.git.read(alice, epochConnectionId))?.accessExpiresAt, expires)
          assert.equal((await after.git.read(alice, epochConnectionId))?.refreshExpiresAt, expires + 60_000)
          assert.equal((await after.git.list(alice)).find(row =>
            row.id === epochConnectionId)?.accessExpiresAt, expires)
          assert.equal(await after.git.acquireRefreshLease(alice, epochConnectionId, 1,
            'epoch-lease', nowMs + 10_000, nowMs), true)
          assert.equal((await after.git.read(alice, epochConnectionId))?.refreshLeaseUntil, nowMs + 10_000)
          assert.equal(await after.git.acquireRefreshLease(alice, epochConnectionId, 1,
            'another-lease', nowMs + 20_000, nowMs + 9_999), false)
          await after.repositories.beginInstall({
            stateHash: 'epoch-install', owner: alice, desired: 'epoch/story',
            connectionId: epochConnectionId, createdAt: nowMs, expiresAt: expires,
          }, nowMs)
          assert.deepEqual(await after.repositories.consumeInstall(alice, 'epoch-install', nowMs + 1),
            { desired: 'epoch/story', connectionId: epochConnectionId })
          await after.repositories.deferInstall(alice, 'epoch-install', expires + 60_000)
          assert.ok((await after.repositories.pendingInstallNames(alice, nowMs + 2))
            .includes('epoch/story'))
        },
      )
    },
  )
}
