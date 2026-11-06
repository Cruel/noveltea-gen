import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { withStoryGenerationLock, withStoryJobLock } from '../../../src/job-lock'
import type { JobStartResult } from '../../../src/job'
import type { FinalizedTranscriptCandidate } from '../persistence/generation-contracts'
import type { StudioStore } from '../persistence/store'
import { restoreJob } from './fixture-jobs.server'
import { snapshotJobUsage, type RunUsageSnapshot } from './thread-usage.server'

const DAY_MS = 86_400_000
const RECEIPT = 'transcript-retention.json'
const PAGE = 100

/** Operator-only configuration. "off" disables automatic pruning; invalid
 * configuration fails service startup instead of silently shortening retention. */
export function transcriptRetentionDays(raw = process.env.NT_FINALIZED_TRANSCRIPT_RETENTION_DAYS): number | null {
  if (raw === undefined || raw === '') return 30
  if (raw === 'off') return null
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)) ||
      Number(raw) > 36500) throw new Error('Invalid finalized transcript retention days.')
  return Number(raw)
}

type Receipt = {
  version: 1; completedAt: string; publishedAt: string; publishedHead: string;
  usage: RunUsageSnapshot
}
function olderThan(date: string, cutoff: number): boolean {
  // Only the controller's UTC timestamps qualify; ambiguous legacy dates
  // must not silently authorize deletion.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(date)) return false
  const value = Date.parse(date)
  return Number.isFinite(value) && value <= cutoff
}
function inside(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return !!suffix && suffix !== '..' && !suffix.startsWith('..' + sep)
}
async function safeState(job: JobStartResult, ownLocks = false) {
  if (!existsSync(job.stateDir) || await realpath(job.stateDir) !== job.stateDir) return false
  const entries = await readdir(job.stateDir)
  return !entries.some(name => name.startsWith('.story-') &&
    !(ownLocks && (name === '.story-job-running' || name === '.story-generation-running')))
}

/** These receipts bind approval/conflict evidence to the exact original Pi
 * bytes. Even a completed and published job retains all its transcripts if
 * either class exists; expiry must never invalidate protected evidence. */
async function transcriptBoundEvidence(job: JobStartResult) {
  if (existsSync(join(job.stateDir, 'foundation-conflict.json'))) return true
  const choices = join(job.stateDir, 'specialist-choices')
  if (!existsSync(choices)) return false
  if (!(await lstat(choices)).isDirectory() || await realpath(choices) !== choices) return true
  return (await readdir(choices)).some(name => name.endsWith('.json'))
}

