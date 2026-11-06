import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { JobStartResult } from '../../../src/job'
import { setJobControl } from '../../../src/job-control'
import { withStoryJobLock } from '../../../src/job-lock'
import type { StudioStore } from '../persistence/store'
import { restoreJob } from './fixture-jobs.server'
import { dequeueBeforeStart } from './generation-queue.server'
import { withRepositoryLock } from './git-cache.server'
import { snapshotJobUsage, type RunUsageSnapshot } from './thread-usage.server'

type Resource = { job: JobStartResult; head: string; bytes: number }
type Plan = { version: 1; threadId: string; owner: string; resources: Resource[];
  preserveReceipts: boolean; bytes: number;
  usageSummaries: Record<string, RunUsageSnapshot> }
export type DeletionOutcome =
  | { state: 'pending'; message: string }
  | { state: 'complete'; bytes: number; preservedReceipts: boolean }

/** This is never supplied by an HTTP client. All filesystem identities are
 * pinned from an authenticated Studio job before the first destructive step. */
const digest = (input: string) => createHash('sha256').update(input).digest('hex')
const inside = (root: string, target: string) => {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}
const stateRoot = () => resolve(process.env.NT_STATE_DIR ||
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'noveltea-gen'))
const env = () => {
  const vars: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  for (const key of Object.keys(vars)) {
    if (key.startsWith('GIT_CONFIG_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(key) ||
      key.startsWith('GIT_TRACE') || key === 'GIT_DIR' || key === 'GIT_WORK_TREE' ||
      key === 'GIT_COMMON_DIR' || key === 'GIT_INDEX_FILE' || key === 'GIT_PREFIX') delete vars[key]
  }
  return vars
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, env: env(), encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
}).trim()

