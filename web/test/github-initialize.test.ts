import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireCachedStory, bootstrapEmptyGithubRepository,
  initialStoryDocument, initializeStoryBranch } from '../src/lib/git-cache.server'

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('initializes only an isolated NovelTea branch and reopens the same commit without altering default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-init-branch-'))
  const oldState = process.env.NT_STATE_DIR
  process.env.NT_STATE_DIR = join(root, 'state')
  try {
    const remote = join(root, 'remote.git')
    const source = join(root, 'source')
    mkdirSync(source)
    git(root, 'init', '-q', '--bare', '--initial-branch=main', remote)
    git(source, 'init', '-q', '--initial-branch=main')
    git(source, 'config', 'user.name', 'Tester')
    git(source, 'config', 'user.email', 'tester@example.test')
    writeFileSync(join(source, 'README.md'), 'Other files stay untouched.\n')
    git(source, 'add', 'README.md')
    git(source, 'commit', '-qm', 'Create existing repo')
    git(source, 'remote', 'add', 'origin', remote)
    git(source, 'push', '-q', 'origin', 'main')
    const pinned = git(source, 'rev-parse', 'HEAD')
    const input = {
      cacheDirectory: join(root, 'cache'), ownerId: 'alice',
      repositoryId: 'github:1', remoteUrl: 'file://' + remote, token: 'secret',
      directory: 'new-story', commit: pinned, jobId: 'new-job',
      verifiedSizeBytes: 0, verifiedBlobCount: 0, title: 'Untitled Adventure',
    }
    const created = await initializeStoryBranch(input)
    assert.equal(created.baseSha, pinned)
    assert.notEqual(created.headSha, pinned)
    assert.match(created.branch, /^noveltea-gen\//)
    assert.equal(git(source, 'rev-parse', 'HEAD'), pinned)
    assert.equal(git(remote, 'rev-parse', 'main'), pinned)
    assert.equal(git(created.worktreeRoot, 'diff', '--name-only', pinned, 'HEAD'),
      'new-story/creative-direction/foundation.md')
    assert.equal(readFileSync(join(created.worktreeStoryRoot, 'creative-direction/foundation.md'), 'utf8'),
      initialStoryDocument(input.title))
    assert.equal(existsSync(join(created.worktreeRoot, '.noveltea')), false)
    assert.equal(existsSync(join(created.worktreeStoryRoot, '.noveltea')), false)
    assert.equal(existsSync(join(created.worktreeRoot, 'README.md')), false)
    if (process.env.NT_NATIVE_CLI) {
      const checked = spawnSync(process.env.NT_NATIVE_CLI,
        ['narrative', 'validate', created.worktreeStoryRoot, '--json'], { encoding: 'utf8' })
      assert.equal(checked.status, 0, checked.stdout + checked.stderr)
    }
    const reopened = await initializeStoryBranch({ ...input, requireExistingCommit: true })
    assert.equal(reopened.headSha, created.headSha)
    assert.equal(reopened.threadId, created.threadId)
    assert.equal(git(created.worktreeRoot, 'status', '--porcelain'), '')
    await assert.rejects(() => initializeStoryBranch({
      ...input, jobId: 'lost-manifest', requireExistingCommit: true,
    }), /could not be created or reopened safely/)
    await assert.rejects(() => initializeStoryBranch({
      ...input, title: 'Changed title', requireExistingCommit: true,
    }), /changed|inspect/)
    writeFileSync(join(created.worktreeStoryRoot, 'creative-direction/foundation.md'), 'Interrupted edit')
    await assert.rejects(() => initializeStoryBranch(input), /changed|inspect/)
    assert.equal(readFileSync(join(created.worktreeStoryRoot, 'creative-direction/foundation.md'), 'utf8'), 'Interrupted edit')
  } finally {
    if (oldState === undefined) delete process.env.NT_STATE_DIR
    else process.env.NT_STATE_DIR = oldState
    rmSync(root, { recursive: true, force: true })
  }
})

test('empty remote gets only one non-force default-branch bootstrap commit and becomes a normal cached Story', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-init-empty-'))
  const oldState = process.env.NT_STATE_DIR
  process.env.NT_STATE_DIR = join(root, 'state')
  try {
    const remote = join(root, 'remote.git')
    git(root, 'init', '-q', '--bare', '--initial-branch=main', remote)
    const input = {
      cacheDirectory: join(root, 'cache'), ownerId: 'alice',
      repositoryId: 'github:2', remoteUrl: 'file://' + remote,
      token: 'secret', directory: 'story', title: 'New Story',
    }
    const boot = await bootstrapEmptyGithubRepository({ ...input, defaultBranch: 'main' })
    assert.equal(boot.commit, git(remote, 'rev-parse', 'main'))
    assert.equal(git(remote, 'rev-list', '--count', 'main'), '1')
    assert.equal(git(remote, 'ls-tree', '-r', '--name-only', 'main'),
      'story/creative-direction/foundation.md')
    const job = await acquireCachedStory({
      ...input, commit: boot.commit, jobId: 'first-job',
      verifiedSizeBytes: Buffer.byteLength(initialStoryDocument(input.title)),
      verifiedBlobCount: 1,
    })
    assert.equal(job.baseSha, boot.commit)
    assert.equal(readFileSync(join(job.worktreeStoryRoot, 'creative-direction/foundation.md'), 'utf8'),
      initialStoryDocument(input.title))
    assert.equal(existsSync(join(job.worktreeStoryRoot, '.noveltea')), false)
    await assert.rejects(() => bootstrapEmptyGithubRepository({ ...input, defaultBranch: 'main' }), /cached repository/)
    const second = { ...input, ownerId: 'bob', cacheDirectory: join(root, 'other-cache') }
    await assert.rejects(() => bootstrapEmptyGithubRepository({ ...second, defaultBranch: 'main' }),
      /contains commits/)
    assert.equal(git(remote, 'rev-list', '--count', 'main'), '1')

    // A remote with only a tag still has history: never bootstrap its
    // default branch under the empty-repository exception.
    const tagged = join(root, 'tagged.git')
    const tagSource = join(root, 'tag-source')
    git(root, 'init', '-q', '--bare', '--initial-branch=main', tagged)
    mkdirSync(tagSource)
    git(tagSource, 'init', '-q', '--initial-branch=main')
    git(tagSource, 'config', 'user.name', 'Tester')
    git(tagSource, 'config', 'user.email', 'tester@example.test')
    writeFileSync(join(tagSource, 'readme.txt'), 'Previous history')
    git(tagSource, 'add', '.')
    git(tagSource, 'commit', '-qm', 'Previous commit')
    git(tagSource, 'tag', 'v1')
    git(tagSource, 'remote', 'add', 'origin', tagged)
    git(tagSource, 'push', '-q', 'origin', 'refs/tags/v1')
    await assert.rejects(() => bootstrapEmptyGithubRepository({
      ...input, ownerId: 'tagged-owner', repositoryId: 'github:tagged',
      remoteUrl: 'file://' + tagged, defaultBranch: 'main',
    }), /contains commits/)
  } finally {
    if (oldState === undefined) delete process.env.NT_STATE_DIR
    else process.env.NT_STATE_DIR = oldState
    rmSync(root, { recursive: true, force: true })
  }
})
