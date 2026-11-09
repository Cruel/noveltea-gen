import { execFileSync, spawnSync } from 'node:child_process'
import { relative, sep } from 'node:path'
import type { JobStartResult } from '../../../src/job'
import { trustedHead } from '../../../src/revision'
import { validateStoryJob } from '../../../src/validator'
import type { StudioStore } from '../persistence/store'
import { selectedJob, restoreJob } from './fixture-jobs.server'
import { readThreadChat, enqueueThreadMessage, advanceThread } from './thread-chat.server'
import { canonicalExplorerIndex } from './story-explorer.server'
import { storyChangeOverlay, type StoryChangeKind } from './story-changes.server'

export type ReviewSelection = { kind: 'cumulative' } | { kind: 'turn'; turnId: string }
export type ReviewFile = {
  path: string; status: StoryChangeKind; recordId: string | null
  indexed: boolean
}
export type ThreadReview = {
  scope: ReviewSelection; baseSha: string; headSha: string; currentSha: string
  publicationSha: string | null; files: ReviewFile[]
}
export class ThreadReviewError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const SHA = /^[a-f0-9]{40}$/i
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

function git(job: JobStartResult, args: string[], maxBuffer = 1024 * 1024): Buffer {
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX'])
    delete env[key]
  return execFileSync('git', ['--no-pager', ...args], { cwd: job.worktreeRoot,
    env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer, timeout: 15_000 })
}
function ancestor(job: JobStartResult, before: string, after: string) {
  if (!SHA.test(before) || !SHA.test(after)) return false
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX'])
    delete env[key]
  const result = spawnSync('git', ['merge-base', '--is-ancestor', before, after],
    { cwd: job.worktreeRoot, env, timeout: 10_000, stdio: 'ignore' })
  return !result.error && result.status === 0
}
function storyPath(job: JobStartResult, path: string): string {
  const story = relative(job.worktreeRoot, job.worktreeStoryRoot)
  if (story === '..' || story.startsWith('..' + sep) || story.startsWith('/') ||
      story.includes('\\') || !path.endsWith('.md') || path.length > 1024 ||
      path.split('/').length < 2 || path.split('/').some(part =>
        !part || part === '.' || part === '..' || part.startsWith('.') || part.includes('\\')))
    throw new ThreadReviewError(409, 'Review path is not a canonical Story record.')
  return [story, path].filter(Boolean).join('/')
}
function clean(job: JobStartResult, head: string) {
  if (git(job, ['rev-parse', 'HEAD']).toString('utf8').trim() !== head ||
      git(job, ['status', '--porcelain=v1', '--untracked-files=all']).length)
    throw new ThreadReviewError(409, 'Review revision is stale or contains unverified files.')
}

/** Trust comes from the owner-scoped Thread receipt, not a supplied SHA,
 * frontend-selected Job, or a dirty working tree. All historical Git objects
 * are resolved in that exact execution's registered isolated worktree. */