async function bytesOnDisk(path: string): Promise<number> {
  let entry
  try { entry = await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in deletion resource.')
  if (!entry.isDirectory()) return entry.size
  let size = entry.size
  for (const name of await readdir(path)) size += await bytesOnDisk(join(path, name))
  return size
}

function verifyPlan(plan: Plan, owner: string, threadId: string) {
  if (plan?.version !== 1 || plan.threadId !== threadId || plan.owner !== owner ||
    !Array.isArray(plan.resources) || !Number.isSafeInteger(plan.bytes) || plan.bytes < 0)
    throw new Error('Deletion record is invalid; operator reconciliation required.')
  const cache = process.env.NT_GIT_CACHE_DIR
  if (!cache || !isAbsolute(cache)) throw new Error('Trusted Git cache configuration is missing.')
  const state = stateRoot()
  const seen = new Set<string>()
  for (const resource of plan.resources) {
    const job = resource.job
    if (!job || !/^[a-f0-9]{40}$/.test(resource.head) || !job.cacheRoot ||
        !isAbsolute(job.cacheRoot) || !isAbsolute(job.gitRoot) ||
        !isAbsolute(job.worktreeRoot) || !isAbsolute(job.stateDir) ||
        !/^[a-f0-9-]{36}$/i.test(job.jobId) || seen.has(job.jobId)) {
      throw new Error('Saved deletion resource identity is malformed.')
    }
    seen.add(job.jobId)
    const id = digest(JSON.stringify([job.gitRoot, job.storyRelativePath, job.jobId]))
    if (job.branch !== 'noveltea-gen/' + id ||
        job.gitRoot !== join(job.cacheRoot, 'base') ||
        job.worktreeRoot !== join(job.cacheRoot, 'worktrees', id) ||
        job.stateDir !== join(state, 'jobs', id) ||
        !inside(resolve(cache), job.cacheRoot) ||
        !/^[a-f0-9]{40}$/.test(job.baseSha) ||
        !Number.isSafeInteger(resource.bytes) || resource.bytes < 0) {
      throw new Error('Saved deletion target escaped its verified Git/state namespace.')
    }
  }
}

/** The caller owns the per-repository acquisition lock for the entire operation.
 * A missing worktree is permissible only after the plan was durably reserved;
 * a registered but missing worktree or a moved ref is NEVER considered cleaned. */
async function removeResource(resource: Resource, preserveReceipts: boolean): Promise<void> {
  const { job, head } = resource
  const base = job.gitRoot, work = job.worktreeRoot
  if (await realpath(base) !== base || await realpath(job.cacheRoot!) !== job.cacheRoot ||
      !(await lstat(join(base, '.git'))).isDirectory() ||
      git(base, 'rev-parse', '--path-format=absolute', '--git-common-dir') !== join(base, '.git')) {
    throw new Error('Cached repository identity changed; cleanup refused.')
  }
  const registered = git(base, 'worktree', 'list', '--porcelain').split(/\n\n/).some(item =>
    item.split('\n')[0] === 'worktree ' + work)
  const present = existsSync(work)
  if (registered !== present) throw new Error('Linked worktree registry and disk disagree.')
  const branch = 'refs/heads/' + job.branch
  let ref = ''
  try { ref = git(base, 'show-ref', '--verify', '--hash', branch) }
  catch (error) {
    if ((error as { status?: number }).status !== 1) throw error
  }
  if (ref && ref !== head) throw new Error('Job branch moved after deletion was reserved.')
  const statePresent = existsSync(job.stateDir)
  if (statePresent) {
    if (await realpath(job.stateDir) !== job.stateDir)
      throw new Error('Durable job state resolves through a symlink.')
    const manifest = JSON.parse(await readFile(join(job.stateDir, 'job.json'), 'utf8')) as {
      jobId?: string; branch?: string; worktreeRoot?: string; gitRoot?: string
    }
    if (manifest.jobId !== job.jobId || manifest.branch !== job.branch ||
      manifest.worktreeRoot !== work || manifest.gitRoot !== base)
      throw new Error('Saved manifest identity changed after deletion reservation.')
    const names = await readdir(job.stateDir)
    if (names.some(name => name.startsWith('.story-') || name === '.control-update'))
      throw new Error('Unexpected job writer or recovery lock; cleanup refused.')
  } else if (present || ref) {
    throw new Error('Missing durable job state while Git resources remain; inspect before retry.')
  }
  if (present) {
    if (!statePresent) throw new Error('Job has no durable manifest.')
    // Refuse staged, untracked, and ignored noncanonical files as well as active writers.
    if (await realpath(work) !== work || git(work, 'rev-parse', '--show-toplevel') !== work ||
      git(work, 'symbolic-ref', 'HEAD') !== branch ||
      git(work, 'rev-parse', 'HEAD') !== head ||
      git(work, 'rev-parse', '--path-format=absolute', '--git-common-dir') !== join(base, '.git') ||
      git(work, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored')) {
      throw new Error('Job checkout is dirty or its physical identity changed; cleanup refused.')
    }
    await withStoryJobLock(job, 'studio-delete-thread', async () => {
      // Verify again after acquiring the writer lane.
      if (git(work, 'rev-parse', 'HEAD') !== head ||
          git(work, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored'))
        throw new Error('Job changed while waiting for its writer lock.')
      git(base, 'worktree', 'remove', '--', work)
    })
  }
  // update-ref uses the captured object ID as a compare-and-delete guard.
  // Never run gc: descendants and external refs may still own shared objects.
  if (ref) git(base, 'update-ref', '-d', branch, head)
  if (!preserveReceipts && statePresent) {
    const names = await readdir(job.stateDir)
    if (names.some(name => name.startsWith('.story-') || name === '.control-update'))
      throw new Error('Job lock reappeared before state cleanup.')
    await rm(job.stateDir, { recursive: true })
  }
}

/** Two-phase deletion. Archive is always reversible; delete never is.
 * The durable reservation fences new work before unlinking anything. If Git,
 * the process lease, or the filesystem changes, the plan remains retryable. */
export async function deleteThread(store: StudioStore, owner: string, threadId: string): Promise<DeletionOutcome> {
  const catalog = store.persistence.conversations
  const record = await catalog.deletion(owner, threadId)
  if (!record) throw new Error('Thread not found.')
  if (record.completedAt) return { state: 'complete', bytes: record.bytes ?? 0,
    preservedReceipts: (JSON.parse(record.planJson ?? '{}') as { preserveReceipts?: boolean }).preserveReceipts === true }
  if (record.pendingForks) throw new Error('Unfinished child fork/restart reservation requires reconciliation.')
  if (record.externalPublications)
    throw new Error('A published review branch still references this execution; reconcile the external publication first.')
  // A live author message may be unsettled precisely because the old writer is
  // running. Request cancellation first; still refuse deletion until every
  // message and Pi delivery settles at a safe boundary.
  if (record.unsettledMessages && !record.runs.some(run =>
    run.status === 'running' || ['running', 'queued'].includes(run.queue ?? '')))
    throw new Error('Unsettled Thread continuation or Pi delivery requires reconciliation before cleanup.')
  let plan: Plan
  if (record.deletedAt) {
    if (!record.planJson) throw new Error('Deletion reservation has no physical plan.')
    plan = JSON.parse(record.planJson) as Plan
  } else {
    const resources: Resource[] = []
    const usageSummaries: Record<string, RunUsageSnapshot> = {}
    let requestedStop = false
    for (const run of record.runs) {
      const row = await store.persistence.generation.jobs.selected(owner, run.id)
      if (!row) throw new Error('Thread run disappeared during deletion preview.')
      const job = await restoreJob(row, owner)
      if (run.status === 'running' || ['running', 'queued'].includes(run.queue ?? '')) {
        await setJobControl(job, 'cancelled')
        if (run.queue === 'queued' && await dequeueBeforeStart(store, owner, run.id))
          await store.persistence.generation.jobs.cancel(owner, run.id, new Date().toISOString())
        requestedStop = true
        continue
      }
      if (run.queue === 'interrupted')
        throw new Error('Interrupted writer needs operator reconciliation before deleting its evidence.')
      usageSummaries[run.id] = await snapshotJobUsage(row, job)
      resources.push({ job, head: job.headSha,
        bytes: await bytesOnDisk(job.worktreeRoot) +
          (record.children ? 0 : await bytesOnDisk(job.stateDir)) })
    }
    if (requestedStop) return { state: 'pending',
      message: 'Cancellation requested. Retry deletion after the active writer reaches a safe boundary.' }
    plan = { version: 1, threadId, owner, resources, usageSummaries,
      preserveReceipts: record.children > 0,
      bytes: resources.reduce((sum, resource) => sum + resource.bytes, 0) }
    verifyPlan(plan, owner, threadId)
    if (!await catalog.beginDeletion(owner, threadId, record.runs.map(run => run.id),
      JSON.stringify(plan), new Date().toISOString())) {
      throw new Error('Thread execution, ancestry, or fork reservations changed; refresh before deletion.')
    }
  }
  verifyPlan(plan, owner, threadId)
  if (record.runs.some(run => run.status === 'running' ||
        ['queued', 'running', 'interrupted'].includes(run.queue ?? '')) ||
      (!plan.preserveReceipts && record.children))
    throw new Error('New active work or descendant references appeared during deletion; inspect before retrying.')
  if (JSON.stringify(record.runs.map(run => run.id)) !==
      JSON.stringify(plan.resources.map(resource => resource.job.jobId)))
    throw new Error('Run identity changed during deletion; operator reconciliation required.')
  // All jobs of one Thread share the same repository; the existing acquisition
  // lease also protects against linked-worktree creation during cleanup.
  for (const resource of plan.resources)
    await withRepositoryLock(resource.job.cacheRoot!, () =>
      removeResource(resource, plan.preserveReceipts))
  await catalog.finishDeletion(owner, threadId, new Date().toISOString(), plan.bytes)
  return { state: 'complete', bytes: plan.bytes, preservedReceipts: plan.preserveReceipts }
}
