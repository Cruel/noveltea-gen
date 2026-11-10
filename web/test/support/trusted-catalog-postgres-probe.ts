/** Runs inside the disposable private pg-controller Docker network.
 * Exercises the real Kysely reader AND full controller manifest authorization. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTrustedCatalog, readTrustedControllerJob } from '../../src/db/trusted-catalog'
import { resolveTrustedJob, SandboxError, type ControllerConfig } from '../../src/sandbox-controller'

const connection = {
  host: process.env.PGHOST ?? '',
  port: Number(process.env.PGPORT ?? '5432'),
  database: process.env.PGDATABASE ?? '',
  user: process.env.PGUSER ?? '',
  password: process.env.PGPASSWORD ?? '',
}
const options = { backend: 'postgres' as const, connection }
const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const expected = {
  ownerId: 'owner-1', provider: 'github', providerId: '987',
  directory: 'story', pin: 'a'.repeat(40), configJson: null,
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex')

for (let i = 0; i < 2; i++) {
  const reader = openTrustedCatalog(options)
  try {
    assert.deepEqual(await reader.readJob(id), expected)
    assert.equal(await reader.readJob('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'), null,
      'Cross-owner Story association must never authorize a job')
    assert.equal(await reader.readJob('ffffffff-ffff-4fff-8fff-ffffffffffff'), null)
    assert.equal(await reader.readJob(id + "' OR TRUE --"), null)
  } finally { await reader.close() }
  await assert.rejects(reader.readJob(id), /closed/)
}
assert.deepEqual(await readTrustedControllerJob(options, id), expected)

const root = mkdtempSync(join(tmpdir(), 'noveltea-pg-controller-'))
try {
  const appVolume = join(root, 'app'), stateVolume = join(root, 'state'), cacheVolume = join(root, 'cache')
  for (const dir of [appVolume, stateVolume, cacheVolume]) mkdirSync(dir)
  const controller: ControllerConfig = {
    appVolume, stateVolume, cacheVolume, catalog: options, socket: join(root, 'controller.sock'),
    token: 'x'.repeat(64), image: 'not-used',
    containerCache: '/var/lib/noveltea/cache', containerState: '/var/lib/noveltea/state',
  }
  const scoped = join(hash('owner-1'), hash('github:987'))
  const gitRoot = join(controller.containerCache, scoped, 'base')
  const identity = hash(JSON.stringify([gitRoot, 'story', id]))
  const repoRoot = join(controller.containerCache, scoped)
  const worktreeRoot = join(repoRoot, 'worktrees', identity)
  const stateDir = join(controller.containerState, 'jobs', identity)
  const manifestDir = join(stateVolume, 'jobs', identity)
  const hostWorktree = join(cacheVolume, scoped, 'worktrees', identity)
  const registry = join(cacheVolume, scoped, 'base', '.git', 'worktrees', identity)
  mkdirSync(join(hostWorktree, 'story'), { recursive: true })
  mkdirSync(manifestDir, { recursive: true })
  mkdirSync(registry, { recursive: true })
  writeFileSync(join(hostWorktree, '.git'), 'gitdir: ' + gitRoot + '/.git/worktrees/' + identity + '\n')
  writeFileSync(join(registry, 'gitdir'), join(worktreeRoot, '.git') + '\n')
  writeFileSync(join(registry, 'HEAD'), 'ref: refs/heads/noveltea-gen/' + identity + '\n')
  const manifest = {
    version: 1, jobId: id, gitRoot, gitCommonDir: join(gitRoot, '.git'),
    storyRoot: join(gitRoot, 'story'), storyRelativePath: 'story', baseSha: expected.pin,
    branch: 'noveltea-gen/' + identity, stateDir, cacheRoot: repoRoot, worktreeRoot,
    worktreeStoryRoot: join(worktreeRoot, 'story'),
  }
  const manifestPath = join(manifestDir, 'job.json')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  for (let i = 0; i < 2; i++) {
    const resolved = await resolveTrustedJob(controller, id, 'sha256:' + 'e'.repeat(64))
    assert.equal(resolved.storyRoot, join(hostWorktree, 'story'))
    assert.equal(resolved.identity, identity)
  }
  await assert.rejects(resolveTrustedJob(controller, 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', ''),
    (error: unknown) => error instanceof SandboxError && error.status === 404)
  await assert.rejects(resolveTrustedJob(controller, id + "' OR TRUE --", ''),
    (error: unknown) => error instanceof SandboxError && error.status === 400)
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, baseSha: 'b'.repeat(40) }))
  await assert.rejects(resolveTrustedJob(controller, id, ''),
    (error: unknown) => error instanceof SandboxError && error.status === 409)
} finally { rmSync(root, { recursive: true, force: true }) }
console.log('PASS read-only Kysely PostgreSQL controller: owner isolation, manifest pin, injection, lifecycle, restart')