async function source(store: StudioStore, owner: string, threadId: string,
  scope: ReviewSelection): Promise<{ job: JobStartResult; base: string; head: string;
    current: string; publication: string | null }> {
  if (!threadId || scope.kind === 'turn' && !scope.turnId)
    throw new ThreadReviewError(400, 'Invalid review selection.')
  const chat = await readThreadChat(store, owner, threadId)
  const eligible = chat.turnReceipts.flatMap(turn =>
    turn.executions.filter(execution =>
      execution.status === 'completed' && execution.queuePhase === 'finished' &&
      SHA.test(execution.validatedSha ?? '')).map(execution =>
      ({ turn, execution, head: execution.validatedSha! })))
  const latest = eligible.at(-1)
  if (!latest) throw new ThreadReviewError(409, 'No verified Turn is available for review.')
  const chosen = scope.kind === 'turn'
    ? eligible.filter(item => item.turn.id === scope.turnId).at(-1) : latest
  if (!chosen || scope.kind === 'turn' && chosen.turn.outcome !== 'finished')
    throw new ThreadReviewError(409, 'Requested Turn has no completed verified revision.')

  const row = await selectedJob(store, owner, chosen.execution.jobId)
  if (row.storyId !== chat.storyId) throw new ThreadReviewError(409, 'Review source Story does not match its Thread.')
  const job = await restoreJob(row, owner)
  if (job.headSha !== chosen.head || await trustedHead(job) !== chosen.head)
    throw new ThreadReviewError(409, 'Saved Turn no longer matches its verified Git checkpoint.')
  clean(job, chosen.head)
  if (chosen !== latest) {
    // Later Turns live in different worktrees. An older execution's Git object
    // database is not required to contain future commits; verify ancestry in
    // the latest registered execution instead.
    const currentRow = await selectedJob(store, owner, latest.execution.jobId)
    if (currentRow.storyId !== chat.storyId)
      throw new ThreadReviewError(409, 'Current Thread Story identity has changed.')
    const currentJob = await restoreJob(currentRow, owner)
    if (currentJob.headSha !== latest.head || await trustedHead(currentJob) !== latest.head ||
        !ancestor(currentJob, chosen.head, latest.head))
      throw new ThreadReviewError(409, 'Reviewed Turn is not an ancestor of the current Thread.')
    clean(currentJob, latest.head)
  }

  // A Turn can resume across several executions. Its review begins at the
  // original author Turn input, not the last recovery execution's input.
  let base = chosen.turn.inputSha ?? chosen.execution.inputSha
  let publication: string | null = null
  if (scope.kind === 'cumulative') {
    // The first registered baseline is the fork point for a forked Thread,
    // not an unrelated sibling's latest unpublished or published changes.
    const first = await selectedJob(store, owner, chat.runs[0]!.jobId)
    if (first.storyId !== chat.storyId) throw new ThreadReviewError(409, 'Thread baseline has changed.')
    base = first.commitSha!
    for (const run of chat.runs) {
      const published = await store.persistence.publications.get(owner, run.jobId,
        row.provider as 'github' | 'gitlab')
      if (published?.phase === 'linked' && ancestor(job, published.headSha, chosen.head)) {
        // A linked draft may have been updated from a later Turn while its
        // receipt still belongs to the original publication Job. Prefer the
        // deepest published ancestor, not the last Job in creation order.
        if (!publication || ancestor(job, publication, published.headSha))
          publication = published.headSha
        else if (!ancestor(job, published.headSha, publication))
          throw new ThreadReviewError(409, 'Published Thread revisions have diverged.')
      }
    }
    base = publication ?? base
  }
  if (!ancestor(job, base, chosen.head))
    throw new ThreadReviewError(409, 'Review baselines are not on the selected verified lineage.')
  return { job, base, head: chosen.head, current: latest.head, publication }
}

/** Materialize only committed, native-indexed Story Markdown contents.
 * Unindexed paths remain visible as path/status only; their blobs are private. */
export async function readThreadReview(store: StudioStore, owner: string, threadId: string,
  scope: ReviewSelection): Promise<ThreadReview> {
  const { job, base, head, current, publication } = await source(store, owner, threadId, scope)
  const validation = await validateStoryJob(job)
  if (validation.status !== 'passed' || validation.validator.implementation !== 'native-cli' ||
      !validation.report || (validation.report.protection as { status?: string } | undefined)?.status !== 'checked')
    throw new ThreadReviewError(409, 'Verified native Story catalog is not available for review.')
  const index = canonicalExplorerIndex(validation.report, base, head, 'passed')
  const overlay = storyChangeOverlay({ ...job, baseSha: base }, head, index.records)
  const currentByPath = new Map(index.records.map(record => [record.path, record.id]))
  const deletedByPath = new Map(overlay.deletedRecords.map(record => [record.path, record.id]))
  const files = Object.entries(overlay.byPath).filter(([, change]) => !!change.committed)
    .map(([path, change]) => {
      const recordId = currentByPath.get(path) ?? deletedByPath.get(path) ?? null
      return { path, status: change.committed!, recordId, indexed: recordId !== null }
    }).sort((a, b) => a.path.localeCompare(b.path))
  if (files.length > 1000) throw new ThreadReviewError(413, 'Review is too large; narrow the Turn scope.')
  clean(job, head)
  if (await trustedHead(job) !== head)
    throw new ThreadReviewError(409, 'Review revision changed during inspection.')
  return { scope, baseSha: base, headSha: head, currentSha: current,
    publicationSha: publication, files }
}

