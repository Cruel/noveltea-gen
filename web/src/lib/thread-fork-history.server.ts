import { execFileSync } from 'node:child_process'
import type { StudioStore as StudioDatabase } from '../persistence/store'
import type { JobStartResult } from '../../../src/job'

type Message = {
  id: string; role: 'user' | 'assistant'; status: 'delivered' | 'queued'
  body: string; origin: string | null; verifiedSha: string | null; createdAt: string
}
export type ForkHistoryMessage = {
  role: 'user' | 'assistant'; body: string; originId: string; verifiedSha: string; createdAt: string
}
const SHA = /^[a-f0-9]{40}$/

/** Freeze parent messages at fork request admission, BEFORE allocating a child.
 * The snapshot is stored with the idempotency intent: a parent can keep
 * receiving messages and committing work during child Git preparation. */
export async function snapshotForkBoundaryHistory(store: StudioDatabase, owner: string,
  parentThreadId: string, sourceJob: JobStartResult, sourceTask: string,
  sourceCreatedAt: string, forkSha: string, beforeSequence?: number, beforeRunOrder?: number): Promise<ForkHistoryMessage[]> {
  const rows = await store.persistence.advancedThreads.history(
    owner, parentThreadId, beforeSequence, beforeRunOrder)

  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[key]
  const ancestor = (sha: string) => {
    if (!SHA.test(sha)) return false
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, forkSha], {
        cwd: sourceJob.worktreeRoot, env, stdio: 'ignore',
      })
      return true
    } catch { return false }
  }
  const inherited = rows.filter(row => row.status === 'delivered' &&
    !!row.verifiedSha && ancestor(row.verifiedSha))
  // Pre-conversation jobs have a pinned request but no conversation messages.
  // Represent it only in the child: the live parent is never mutated by a fork.
  // #81 can materialize the pre-conversation request as a delivered chat
  // message before that historical run has an attributable message receipt.
  // Such unverified rows must not suppress the original pinned-request fallback.
  const canUsePinnedRequest = rows.every(row => !row.verifiedSha)
  const history = inherited.length ? inherited : beforeSequence === undefined && canUsePinnedRequest ? [{
    id: 'request:' + sourceJob.jobId, role: 'user' as const, body: sourceTask,
    origin: null, verifiedSha: sourceJob.baseSha, createdAt: sourceCreatedAt,
  }] : []
  return history.map(message => ({
    role: message.role, body: message.body, originId: message.origin ?? message.id,
    verifiedSha: message.verifiedSha!, createdAt: message.createdAt,
  }))
}

/** Standalone verified-history import for preexisting child Threads. New forks
 * import this history atomically as part of child registration instead. */
export async function recordForkBoundaryHistory(store: StudioDatabase, owner: string, childThreadId: string,
  history: ForkHistoryMessage[], guidance: string, now: string): Promise<void> {
  await store.persistence.advancedThreads.importHistory(owner, childThreadId, history, guidance, now)
}
