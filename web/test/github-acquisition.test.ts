import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireCachedStory, inspectCachedStory } from '../src/lib/git-cache.server'
import { nativeValidateSource } from '../../src/native-validator'
import { nativeVersion } from '../../src/native-cli-version'
import { reusableExistingFoundation } from '../../src/foundation-readiness'
import { renderFoundation } from '../../src/foundation-record'

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('pinned GitHub Story acquisition shares objects but never job files, and reopens safely', async () => {
  const root = mkdtempSync(join(tmpdir(), 'noveltea-acquire-'))
  const oldState = process.env.NT_STATE_DIR
  process.env.NT_STATE_DIR = join(root, 'durable')
  try {
    const remote = join(root, 'remote')
    mkdirSync(remote)
    git(remote, 'init', '-q')
    git(remote, 'config', 'user.email', 'test@example.com')
    git(remote, 'config', 'user.name', 'Test')
    mkdirSync(join(remote, 'story', 'creative-direction'), { recursive: true })
    mkdirSync(join(remote, 'creative-direction'))
    mkdirSync(join(remote, 'massive-assets'))
    writeFileSync(join(remote, 'story', 'creative-direction', 'foundation.md'), 'Original canon\n')
    writeFileSync(join(remote, 'creative-direction', 'root.md'), 'Root canon\n')
    writeFileSync(join(remote, 'massive-assets', 'video.bin'), Buffer.alloc(1024 * 1024, 7))
    writeFileSync(join(remote, 'README.md'), 'Unrelated root file\n')
    git(remote, 'add', '.')
    git(remote, 'commit', '-qm', 'Story')
    const pinned = git(remote, 'rev-parse', 'HEAD')
    const input = {
      cacheDirectory: join(root, 'cache'), ownerId: 'alice', repositoryId: 'repo-123',
      remoteUrl: 'file://' + remote,
      commit: pinned, directory: 'story', token: 'secret-never-stored',
      verifiedSizeBytes: 15, verifiedBlobCount: 1,
    }
    let inspectedRoot = ''
    const reusable = await inspectCachedStory(input, async view => {
      inspectedRoot = view.worktreeRoot
      assert.equal(view.baseSha, pinned)
      assert.equal(git(view.worktreeRoot, 'rev-parse', 'HEAD'), pinned)
      assert.equal(git(view.worktreeRoot, 'branch', '--show-current'), '')
      assert.equal(existsSync(join(view.worktreeRoot, 'massive-assets')), false)
      assert.equal(readFileSync(join(view.worktreeStoryRoot, 'creative-direction', 'foundation.md'), 'utf8'), 'Original canon\n')
      const result = nativeValidateSource(view, { contract: 'noveltea-validator/v1',
        implementation: 'native-cli', version: nativeVersion() })
      assert.equal('jobId' in result, false)
      return reusableExistingFoundation(view, result)
    })
    assert.equal(reusable, false)
    assert.equal(existsSync(inspectedRoot), false)
    assert.equal(existsSync(join(root, 'durable')), false, 'inspection creates no Generation manifest')
    await assert.rejects(() => inspectCachedStory(input, async view => {
      inspectedRoot = view.worktreeRoot
      throw Error('interrupted inspection')
    }), /interrupted inspection/)
    assert.equal(existsSync(inspectedRoot), false)
    const first = await acquireCachedStory({ ...input, jobId: 'job-a' })
    const second = await acquireCachedStory({ ...input, jobId: 'job-b' })
    assert.equal(first.baseSha, pinned)
    assert.equal(second.baseSha, pinned)
    assert.notEqual(first.worktreeRoot, second.worktreeRoot)
    assert.notEqual(first.branch, second.branch)
    assert.equal(git(first.worktreeRoot, 'rev-parse', '--git-common-dir'),
      git(second.worktreeRoot, 'rev-parse', '--git-common-dir'))
    assert.equal(existsSync(join(first.worktreeRoot, 'massive-assets', 'video.bin')), false)
    assert.equal(existsSync(join(second.worktreeRoot, 'README.md')), false)
    assert.equal(readFileSync(join(first.worktreeStoryRoot, 'creative-direction', 'foundation.md'), 'utf8'), 'Original canon\n')
    assert.doesNotMatch(readFileSync(join(first.gitRoot, '.git', 'config'), 'utf8'), /secret-never-stored/)
    writeFileSync(join(first.worktreeStoryRoot, 'creative-direction', 'foundation.md'), 'Draft A\n')
    assert.equal(readFileSync(join(second.worktreeStoryRoot, 'creative-direction', 'foundation.md'), 'utf8'), 'Original canon\n')
    const reopened = await acquireCachedStory({ ...input, jobId: 'job-a' })
    assert.equal(reopened.threadId, first.threadId)
    assert.equal(readFileSync(join(reopened.worktreeStoryRoot, 'creative-direction', 'foundation.md'), 'utf8'), 'Draft A\n')
    assert.equal(git(first.gitRoot, 'rev-parse', 'HEAD'), pinned)
    assert.equal(git(first.worktreeRoot, 'rev-parse', 'HEAD'), pinned)
    assert.equal(existsSync(join(first.stateDir, 'job.json')), true)
    assert.equal(existsSync(join(root, 'cache', 'job.json')), false)

    const otherOwner = await acquireCachedStory({ ...input, ownerId: 'bob', jobId: 'job-a' })
    assert.notEqual(otherOwner.gitRoot, first.gitRoot)
    assert.notEqual(otherOwner.stateDir, first.stateDir)

    const [parallelA, parallelB] = await Promise.all([
      acquireCachedStory({ ...input, jobId: 'parallel-a' }),
      acquireCachedStory({ ...input, jobId: 'parallel-b' }),
    ])
    assert.notEqual(parallelA.worktreeRoot, parallelB.worktreeRoot)
    await assert.rejects(() => acquireCachedStory({ ...input, verifiedSizeBytes: 14, jobId: 'mismatch' }),
      /preflight size\/count/)
    await assert.rejects(() => acquireCachedStory({ ...input, commit: 'b'.repeat(40), jobId: 'job-c' }),
      /commit|fetch|revision|pinned|Git/i)
    writeFileSync(join(remote, 'story', 'creative-direction', 'next.md'), 'New revision\n')
    git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'New upstream Story')
    const moved = git(remote, 'rev-parse', 'HEAD')
    await assert.rejects(() => acquireCachedStory({ ...input, commit: moved, jobId: 'job-a',
      verifiedSizeBytes: 28, verifiedBlobCount: 2 }), /different Story commit/)
    const newest = await acquireCachedStory({ ...input, commit: moved, jobId: 'new-revision',
      verifiedSizeBytes: 28, verifiedBlobCount: 2 })
    assert.equal(newest.baseSha, moved)
    assert.equal((await acquireCachedStory({ ...input, jobId: 'job-a' })).baseSha, pinned)
    assert.equal(readFileSync(join(first.worktreeStoryRoot, 'creative-direction', 'foundation.md'), 'utf8'), 'Draft A\n')
    assert.equal(existsSync(join(first.worktreeRoot, 'massive-assets')), false)
    const rootStory = await acquireCachedStory({ ...input, directory: '', jobId: 'root-story',
      verifiedSizeBytes: undefined, verifiedBlobCount: undefined })
    assert.equal(readFileSync(join(rootStory.worktreeRoot, 'creative-direction', 'root.md'), 'utf8'), 'Root canon\n')
    await assert.rejects(() => acquireCachedStory({ ...input, directory: 'story/*', jobId: 'unsafe-pattern' }),
      /Invalid cached Story identity/)
    const approved = renderFoundation({
      id: 'foundation', title: 'The Last Bell',
      premise: 'A bell disappears', central_conflict: 'The town conceals the culprit',
      genre: 'Mystery', tone: 'Somber', player_experience: 'Investigate the clues',
      scope: 'A coastal town', body: 'An investigator searches for a missing bell.',
      decisions: [{ id: 'author-genre', statement: 'Make it a mystery.',
        origin: 'user', authority: 'user-protected' }],
    }, 'approved')
    mkdirSync(join(remote, 'approved-story', 'creative-direction'), { recursive: true })
    writeFileSync(join(remote, 'approved-story', 'creative-direction', 'foundation.md'), approved)
    git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'Existing approved Story')
    const approvedSha = git(remote, 'rev-parse', 'HEAD')
    const branches = git(first.gitRoot, 'for-each-ref', '--format=%(refname)', 'refs/heads')
    assert.equal(await inspectCachedStory({ ...input, directory: 'approved-story',
      commit: approvedSha, verifiedSizeBytes: Buffer.byteLength(approved), verifiedBlobCount: 1 },
      async view => {
        const result = nativeValidateSource(view, { contract: 'noveltea-validator/v1',
          implementation: 'native-cli', version: nativeVersion() })
        assert.equal(result.status, 'passed', JSON.stringify(result))
        return reusableExistingFoundation(view, result)
      }), true, 'approved existing canon is recognized without creating a job')
    assert.equal(git(first.gitRoot, 'for-each-ref', '--format=%(refname)', 'refs/heads'), branches)
    git(first.gitRoot, 'worktree', 'remove', '--force', first.worktreeRoot)
    await assert.rejects(() => acquireCachedStory({ ...input, jobId: 'job-a' }),
      /could not be created or reopened safely/)
    assert.equal(existsSync(join(first.stateDir, 'job.json')), true)
  } finally {
    if (oldState === undefined) delete process.env.NT_STATE_DIR
    else process.env.NT_STATE_DIR = oldState
    rmSync(root, { recursive: true, force: true })
  }
})
