import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { CacheCapacityError, diskFull, withGitCacheQuota } from '../src/lib/git-cache-quota.server'

function git(cwd: string, ...args: string[]) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout.trim()
}
function hash(s: string) { return createHash('sha256').update(s).digest('hex') }
function size(p: string): number {
  const info = statSync(p)
  const bytes = Math.max(info.size, info.blocks * 512)
  return info.isDirectory() ? bytes + readdirSync(p).reduce((n, name) => n + size(join(p, name)), 0) : bytes
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nt-quota-'))
  const source = join(root, 'source')
  mkdirSync(source)
  git(source, 'init', '-q', '--initial-branch=main')
  git(source, 'config', 'user.email', 'test@example.com')
  git(source, 'config', 'user.name', 'Test')
  mkdirSync(join(source, 'story'))
  writeFileSync(join(source, 'story', 'canon.md'), 'Story')
  git(source, 'add', '.')
  git(source, 'commit', '-qm', 'Baseline')
  const cache = join(root, 'cache')
  mkdirSync(cache)
  const create = (name: string) => {
    const path = join(cache, hash('owner'), hash(name))
    mkdirSync(path, { recursive: true })
    git(path, 'clone', '--no-checkout', 'file://' + source, 'base')
    git(join(path, 'base'), 'sparse-checkout', 'set', '--no-cone', '/.__noveltea_no_content__/**')
    git(join(path, 'base'), 'checkout', '--detach', git(source, 'rev-parse', 'HEAD'))
    return path
  }
  return { root, source, cache, create }
}

