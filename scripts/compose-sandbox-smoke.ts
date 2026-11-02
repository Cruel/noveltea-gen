/**
 * Disposable, real controller-backed Compose sandbox smoke.
 * Invoked from the trusted agent during --compose certification only.
 * No model calls, external provider requests, or production user identities.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openStudioDatabase } from '../web/src/db/connection'
import { startStoryJob } from '../src/job'
import { SandboxClient } from '../src/sandbox-client'

const root = process.env.NT_GIT_CACHE_DIR
const state = process.env.NT_STATE_DIR
if (!root || !state || !root.startsWith('/') || !state.startsWith('/')) {
  throw new Error('Compose sandbox certification needs the trusted mounted cache and state volumes.')
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const owner = 'compose-sandbox-cert-' + randomUUID()
const provider = 'compose-sandbox-fixture-' + randomUUID()
const repo = join(root, hash(owner), hash('github:' + provider))
const base = join(repo, 'base')
const story = join(base, 'story')
const id = randomUUID()
const storyId = randomUUID()
const repositoryId = randomUUID()
const date = new Date().toISOString()
function git(...args: string[]) {
  return execFileSync('git', args, { cwd: base, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }).trim()
}
mkdirSync(story, { recursive: true, mode: 0o700 })
git('init', '-q')
git('config', 'user.name', 'Compose Certification')
git('config', 'user.email', 'certification@example.invalid')
writeFileSync(join(story, 'README.txt'), 'Disposable sandbox testing baseline\n')
git('add', '.')
git('commit', '-qm', 'Disposable Compose baseline')
const pin = git('rev-parse', 'HEAD')
const job = await startStoryJob({ story, job: id, worktreeCacheRoot: repo })
assert.equal(job.baseSha, pin)
const db = openStudioDatabase('/var/lib/noveltea/app/studio.sqlite').sqlite
try {
  db.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
    .run(owner, 'Compose Certification', 'cert-' + id + '@example.invalid', 1, Date.now(), Date.now())
  db.prepare('INSERT INTO repositories (id,owner_user_id,provider,provider_repository_id,name,created_at) VALUES (?,?,?,?,?,?)')
    .run(repositoryId, owner, 'github', provider, 'certification/fixture', date)
  db.prepare('INSERT INTO stories (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha) VALUES (?,?,?,?,?,?,?)')
    .run(storyId, owner, repositoryId, 'story', 'Controller certification fixture', date, pin)
  db.prepare('INSERT INTO studio_sessions (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, owner, storyId, 'Controller certification job', pin, 'paused', date, date)
} finally { db.close() }
const client = new SandboxClient()
try {
  assert.equal((await client.acquire(id)).status, 'running')
  const out: string[] = []
  const exit = await client.execute(id,
    ['sh', '-c', 'test ! -e /story/.git && test ! -e /story/.story-inbox && test ! -e /run/noveltea-controller && printf mounted > /story/sandbox-probe.txt'],
    (_stream, part) => out.push(part))
  assert.equal(exit, 0, 'Sandbox file write and private-path denial should pass')
  const receipt = join(job.worktreeStoryRoot, 'sandbox-probe.txt')
  assert.ok(existsSync(receipt), 'Controller did not mount the real registered worktree Story directory')
  assert.equal(readFileSync(receipt, 'utf8'), 'mounted')
  console.log('PASS registered Compose job: rootless sandbox /story write with private Git/IPC isolation')
} finally {
  await client.dispose(id)
}
