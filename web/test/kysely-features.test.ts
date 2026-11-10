import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { openKyselyFeatureFixture } from './support/studio-database'
import { PublicationStateConflict } from '../src/persistence/publication-contracts'
import type { PublicationReceipt } from '../src/persistence/publication-contracts'

const at = '2026-11-09T12:00:00Z'
const nextAt = '2026-11-09T13:00:00Z'
const sha = 'a'.repeat(40)
const newerSha = 'b'.repeat(40)
const pg = process.env.NT_TEST_PG_URL
if (process.env.NT_REQUIRE_KYSELY_PROOF === '1' && !pg)
  throw new Error('NT_TEST_PG_URL required for mandatory cross-backend feature conformance')

for (const backend of ['sqlite', 'postgres'] as const) {
  test(
    `${backend}: shared Kysely Collection and Git publication contracts`,
    {
      skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL for PostgreSQL conformance',
      timeout: 90_000,
    },
    async (t) => {
      const fixture = await openKyselyFeatureFixture(backend)
      t.after(async () => fixture.close())
      const { records: data, collections, publications } = fixture
      const alice = await fixture.owner()
      const bob = await fixture.owner()
      const repo = randomUUID(),
        gitlabRepo = randomUUID(),
        bobRepo = randomUUID()
      const story = randomUUID(),
        elsewhere = randomUUID(),
        bobStory = randomUUID()
      const selectionStory = randomUUID()
      const root = randomUUID(),
        child = randomUUID(),
        otherThread = randomUUID()
      const deleted = randomUUID(),
        bobThread = randomUUID()
      const githubJob = randomUUID(),
        gitlabJob = randomUUID(),
        bobJob = randomUUID()
      for (const [id, ownerUserId, provider] of [
        [repo, alice, 'github'],
        [gitlabRepo, alice, 'gitlab'],
        [bobRepo, bob, 'github'],
      ]) {
        await data.insert('repositories', {
          id,
          ownerUserId,
          provider,
          providerRepositoryId: id,
          name: 'Owner/' + id,
          createdAt: at,
        })
      }
      for (const [id, ownerUserId, repositoryId] of [
        [story, alice, repo],
        [elsewhere, alice, gitlabRepo],
        [bobStory, bob, bobRepo],
        [selectionStory, alice, repo],
      ]) {
        await data.insert('stories', {
          id,
          ownerUserId,
          repositoryId,
          directory: id,
          title: id,
          sourceCommitSha: sha,
          initialContentSha256: 'e'.repeat(64),
          createdAt: at,
        })
      }
      for (const [id, ownerUserId, storyId, parentThreadId, deletedAt] of [
        [root, alice, story, null, null],
        [child, alice, story, root, null],
        [otherThread, alice, elsewhere, null, null],
        [deleted, alice, story, null, at],
        [bobThread, bob, bobStory, null, null],
      ]) {
        await data.insert('story_threads', {
          id,
          ownerUserId,
          storyId,
          parentThreadId,
          deletedAt,
          title: id,
          createdAt: at,
          activityAt: at,
        })
      }
      for (const [id, ownerUserId, storyId] of [
        [githubJob, alice, story],
        [gitlabJob, alice, elsewhere],
        [bobJob, bob, bobStory],
      ]) {
        await data.insert('studio_sessions', {
          id,
          ownerUserId,
          storyId,
          title: id,
          status: 'completed',
          sourceCommitSha: sha,
          createdAt: at,
          updatedAt: at,
        })
      }

      await t.test('Collections preserve scope, membership moves, selection, and cascade', async () => {
        assert.deepEqual(await collections.list(alice, story), [])
        assert.equal(await collections.selectedStory(alice), null)
        assert.equal(await collections.selectedStory(bob), null)
        await assert.rejects(collections.list(bob, story), /Story not found/)
        await assert.rejects(collections.create(bob, story, randomUUID(), 'Foreign', at), /Story not found/)
        await assert.rejects(collections.create('', story, randomUUID(), 'Missing', at), /actor/)
        const research = randomUUID(),
          drafts = randomUUID(),
          elsewhereCollection = randomUUID()
        assert.deepEqual(await collections.create(alice, story, research, 'Research', at), {
          id: research,
          storyId: story,
          name: 'Research',
          createdAt: at,
          updatedAt: at,
        })
        await collections.create(alice, story, drafts, 'Drafts', at)
        await collections.create(alice, elsewhere, elsewhereCollection, 'Elsewhere', at)
        assert.deepEqual(
          (await collections.list(alice, story)).map((x) => x.name),
          ['Drafts', 'Research'],
        )
        assert.equal(await collections.rename(bob, story, research, 'Stolen', nextAt), false)
        assert.equal(await collections.rename(alice, elsewhere, research, 'Stolen', nextAt), false)
        assert.equal(await collections.rename(alice, story, drafts, 'Writing', nextAt), true)
        assert.deepEqual(
          (await collections.list(alice, story)).map((x) => x.name),
          ['Research', 'Writing'],
        )
        await assert.rejects(
          collections.rename(alice, story, drafts, 'Research', nextAt),
          /unique|constraint|duplicate/i,
        )
        assert.equal(await collections.assign(alice, story, root, research), true)
        assert.equal(
          await collections.assign(alice, story, root, research),
          true,
          'duplicate submit is idempotent',
        )
        assert.equal(await collections.assign(alice, story, child, drafts), true)
        assert.equal(await collections.assign(alice, story, root, drafts), true, 'move between groups')
        assert.equal(
          (await data.first('story_collection_memberships', { threadId: root }))?.collectionId,
          drafts,
        )
        assert.equal(await collections.assign(bob, story, root, research), false)
        assert.equal(await collections.assign(alice, elsewhere, root, elsewhereCollection), false)
        assert.equal(await collections.assign(alice, story, bobThread, research), false)
        assert.equal(await collections.assign(alice, story, otherThread, research), false)
        assert.equal(await collections.assign(alice, story, deleted, research), false)
        assert.equal(await collections.assign(alice, story, child, elsewhereCollection), false)
        assert.equal(await collections.assign(alice, story, child, randomUUID()), false)
        await assert.rejects(
          data.insert('story_collection_memberships', {
            threadId: otherThread,
            ownerUserId: alice,
            storyId: story,
            collectionId: research,
          }),
          /foreign key|constraint/i,
        )
        await assert.rejects(
          data.insert('story_collection_memberships', {
            threadId: bobThread,
            ownerUserId: alice,
            storyId: story,
            collectionId: research,
          }),
          /foreign key|constraint/i,
        )
        assert.equal(await collections.assign(alice, story, root, null), true)
        assert.equal(await collections.assign(alice, story, root, null), true)
        assert.equal(await data.first('story_collection_memberships', { threadId: root }), undefined)
        assert.equal(await collections.remove(alice, story, drafts), true)
        assert.equal(await collections.remove(alice, story, drafts), false)
        assert.equal(
          await data.first('story_collection_memberships', { threadId: child }),
          undefined,
          'collection deletion cascades only membership',
        )
        assert.equal((await data.first('story_threads', { id: child }))?.parentThreadId, root)
        await assert.rejects(collections.chooseStory(bob, story, nextAt), /Story not found/)
        await collections.chooseStory(alice, story, nextAt)
        await collections.chooseStory(alice, selectionStory, nextAt)
        assert.equal(await collections.selectedStory(alice), selectionStory)
        assert.equal(await collections.selectedStory(bob), null)
        await data.delete('stories', { id: selectionStory })
        assert.equal(await collections.selectedStory(alice), null, 'selection cascades with Story')
        assert.deepEqual(await collections.list(alice, story), [
          { id: research, storyId: story, name: 'Research', createdAt: at, updatedAt: at },
        ])
      })

      await t.test('GitHub and GitLab share owner scoped job and publication state', async () => {
        const expected = {
          id: githubJob,
          title: githubJob,
          repository: 'Owner/' + repo,
          repositoryId: repo,
          providerId: repo,
          baseSha: sha,
          directory: story,
          initialContentSha256: 'e'.repeat(64),
        }
        assert.deepEqual(await publications.job(alice, githubJob, 'github'), expected)
        assert.equal(await publications.job(bob, githubJob, 'github'), null)
        assert.equal(await publications.job(alice, githubJob, 'gitlab'), null)
        assert.equal(await publications.get(alice, githubJob, 'github'), null)
        const pending: PublicationReceipt = {
          targetBranch: 'main',
          remoteBranch: 'review/story',
          headSha: sha,
          phase: 'pending',
          number: null,
          url: null,
        }
        await assert.rejects(
          publications.save(bob, githubJob, 'github', pending, at),
          PublicationStateConflict,
        )
        await assert.rejects(
          publications.save(alice, githubJob, 'gitlab', pending, at),
          PublicationStateConflict,
        )
        await assert.rejects(publications.save('', githubJob, 'github', pending, at), /owner/)
        await assert.rejects(
          publications.save(
            alice,
            githubJob,
            'github',
            {
              ...pending,
              number: 123,
            },
            at,
          ),
          PublicationStateConflict,
        )
        await assert.rejects(
          publications.save(
            alice,
            githubJob,
            'github',
            {
              ...pending,
              phase: 'linked',
              number: null,
            },
            at,
          ),
          PublicationStateConflict,
        )
        await publications.save(alice, githubJob, 'github', pending, at)
        assert.deepEqual(await publications.get(alice, githubJob, 'github'), pending)
        assert.equal(await publications.get(bob, githubJob, 'github'), null)
        assert.equal(await publications.get(alice, githubJob, 'gitlab'), null)
        await Promise.all(
          Array.from({ length: 4 }, () =>
            publications.save(alice, githubJob, 'github', { ...pending, headSha: newerSha }, at),
          ),
        )
        assert.deepEqual(
          await publications.get(alice, githubJob, 'github'),
          pending,
          'pending retry keeps the original verified push intent',
        )
        await assert.rejects(
          publications.save(
            alice,
            githubJob,
            'github',
            {
              ...pending,
              phase: 'linked',
              headSha: newerSha,
              number: 17,
              url: 'https://example.test/17',
            },
            nextAt,
          ),
          PublicationStateConflict,
        )
        await assert.rejects(
          publications.save(
            alice,
            githubJob,
            'github',
            {
              ...pending,
              targetBranch: 'develop',
            },
            nextAt,
          ),
          PublicationStateConflict,
        )
        const linked: PublicationReceipt = {
          ...pending,
          phase: 'linked',
          number: 17,
          url: 'https://example.test/17',
        }
        await publications.save(alice, githubJob, 'github', linked, nextAt)
        await publications.save(alice, githubJob, 'github', linked, nextAt)
        assert.deepEqual(await publications.get(alice, githubJob, 'github'), linked)
        await publications.save(alice, githubJob, 'github', { ...pending, headSha: newerSha }, nextAt)
        assert.deepEqual(
          await publications.get(alice, githubJob, 'github'),
          linked,
          'linked receipt cannot be replaced by pending push intent',
        )
        await assert.rejects(
          publications.save(
            alice,
            githubJob,
            'github',
            {
              ...linked,
              number: 18,
            },
            nextAt,
          ),
          PublicationStateConflict,
        )
        await assert.rejects(
          publications.save(
            alice,
            githubJob,
            'github',
            {
              ...linked,
              url: 'https://example.test/changed',
            },
            nextAt,
          ),
          PublicationStateConflict,
        )
        const revised = { ...linked, headSha: newerSha }
        await publications.save(alice, githubJob, 'github', revised, nextAt)
        await publications.save(alice, githubJob, 'github', revised, nextAt)
        assert.deepEqual(
          await publications.get(alice, githubJob, 'github'),
          revised,
          'a verified revision advances the pinned HEAD without changing the PR identity',
        )

        const gl: PublicationReceipt = {
          targetBranch: 'main',
          remoteBranch: 'gl/review',
          headSha: sha,
          phase: 'pending',
          number: null,
          url: null,
        }
        await publications.save(alice, gitlabJob, 'gitlab', gl, at)
        assert.deepEqual(await publications.get(alice, gitlabJob, 'gitlab'), gl)
        await publications.save(
          alice,
          gitlabJob,
          'gitlab',
          {
            ...gl,
            phase: 'linked',
            number: 27,
            url: 'https://gitlab.test/27',
          },
          nextAt,
        )
        assert.equal((await publications.get(alice, gitlabJob, 'gitlab'))?.number, 27)
        assert.equal(await publications.get(alice, gitlabJob, 'github'), null)
        await assert.rejects(
          data.insert('github_publications', {
            jobId: bobJob,
            ownerUserId: alice,
            targetBranch: 'main',
            remoteBranch: 'bad',
            headSha: sha,
            phase: 'pending',
            prNumber: null,
            prUrl: null,
            updatedAt: at,
          }),
          /foreign key|constraint/i,
        )
        await data.delete('studio_sessions', { id: gitlabJob })
        assert.equal(
          await publications.get(alice, gitlabJob, 'gitlab'),
          null,
          'job deletion cascades provider publication',
        )
        assert.deepEqual(
          await publications.get(alice, githubJob, 'github'),
          revised,
          'other provider and job remain unchanged',
        )
      })
    },
  )
}
