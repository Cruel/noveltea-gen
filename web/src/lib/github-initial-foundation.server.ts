import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { StudioStore } from '../persistence/store'
import { authorizedStoryJob } from './fixture-jobs.server'

/** Read the original unpublished GitHub initialization without trusting a
 * filename, source SHA or executable path supplied by the browser. The
 * onboarding transaction identifies a single original job; all three Git
 * identities, the exact one-file commit, clean worktree and original bytes
 * must agree with the owner-scoped catalog before reuse. */
export async function verifiedGithubInitialFoundation(store: StudioStore, owner: string,
  storyId: string, sourceSha: string, contentDigest: string): Promise<string> {
  const originalId = await store.persistence.naturalStory.originalInitializationJob(owner, storyId)
  if (!originalId || !/^[a-f0-9]{40}$/.test(sourceSha) ||
      !/^[a-f0-9]{64}$/.test(contentDigest))
    throw new Error('Saved GitHub initialization is missing or ambiguous.')
  const job = await authorizedStoryJob(store, owner, originalId)
  if (job.baseSha !== sourceSha || job.headSha === sourceSha)
    throw new Error('Original Story initialization has a different pinned Git source.')
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX'])
    delete env[key]
  const run = (...args: string[]) => execFileSync('git', args, {
    cwd: job.worktreeRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000, maxBuffer: 1024 * 1024,
  }).trim()
  const path = [job.storyRelativePath, 'creative-direction/foundation.md'].filter(Boolean).join('/')
  if (run('rev-parse', 'HEAD') !== job.headSha ||
      run('rev-parse', 'HEAD^') !== sourceSha ||
      run('rev-list', '--count', sourceSha + '..HEAD') !== '1' ||
      run('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD') !== path ||
      run('log', '-1', '--format=%s') !== 'Initialize draft NovelTea Story' ||
      run('status', '--porcelain=v1', '--untracked-files=all'))
    throw new Error('Original GitHub initialization is no longer the exact verified one-file commit.')
  const data = execFileSync('git', ['show', 'HEAD:' + path], {
    cwd: job.worktreeRoot, env, timeout: 10_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (createHash('sha256').update(data).digest('hex') !== contentDigest)
    throw new Error('Original approved Creative Direction differs from its saved content digest.')
  return data.toString('utf8')
}
