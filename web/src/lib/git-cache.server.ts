import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { startStoryJob } from '../../../src/job'
import { STORY_LIMIT_BYTES } from './story-discovery.shared'

// Trusted controller boundary: no browser-supplied Git URL, path, or identity
// reaches this function. Provider adapters authorize the catalog row first.
export interface CachedStoryRequest {
  cacheDirectory: string
  ownerId: string
  repositoryId: string
  remoteUrl: string
  token: string
  commit: string
  directory: string
  jobId: string
  verifiedSizeBytes?: number
  verifiedBlobCount?: number
}

export class GitCacheError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const SHA = /^[a-f0-9]{40}$/i
const SAFE_DIRECTORY = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\\)[^\x00-\x1f\x7f]*$/

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  const result = execFileSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'], env,
  })
  return result.trim()
}

/** Ephemeral Git child-process environment; never persist or expose to clients. */
export function gitEnvironment(url: string, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  }
  for (const key of Object.keys(env)) {
    if ((key.startsWith('GIT_CONFIG_') && key !== 'GIT_CONFIG_GLOBAL' && key !== 'GIT_CONFIG_NOSYSTEM') ||
        key.startsWith('GIT_TRACE') || key === 'GIT_CURL_VERBOSE' || key === 'GIT_ASKPASS') delete env[key]
  }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[key]
  const github = url.startsWith('https://github.com/')
  const gitlab = url.startsWith('https://gitlab.com/')
  if (github || gitlab) {
    // OAuth tokens for either provider are supplied only to the Git child.
    // Neither origin URL, argv, on-disk Git config nor durable state stores
    // the token. GitLab's OAuth HTTPS username is the literal "oauth2".
    if (!token) throw new GitCacheError(409, 'Git provider authorization is missing; reconnect your account.')
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = github
      ? 'http.https://github.com/.extraheader'
      : 'http.https://gitlab.com/.extraheader'
    env.GIT_CONFIG_VALUE_0 = 'AUTHORIZATION: basic ' +
      Buffer.from((github ? 'x-access-token:' : 'oauth2:') + token).toString('base64')
  }
  return env
}

async function withRepositoryLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const lock = join(root, '.acquire-lock')
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock, { mode: 0o700 })
      break
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      // A crash leaves a visible lock for manual reconciliation; do not
      // silently remove a potentially active acquisition from another process.
      if (attempt >= 100) throw new GitCacheError(409, 'Git repository acquisition is locked; inspect the cached repository before retrying.')
      await new Promise(done => setTimeout(done, 100))
    }
  }
  try { return await action() } finally { await rm(lock, { recursive: true }) }
}