async function transcriptFiles(job: JobStartResult): Promise<string[]> {
  const files: string[] = []
  async function walk(dir: string): Promise<void> {
    if (await realpath(dir) !== dir) throw new Error('Unsafe transcript directory.')
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (!inside(job.stateDir, path) || entry.isSymbolicLink())
        throw new Error('Unsafe transcript entry.')
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.jsonl')) {
        if (!entry.isFile() || await realpath(path) !== path)
          throw new Error('Unsafe transcript file.')
        files.push(path)
      }
    }
  }
  for (const entry of await readdir(job.stateDir, { withFileTypes: true })) {
    // Known Pi session roots only. Other state (receipts, author approvals,
    // SQLite checkpoints, worktree, local traces) is never part of this sweep.
    if (entry.name !== 'sessions' && !entry.name.endsWith('-sessions')) continue
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('Unsafe session root.')
    await walk(join(job.stateDir, entry.name))
  }
  return files
}
function worktreeIsClean(job: JobStartResult, head: string): boolean {
  if (!/^[a-f0-9]{40}$/i.test(head) || job.headSha !== head) return false
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  for (const key of Object.keys(env)) {
    if ((key.startsWith('GIT_CONFIG_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(key)) ||
      key.startsWith('GIT_TRACE') ||
      ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX'].includes(key))
      delete env[key]
  }
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: job.worktreeRoot, env, encoding: 'utf8', timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  return git('rev-parse', 'HEAD') === head &&
    git('status', '--porcelain=v1', '--untracked-files=all', '--ignored') === ''
}
async function eligible(store: StudioStore, candidate: FinalizedTranscriptCandidate, cutoff: number) {
  if (!olderThan(candidate.completedAt, cutoff) || !olderThan(candidate.publishedAt, cutoff))
    return false
  const row = await store.persistence.generation.jobs.selected(candidate.owner, candidate.jobId)
  if (!row || row.status !== 'completed' || !row.requestJson) return false
  // A fresh owner-scoped join, not a stale candidate or path from a client,
  // is the maintenance authorization for this job and linked publication.
  const current = await store.persistence.generation.jobs.finalizedTranscriptCandidate(
    candidate.owner, candidate.jobId)
  if (JSON.stringify(current) !== JSON.stringify(candidate)) return false
  const thread = await store.persistence.conversations.deletion(candidate.owner, candidate.threadId)
  if (!thread || thread.deletedAt || thread.completedAt || thread.children ||
      thread.pendingForks || thread.unsettledMessages ||
      thread.runs.some(run => run.status !== 'completed' || run.queue !== 'finished'))
    return false
  return true
}

async function prune(store: StudioStore, candidate: FinalizedTranscriptCandidate, cutoff: number) {
  if (!await eligible(store, candidate, cutoff)) return 0
  const saved = await store.persistence.generation.jobs.selected(candidate.owner, candidate.jobId)
  if (!saved) return 0
  const job = await restoreJob(saved, candidate.owner)
  if (!await safeState(job)) return 0
  return withStoryGenerationLock(job, () => withStoryJobLock(job, 'transcript-retention', async () => {
    if (!await safeState(job, true) || !await eligible(store, candidate, cutoff) ||
        !worktreeIsClean(job, candidate.publishedHead) || await transcriptBoundEvidence(job))
      return 0
    // A missing or redirected LangGraph checkpoint makes the execution's
    // recovery provenance uncertain, regardless of its catalog status.
    const checkpoint = join(job.stateDir, 'web-generation.sqlite')
    if (!existsSync(checkpoint) || !(await lstat(checkpoint)).isFile() ||
        await realpath(checkpoint) !== checkpoint) return 0
    // Fully enumerate/verify targets before deleting any bytes. Never follow
    // links into another owner or into retained durable metadata.
    const files = await transcriptFiles(job)
    if (!files.length) return 0
    const receiptPath = join(job.stateDir, RECEIPT)
    let receipt: Receipt
    if (existsSync(receiptPath)) {
      if (!(await lstat(receiptPath)).isFile() || await realpath(receiptPath) !== receiptPath)
        return 0
      receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Receipt
      if (receipt.version !== 1 || receipt.publishedHead !== candidate.publishedHead ||
          receipt.completedAt !== candidate.completedAt ||
          receipt.publishedAt !== candidate.publishedAt ||
          receipt.usage.version !== 1 || receipt.usage.origin === 'unavailable') return 0
    } else {
      const usage = await snapshotJobUsage(saved, job)
      if (usage.origin === 'unavailable') return 0
      receipt = { version: 1, completedAt: candidate.completedAt,
        publishedAt: candidate.publishedAt, publishedHead: candidate.publishedHead, usage }
      const tmp = receiptPath + '.' + randomUUID() + '.tmp'
      await writeFile(tmp, JSON.stringify(receipt) + '\n', { mode: 0o600, flag: 'wx' })
      await rename(tmp, receiptPath)
    }
    // Complete jobs cannot resume their original writer; checkpoint forks use
    // immutable stage/Git proof, not these mutable prior Pi conversations.
    for (const file of files) await unlink(file)
    return files.length
  }))
}

/** Runs only in the trusted agent process, never an HTTP handler or sandbox.
 * A failed/missing/tampered job is conservatively skipped without disclosing
 * its paths or transcript contents to API clients or process logs. */
export async function cleanFinalizedTranscripts(store: StudioStore, now = Date.now()): Promise<number> {
  const days = transcriptRetentionDays()
  if (days === null) return 0
  const cutoff = now - days * DAY_MS
  let removed = 0
  for (let offset = 0; ; offset += PAGE) {
    const candidates = await store.persistence.generation.jobs.finalizedTranscriptCandidates(PAGE, offset)
    for (const candidate of candidates) {
      try { removed += await prune(store, candidate, cutoff) }
      catch { /* Preserve ambiguous job state; no sensitive filesystem errors in logs. */ }
    }
    if (candidates.length < PAGE) break
  }
  return removed
}