test('quota evicts least-recently-used eligible clone, counting unknown files and preserving active worktrees', async () => {
  const f = fixture()
  const previous = { max: process.env.NT_GIT_CACHE_MAX_BYTES, state: process.env.NT_STATE_DIR, free: process.env.NT_GIT_CACHE_MIN_FREE_BYTES }
  try {
    process.env.NT_STATE_DIR = join(f.root, 'state')
    process.env.NT_GIT_CACHE_MIN_FREE_BYTES = '0'
    const old = f.create('old')
    const newer = f.create('newer')
    const protectedRepo = f.create('protected')
    mkdirSync(join(protectedRepo, 'worktrees'), { recursive: true })
    mkdirSync(join(protectedRepo, 'worktrees', 'unfinished'))
    writeFileSync(join(f.cache, 'transient.bin'), Buffer.alloc(3072))
    utimesSync(old, new Date(1_000), new Date(1_000))
    utimesSync(newer, new Date(2_000), new Date(2_000))
    utimesSync(protectedRepo, new Date(500), new Date(500))
    const used = size(f.cache)
    // One eviction is sufficient, but the active job and unknown transient file are not eligible.
    process.env.NT_GIT_CACHE_MAX_BYTES = String(used - Math.floor(size(old) / 2))
    const active = f.create('active')
    // The newly created active repo is included in accounting and is never an eviction candidate.
    const limit = size(f.cache) - Math.floor(size(old) / 2)
    process.env.NT_GIT_CACHE_MAX_BYTES = String(limit)
    await withGitCacheQuota(f.cache, active, 0, async () => 'ok')
    assert.equal(existsSync(old), false)
    assert.equal(existsSync(newer), true)
    assert.equal(existsSync(protectedRepo), true)
    assert.equal(existsSync(join(f.cache, 'transient.bin')), true)
  } finally {
    restore(previous)
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('durable manifests protect even missing worktrees, and unknown job state fails closed', async () => {
  const f = fixture()
  const previous = { max: process.env.NT_GIT_CACHE_MAX_BYTES, state: process.env.NT_STATE_DIR, free: process.env.NT_GIT_CACHE_MIN_FREE_BYTES }
  try {
    const state = join(f.root, 'state')
    process.env.NT_STATE_DIR = state
    process.env.NT_GIT_CACHE_MIN_FREE_BYTES = '0'
    const protectedRepo = f.create('protected')
    const active = f.create('active')
    const manifestDir = join(state, 'jobs', hash('job'))
    mkdirSync(manifestDir, { recursive: true })
    writeFileSync(join(manifestDir, 'job.json'), JSON.stringify({ cacheRoot: protectedRepo }))
    process.env.NT_GIT_CACHE_MAX_BYTES = String(size(f.cache) - 1)
    await assert.rejects(withGitCacheQuota(f.cache, active, 0, async () => undefined), CacheCapacityError)
    assert.equal(existsSync(protectedRepo), true)
    assert.equal(existsSync(join(manifestDir, 'job.json')), true)
    writeFileSync(join(manifestDir, 'job.json'), '{broken')
    await assert.rejects(withGitCacheQuota(f.cache, active, 0, async () => undefined), CacheCapacityError)
    assert.equal(existsSync(protectedRepo), true)
  } finally {
    restore(previous)
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('unpublished local branches, free-disk reserve and malformed limits block eviction or admission', async () => {
  const f = fixture()
  const previous = { max: process.env.NT_GIT_CACHE_MAX_BYTES, state: process.env.NT_STATE_DIR, free: process.env.NT_GIT_CACHE_MIN_FREE_BYTES }
  try {
    process.env.NT_STATE_DIR = join(f.root, 'state')
    const unpublished = f.create('unpublished')
    const base = join(unpublished, 'base')
    git(base, 'checkout', '-b', 'local-work')
    writeFileSync(join(base, 'work.txt'), 'Unique unpublished local commit')
    git(base, 'add', '--sparse', 'work.txt')
    git(base, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Unpublished work')
    const active = f.create('active')
    process.env.NT_GIT_CACHE_MAX_BYTES = String(size(f.cache) - 1)
    process.env.NT_GIT_CACHE_MIN_FREE_BYTES = '0'
    await assert.rejects(withGitCacheQuota(f.cache, active, 0, async () => undefined), CacheCapacityError)
    assert.equal(existsSync(unpublished), true)

    process.env.NT_GIT_CACHE_MAX_BYTES = '1000000000'
    process.env.NT_GIT_CACHE_MIN_FREE_BYTES = String(Number.MAX_SAFE_INTEGER)
    await assert.rejects(withGitCacheQuota(f.cache, active, 1, async () => undefined), CacheCapacityError)
    process.env.NT_GIT_CACHE_MIN_FREE_BYTES = '0'
    process.env.NT_GIT_CACHE_MAX_BYTES = 'not-a-number'
    await assert.rejects(withGitCacheQuota(f.cache, active, 0, async () => undefined), /Invalid NT_GIT_CACHE_MAX_BYTES/)
  } finally {
    restore(previous)
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('quota refuses new jobs before clone and retains overflow and ENOSPC evidence', async () => {
  const f = fixture()
  const previous = { max: process.env.NT_GIT_CACHE_MAX_BYTES, state: process.env.NT_STATE_DIR, free: process.env.NT_GIT_CACHE_MIN_FREE_BYTES }
  try {
    process.env.NT_STATE_DIR = join(f.root, 'state')
    process.env.NT_GIT_CACHE_MIN_FREE_BYTES = '0'
    process.env.NT_GIT_CACHE_MAX_BYTES = '1024'
    const request = {
      cacheDirectory: f.cache, ownerId: 'alice', repositoryId: 'repo',
      remoteUrl: 'file://' + f.source, token: '', directory: 'story',
      commit: git(f.source, 'rev-parse', 'HEAD'), jobId: 'job-1',
      verifiedSizeBytes: 5, verifiedBlobCount: 1,
    }
    await assert.rejects(acquireCachedStory(request), (error: unknown) =>
      error instanceof Error && /quota|reserve/i.test(error.message))
    assert.equal(existsSync(join(f.cache, hash('alice'), hash('repo'))), false)
    process.env.NT_GIT_CACHE_MAX_BYTES = '100000'
    const active = join(f.cache, hash('another'), hash('repo'))
    await assert.rejects(withGitCacheQuota(f.cache, active, 0, async () => {
      mkdirSync(active, { recursive: true })
      writeFileSync(join(active, 'overflow'), Buffer.alloc(150_000))
    }), (error: unknown) => error instanceof CacheCapacityError && /exceeded/.test(error.message))
    assert.equal(existsSync(join(active, 'overflow')), true)
    assert.equal(diskFull(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })), true)
    process.env.NT_GIT_CACHE_MAX_BYTES = '1000000'
    await assert.rejects(withGitCacheQuota(f.cache, active, 0, async () => {
      throw Object.assign(new Error('write failure'), { code: 'EDQUOT' })
    }), (error: unknown) => error instanceof CacheCapacityError && /full/.test(error.message))
    assert.equal(existsSync(join(active, 'overflow')), true)
  } finally {
    restore(previous)
    rmSync(f.root, { recursive: true, force: true })
  }
})

function restore(old: { max?: string; state?: string; free?: string }) {
  for (const [key, value] of [
    ['NT_GIT_CACHE_MAX_BYTES', old.max], ['NT_STATE_DIR', old.state],
    ['NT_GIT_CACHE_MIN_FREE_BYTES', old.free],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