function checkedFile(job: JobStartResult, path: string, base: string, head: string) {
  const full = storyPath(job, path)
  for (const sha of [base, head]) {
    const entry = git(job, ['ls-tree', sha, '--', ':(literal)' + full]).toString('utf8')
    if (entry && !entry.startsWith('100644 blob '))
      throw new ThreadReviewError(409, 'Unsupported Git record entry; content is withheld.')
  }
  return full
}

export async function readThreadReviewDiff(store: StudioStore, owner: string, threadId: string,
  scope: ReviewSelection, path: string, expectedCurrentSha: string) {
  const review = await readThreadReview(store, owner, threadId, scope)
  if (expectedCurrentSha !== review.currentSha)
    throw new ThreadReviewError(409, 'Thread advanced. Refresh the review before inspecting this diff.')
  const file = review.files.find(item => item.path === path)
  if (!file) throw new ThreadReviewError(404, 'File is outside the selected verified changes.')
  if (!file.indexed) return { ...review, file, diff: null as string | null }
  const { job } = await source(store, owner, threadId, scope)
  const full = checkedFile(job, path, review.baseSha, review.headSha)
  const diff = git(job, ['diff', '--no-ext-diff', '--no-textconv', '--no-color',
    '--no-renames', '--unified=3', review.baseSha, review.headSha,
    '--', ':(literal)' + full], 256 * 1024).toString('utf8')
  clean(job, review.headSha)
  return { ...review, file, diff }
}

/** A correction is a fresh ordinary queued Turn, NOT a scope grant.
 * The trusted server reconstructs the selected hunk from pinned Git history;
 * the client can send only a bounded annotation and a hunk index. */
export async function requestThreadCorrection(store: StudioStore, owner: string,
  threadId: string, scope: ReviewSelection, path: string, hunkIndex: number | null,
  annotation: string, expectedCurrentSha: string, expectedHeadSha: string, id: string) {
  if (!UUID.test(id) || !Number.isInteger(hunkIndex) && hunkIndex !== null ||
      hunkIndex !== null && (hunkIndex < 0 || hunkIndex >= 200) ||
      !annotation.trim() || annotation.length > 1000 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(annotation))
    throw new ThreadReviewError(400, 'Invalid correction request.')
  const result = await readThreadReviewDiff(store, owner, threadId,
    scope, path, expectedCurrentSha)
  if (result.headSha !== expectedHeadSha)
    throw new ThreadReviewError(409, 'Review source changed. Refresh before correcting.')
  if (!result.file.indexed || !result.diff)
    throw new ThreadReviewError(409, 'Corrections require a verified indexed record diff.')
  const hunks = result.diff.split(/(?=^@@ )/m).slice(1)
  if (hunkIndex !== null && !hunks[hunkIndex])
    throw new ThreadReviewError(409, 'Selected hunk is no longer present.')
  const context = hunkIndex === null ? '' :
    '\nSelected diff hunk:\n' + hunks[hunkIndex]!.slice(0, 1400)
  const content = 'Correct the verified Story record ' + result.file.recordId +
    ' (' + path + ') from an earlier review.\nReview source: ' +
    result.baseSha + '..' + result.headSha + '. Current verified Thread: ' +
    result.currentSha + '.' + context + '\nRequested correction:\n' + annotation.trim()
  await enqueueThreadMessage(store, owner, threadId, id, content, 'follow-up')
  await advanceThread(store, owner, threadId)
  return { id, currentSha: result.currentSha }
}