function treeSizes(base: string, env: NodeJS.ProcessEnv, commit: string, directory: string) {
  const args = ['ls-tree', '-r', '--long', '-z', commit, '--', ...(directory ? [directory] : ['.'])]
  const output = execFileSync('git', args, {
    cwd: base, env, maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let bytes = 0
  let count = 0
  for (const entry of output.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob [0-9a-f]{40} +([0-9]+)\t([^\n]+)$/.exec(entry)
    if (!match || (directory && !match[3]!.startsWith(directory + '/'))) {
      throw new GitCacheError(422, 'Selected Story contains unsupported Git object types or paths.')
    }
    bytes += Number(match[2])
    if (!Number.isSafeInteger(bytes) || bytes > STORY_LIMIT_BYTES) {
      throw new GitCacheError(422, 'Selected Story exceeds the verified 100 MB source limit.')
    }
    count++
  }
  if (!count) throw new GitCacheError(422, 'Selected Story has no Git blobs at the pinned revision.')
  return { bytes, count }
}

/** Accept provider-derived HTTPS remotes, including GitLab subgroup namespaces. */
export function allowedGitRemote(url: string): boolean {
  const github = /^https:\/\/github\.com\/[a-z\d-]+\/[a-z\d_.-]+\.git$/i.test(url)
  const gitlab = /^https:\/\/gitlab\.com\/(?:[a-z\d_][a-z\d_.-]*\/)+[a-z\d_][a-z\d_.-]*\.git$/i.test(url) &&
    !url.split('/').some(part => part === '.' || part === '..')
  // Local file remotes are reachable only via the trusted internal caller,
  // never from a request body. They are also used by isolated Git tests.
  return github || gitlab || url.startsWith('file://')
}

function assertInput(input: CachedStoryRequest) {
  if (!isAbsolute(input.cacheDirectory)) throw new GitCacheError(503, 'Git cache root must be absolute and configured by the server.')
  if (!input.ownerId || !input.repositoryId || !SHA.test(input.commit) ||
      !SAFE_DIRECTORY.test(input.directory) || input.directory.endsWith('/') ||
      input.directory.split('/').some(part => (!part && input.directory !== '') ||
        part === '.git' || ['*', '?', '[', ']', '!'].some(char => part.includes(char))) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.jobId) || input.jobId.includes('..')) {
    throw new GitCacheError(400, 'Invalid cached Story identity, revision, or directory.')
  }
  if (!allowedGitRemote(input.remoteUrl)) {
    throw new GitCacheError(400, 'Unsupported authenticated Git remote.')
  }
}

export async function acquireCachedStory(input: CachedStoryRequest) {
  assertInput(input)
  const cache = resolve(input.cacheDirectory)
  const scoped = (value: string) => createHash('sha256').update(value).digest('hex')
  const repositoryRoot = join(cache, scoped(input.ownerId), scoped(input.repositoryId))
  const base = join(repositoryRoot, 'base')
  const environment = gitEnvironment(input.remoteUrl, input.token)
  return withRepositoryLock(repositoryRoot, async () => {
    if (!existsSync(base)) {
      // One clone per owner/repository, with objects shared by every job.
      // --no-checkout prevents even root-level monorepo assets being hydrated.
      try {
        git(repositoryRoot, environment, 'clone', '--no-checkout', '--filter=blob:none',
          '--depth=1', '--single-branch', '--no-tags', input.remoteUrl, base)
      } catch {
        // Preserve incomplete clone for investigation; never overwrite an
        // uncertain Git directory or existing job.
        throw new GitCacheError(503, 'Git clone failed; check provider authorization, repository access, and cache state.')
      }
    }
    if (await realpath(base) !== base || !(await stat(base)).isDirectory()) {
      throw new GitCacheError(409, 'Cached Git base has an unexpected filesystem identity.')
    }
    const localEnv = gitEnvironment(input.remoteUrl, input.token)
    if (!(await stat(join(base, '.git'))).isDirectory() ||
        resolve(git(base, localEnv, 'rev-parse', '--show-toplevel')) !== base ||
        resolve(base, git(base, localEnv, 'rev-parse', '--git-common-dir')) !== join(base, '.git') ||
        git(base, localEnv, 'remote', 'get-url', 'origin') !== input.remoteUrl) {
      throw new GitCacheError(409, 'Cached Git base repository identity differs; refusing to reuse it.')
    }
    try {
      git(base, localEnv, 'fetch', '--no-tags', '--filter=blob:none', '--depth=1', 'origin', input.commit)
      if (git(base, localEnv, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}').toLowerCase() !== input.commit.toLowerCase()) {
        throw new Error('Fetch did not match the pinned GitHub preflight commit.')
      }
      // The reusable base has an empty sparse working tree; materialization
      // happens only in job-specific worktrees. It can switch pinned baselines
      // without changing any job branch or work files.
      git(base, localEnv, 'sparse-checkout', 'set', '--no-cone', '--', '/.__noveltea_no_content__/**')
      git(base, localEnv, 'checkout', '--detach', input.commit)
    } catch {
      throw new GitCacheError(503, 'Unable to fetch and pin the selected provider commit. Recheck access and preflight revision.')
    }
    const sizes = treeSizes(base, localEnv, input.commit, input.directory)
    if ((input.verifiedSizeBytes !== undefined && sizes.bytes !== input.verifiedSizeBytes) ||
        (input.verifiedBlobCount !== undefined && sizes.count !== input.verifiedBlobCount)) {
      throw new GitCacheError(422, 'Acquired Git tree does not match the Story API preflight size/count.')
    }
    const storyRoot = join(base, input.directory)
    await mkdir(storyRoot, { recursive: true })
    if (await realpath(storyRoot) !== storyRoot) throw new GitCacheError(409, 'Cached Story path resolves through a symlink.')
    try {
      const job = await startStoryJob({
        story: storyRoot, job: input.jobId, worktreeCacheRoot: repositoryRoot,
        sparseStoryOnly: true, gitTransportEnv: environment,
      })
      if (job.baseSha.toLowerCase() !== input.commit.toLowerCase()) {
        throw new GitCacheError(409, 'Saved job is pinned to a different Story commit; create another job rather than moving its baseline.')
      }
      return job
    } catch (error) {
      if (error instanceof GitCacheError) throw error
      // The durable job manifest and any existing partial worktree are left
      // intact for explicit recovery; do not overwrite or reset another job.
      throw new GitCacheError(409, 'Git job worktree could not be created or reopened safely. Inspect saved job state and cache.')
    }
  })
}
