import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, realpath, rm, statfs, utimes } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const HASH = /^[a-f0-9]{64}$/
const MiB = 1024 * 1024
const DEFAULT_MAX = 10 * 1024 * MiB

export class CacheCapacityError extends Error {
  readonly status = 507
}

function configuredBytes(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw)) ||
      (name === 'NT_GIT_CACHE_MAX_BYTES' && Number(raw) === 0)) {
    throw new CacheCapacityError(`Invalid ${name}; configure a positive integer byte limit (zero permitted only for the free-space reserve).`)
  }
  return Number(raw)
}

function stateRoot() {
  return resolve(process.env.NT_STATE_DIR || join(
    process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'noveltea-gen',
  ))
}

/** Count the greater of logical and allocated bytes, including Git objects,
 * linked worktrees and transient files. Never follow links; unknown data
 * still consumes the quota and is never automatically deleted.
 */
async function bytesUnder(path: string): Promise<number> {
  let info
  try { info = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  const ownBytes = Math.max(info.size, info.blocks * 512)
  if (!info.isDirectory()) return ownBytes
  let total = ownBytes
  for (const entry of await readdir(path)) {
    total += await bytesUnder(join(path, entry))
    if (!Number.isSafeInteger(total)) throw new CacheCapacityError('Git cache size exceeds safe accounting limits.')
  }
  return total
}

async function safeChildren(path: string): Promise<string[]> {
  try { return await readdir(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function protectedJobRoots(): Promise<Set<string> | null> {
  const protectedRoots = new Set<string>()
  for (const id of await safeChildren(join(stateRoot(), 'jobs'))) {
    // Unknown state may contain an interrupted job; refuse eviction rather than assume recoverability.
    if (!HASH.test(id)) return null
    let raw: string
    try { raw = await readFile(join(stateRoot(), 'jobs', id, 'job.json'), 'utf8') }
    catch { return null }
    try {
      const job = JSON.parse(raw) as { cacheRoot?: unknown }
      if (job.cacheRoot !== undefined) {
        if (typeof job.cacheRoot !== 'string' || !isAbsolute(job.cacheRoot)) return null
        protectedRoots.add(resolve(job.cacheRoot))
      }
    } catch { return null }
  }
  return protectedRoots
}

async function isEvictable(path: string, protectedRoots: Set<string> | null): Promise<boolean> {
  if (!protectedRoots || protectedRoots.has(path) || existsSync(join(path, '.acquire-lock'))) return false
  if ((await safeChildren(path)).some(name => name !== 'base' && name !== 'worktrees')) return false
  if ((await safeChildren(join(path, 'worktrees'))).length) return false
  const base = join(path, 'base')
  if (!existsSync(base)) return false // Incomplete/unknown entries require manual inspection.
  // Even Git-ignored files in the base checkout could be unpublished data.
  if ((await safeChildren(base)).some(name => name !== '.git')) return false
  if ((await safeChildren(join(base, '.git', 'worktrees'))).length) return false
  try {
    if ((await lstat(path)).isSymbolicLink() || (await lstat(base)).isSymbolicLink() ||
        (await lstat(join(base, '.git'))).isSymbolicLink()) return false
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: base, encoding: 'utf8', timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: (() => {
        const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
        for (const key of Object.keys(env)) {
          if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX'].includes(key) ||
              key.startsWith('GIT_CONFIG_') && key !== 'GIT_CONFIG_GLOBAL' && key !== 'GIT_CONFIG_NOSYSTEM') delete env[key]
        }
        return env
      })(),
    }).trim()
    if (git('rev-parse', '--show-toplevel') !== base ||
        git('status', '--porcelain=v1', '--untracked-files=all')) return false
    // A detached unpublished commit, local-only branch, tag, notes or stash
    // must not become 'disposable' merely because its working tree is clean.
    if (git('stash', 'list')) return false
    const allRefs = git('for-each-ref', '--format=%(refname)', 'refs')
    if (allRefs.split('\n').filter(Boolean).some(ref =>
      !ref.startsWith('refs/heads/') && !ref.startsWith('refs/remotes/origin/'))) return false
    const remoteHeads = new Set(git('for-each-ref', '--format=%(objectname)', 'refs/remotes/origin').split('\n'))
    if (!remoteHeads.has(git('rev-parse', 'HEAD'))) return false
    if (git('reflog', 'show', '--all', '--format=%H').split('\n').filter(Boolean).some(sha =>
      !remoteHeads.has(sha))) return false
    const branches = git('for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads')
    for (const line of branches.split('\n').filter(Boolean)) {
      const [branch, sha] = line.split(' ')
      if (!branch || !sha || git('rev-parse', '--verify', `refs/remotes/origin/${branch}`) !== sha) return false
    }
    return true
  } catch { return false }
}

type Candidate = { path: string; lastUse: number }

async function inventory(cache: string, protectedRoots: Set<string> | null, active: string) {
  const candidates: Candidate[] = []
  for (const owner of await safeChildren(cache)) {
    if (!HASH.test(owner)) continue // Unknown entries are accounted but never evicted.
    const ownerPath = join(cache, owner)
    if (!(await lstat(ownerPath)).isDirectory()) continue
    for (const repo of await safeChildren(ownerPath)) {
      if (!HASH.test(repo)) continue
      const path = join(ownerPath, repo)
      if (!(await lstat(path)).isDirectory()) continue
      if (path !== active && await isEvictable(path, protectedRoots)) {
        candidates.push({ path, lastUse: (await lstat(path)).mtimeMs })
      }
    }
  }
  const used = await bytesUnder(cache)
  candidates.sort((a, b) => a.lastUse - b.lastUse || a.path.localeCompare(b.path))
  return { used, candidates }
}

async function freeBytes(cache: string): Promise<number> {
  const fs = await statfs(cache, { bigint: true })
  const bytes = fs.bavail * BigInt(fs.bsize)
  return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes)
}

