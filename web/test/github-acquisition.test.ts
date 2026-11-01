import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireCachedStory } from '../src/lib/git-cache.server'

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