/** Serialize admission, transfer, accounting and eviction across server processes.
 * A stale lock is retained for manual recovery, not guessed dead by age.
 */
export async function withGitCacheQuota<T>(
  cacheDirectory: string, activeRepository: string, reserveBytes: number, action: () => Promise<T>,
): Promise<T> {
  const cache = resolve(cacheDirectory)
  const active = resolve(activeRepository)
  const parts = relative(cache, active).split('/')
  if (!isAbsolute(cacheDirectory) || parts.length !== 2 || !parts.every(part => HASH.test(part)) ||
      !Number.isSafeInteger(reserveBytes) || reserveBytes < 0) {
    throw new CacheCapacityError('Invalid Git cache quota request.')
  }
  const max = configuredBytes('NT_GIT_CACHE_MAX_BYTES', DEFAULT_MAX)
  const minFree = configuredBytes('NT_GIT_CACHE_MIN_FREE_BYTES', 256 * MiB)
  await mkdir(cache, { recursive: true, mode: 0o700 })
  if (await realpath(cache) !== cache) {
    throw new CacheCapacityError('Git cache directory must not resolve through a symlink; configure its canonical path.')
  }
  for (const part of [dirname(active), active]) {
    if (existsSync(part) && (await lstat(part)).isSymbolicLink()) {
      throw new CacheCapacityError('Git cache repository directories must not be symlinks.')
    }
  }
  const lock = join(cache, '.quota-lock')
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (attempt >= 100) throw new CacheCapacityError('Git cache admission is locked; inspect the previous operation before retrying.')
      await new Promise(done => setTimeout(done, 100))
    }
  }
  try {
    let { used, candidates } = await inventory(cache, await protectedJobRoots(), active)
    let free = await freeBytes(cache)
    for (const candidate of candidates) {
      if (used + reserveBytes <= max && free >= minFree + reserveBytes) break
      // Recheck immediately under the global lock, before removing a whole repository.
      if (!(await isEvictable(candidate.path, await protectedJobRoots()))) continue
      await rm(candidate.path, { recursive: true })
      used = await bytesUnder(cache)
      free = await freeBytes(cache)
    }
    if (used + reserveBytes > max || free < minFree + reserveBytes) {
      throw new CacheCapacityError('Git cache quota or free-disk reserve exhausted. Protected or unpublished jobs were preserved; increase storage or reclaim published cache entries.')
    }
    let result: T
    try { result = await action() }
    catch (error) {
      if (diskFull(error)) throw new CacheCapacityError('Git cache storage is full. Existing jobs and partial Git state were preserved for recovery.')
      throw error
    }
    if (await bytesUnder(cache) > max || await freeBytes(cache) < minFree) {
      // Never erase newly created worktrees or state on a post-transfer overrun.
      throw new CacheCapacityError('Git cache exceeded its quota during Git transfer. Cached work and durable job state were preserved; expand capacity before retrying.')
    }
    // The repository directory mtime is the LRU marker; updating it doesn't
    // modify Git metadata or any job's files. Do not touch after a failed operation.
    const now = new Date()
    await utimes(active, now, now)
    return result
  } finally {
    await rm(lock, { recursive: true })
  }
}

export function diskFull(error: unknown): boolean {
  const e = error as NodeJS.ErrnoException & { stderr?: Buffer | string }
  return e?.code === 'ENOSPC' || e?.code === 'EDQUOT' ||
    /no space left on device|disk quota exceeded/i.test(String(e?.stderr ?? e?.message ?? ''))
}
