import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JobStartResult } from '../../../src/job'
import { trustedHead } from '../../../src/revision'
import { validateStoryJob } from '../../../src/validator'
import { gitEnvironment } from './git-cache.server'
import { queueRecord } from './generation-queue.server'
import type { StudioDatabase } from '../db/connection'

const SHA = /^[a-f0-9]{40}$/i
export class PublicationFailure extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
export type PublicationSource = {
  repository: string; directory: string; initialContentSha256: string | null
  remoteUrl: string
}
export type PublicationLink = { number: number; url: string; headSha: string; targetBranch: string }
export type PublicationPreview = {
  jobId: string; headSha: string; baseSha: string; branch: string
  targetBranch: string; targetSha: string; validation: string
  diagnostics: unknown[]; protection: string; merge: 'clean' | 'conflicts' | 'not-assessed'
  blockers: string[]; canPublish: boolean; linked: PublicationLink | null
}

/** Trusted Git invocation with child-only credentials and suppressed transport diagnostics. */
export function publicationGit(job: JobStartResult, source: PublicationSource, token: string,
  args: string[], allowNonzero = false): { output: string; code: number } {
  const env = gitEnvironment(source.remoteUrl, token)
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[key]
  const run = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: job.worktreeRoot, env, encoding: 'utf8', timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (run.error || run.signal || (run.status !== 0 && !allowNonzero)) {
    throw new PublicationFailure(409, 'Git publication operation failed. Recheck provider authorization and preserve the job branch.')
  }
  return { output: run.stdout.trim(), code: run.status ?? 1 }
}
export function gitOutput(job: JobStartResult, source: PublicationSource, token: string, ...args: string[]) {
  return publicationGit(job, source, token, args).output
}
export function remotePublicationHead(job: JobStartResult, source: PublicationSource, token: string, branch: string) {
  const result = publicationGit(job, source, token, ['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/' + branch], true)
  if (result.code === 2) return null
  if (result.code !== 0) throw new PublicationFailure(409, 'Unable to inspect the remote job branch.')
  const match = /^([a-f0-9]{40})\s+refs\/heads\/(.+)$/.exec(result.output)
  if (!match || match[2] !== branch) throw new PublicationFailure(409, 'Unexpected remote branch identity.')
  return match[1]!
}
export function safeDefaultBranch(branch: unknown): asserts branch is string {
  if (typeof branch !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,190}$/.test(branch) ||
      branch.split('/').some(part => !part || part === '.' || part === '..' || part.endsWith('.lock')) ||
      branch.endsWith('.') || branch.includes('..') || branch.includes('@{'))
    throw new PublicationFailure(409, 'Provider default branch is not a safe Git ref.')
}
async function verifiedHead(job: JobStartResult, source: PublicationSource, token: string) {
  try { return await trustedHead(job) } catch {
    // A GitHub onboarding draft predates normal generation receipts. Recreate
    // no authority: require the saved digest and exact original one-commit diff.
    if (!source.initialContentSha256 || !/^[a-f0-9]{64}$/.test(source.initialContentSha256) ||
        existsSync(join(job.stateDir, 'revisions', 'verified-head.json')) ||
        existsSync(join(job.stateDir, 'foundation.json'))) {
      throw new PublicationFailure(409, 'Job HEAD lacks trusted revision evidence.')
    }
    const head = gitOutput(job, source, token, 'rev-parse', 'HEAD')
    const path = [source.directory, 'creative-direction/foundation.md'].filter(Boolean).join('/')
    const changed = gitOutput(job, source, token, 'diff', '--name-only', job.baseSha, head)
    const presentAtBase = gitOutput(job, source, token, 'ls-tree', '--name-only', job.baseSha, '--', path)
    if (presentAtBase || changed !== path ||
        gitOutput(job, source, token, 'rev-list', '--count', job.baseSha + '..' + head) !== '1')
      throw new PublicationFailure(409, 'Initialization differs from its saved single-commit draft.')
    const file = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'show', 'HEAD:' + path], {
      cwd: job.worktreeRoot, env: gitEnvironment(source.remoteUrl, token),
      maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (file.status !== 0 || createHash('sha256').update(file.stdout).digest('hex') !== source.initialContentSha256)
      throw new PublicationFailure(409, 'Initialization content differs from the saved digest.')
    return head
  }
}
async function completedReview(job: JobStartResult, head: string) {
  try {
    const review = JSON.parse(await readFile(join(job.stateDir, 'narrative-review.json'), 'utf8')) as {
      version?: number; jobId?: string; branch?: string; headSha?: string; phase?: string
    }
    return review.version === 1 && review.jobId === job.jobId &&
      review.branch === job.branch && review.headSha === head && review.phase === 'completed'
  } catch { return false }
}

/** Same author-review contract for GitHub and GitLab; no merge or rebase. */
export async function reviewPublication(store: StudioDatabase, job: JobStartResult,
  source: PublicationSource, token: string, targetBranch: string, targetSha: string,
  linked: PublicationLink | null): Promise<PublicationPreview> {
  const queue = queueRecord(store, job.jobId)
  if (queue && ['queued', 'running', 'interrupted'].includes(queue.phase))
    throw new PublicationFailure(409, 'Generation is queued, running or interrupted. Reconcile the writer before publication.')
  if (gitOutput(job, source, token, 'config', '--local', '--get', 'remote.origin.url') !== source.remoteUrl)
    throw new PublicationFailure(409, 'Cached Git origin differs from the authorized provider repository.')
  if (gitOutput(job, source, token, 'rev-parse', 'HEAD') !== job.headSha)
    throw new PublicationFailure(409, 'Job HEAD changed during inspection. Refresh before retrying.')
  const head = await verifiedHead(job, source, token)
  const blockers: string[] = []
  if (gitOutput(job, source, token, 'status', '--porcelain=v1', '--untracked-files=all'))
    blockers.push('Uncommitted changes remain in the job worktree.')
  if (head === job.baseSha) blockers.push('No committed Story changes to publish.')
  let validation = 'not-run'
  let protection = 'unverified'
  let diagnostics: unknown[] = []
  if (!blockers.length) {
    const result = await validateStoryJob(job, process.env.NT_STUDIO_SKILLS_SOURCE)
    validation = result.status
    protection = (result.report?.protection as { status?: string } | undefined)?.status ?? 'unverified'
    diagnostics = Array.isArray(result.report?.diagnostics) ? result.report.diagnostics : []
    const baseFiles = gitOutput(job, source, token, 'ls-tree', '-r', '--name-only',
      job.baseSha, '--', job.storyRelativePath || '.')
    const emptyBase = !baseFiles.split('\n').some(file => file.endsWith('.md'))
    const hasErrors = diagnostics.some(d => d && typeof d === 'object' &&
      'severity' in d && (d as { severity: unknown }).severity === 'error')
    if (result.status !== 'passed' &&
        !(emptyBase && result.status === 'unverified' && !hasErrors && result.report))
      blockers.push('Canonical Story validation did not pass; resolve diagnostics before publication.')
    if (protection !== 'checked') {
      if (emptyBase && result.status === 'unverified' && !hasErrors)
        blockers.push('The pinned baseline has no Story Markdown; protected decisions cannot be compared.')
      else blockers.push('Canonical protected-decision verification is not checked.')
    }
  }
  if (!await completedReview(job, head))
    blockers.push('Full scoped completion review is absent or stale; draft is partial.')
  let merge: PublicationPreview['merge'] = 'clean'
  if (targetSha !== job.baseSha) {
    blockers.push('Upstream changed since the pinned job baseline; no automatic merge or rebase.')
    blockers.push('Merged Story semantics and canonical protection against the new upstream have not been certified.')
    try {
      gitOutput(job, source, token, 'fetch', '--no-tags', '--filter=blob:none', 'origin', 'refs/heads/' + targetBranch)
      if (gitOutput(job, source, token, 'rev-parse', 'FETCH_HEAD') !== targetSha)
        throw new PublicationFailure(409, 'Upstream moved during fetch.')
      const probe = publicationGit(job, source, token, ['merge-tree', '--write-tree', targetSha, head], true)
      merge = probe.code === 0 ? 'clean' : probe.code === 1 ? 'conflicts' : 'not-assessed'
    } catch { merge = 'not-assessed' }
    if (merge !== 'clean') blockers.push(merge === 'conflicts'
      ? 'Git merge conflicts need author reconciliation before merge.'
      : 'Git merge compatibility could not be assessed.')
  }
  const hard = blockers.some(b => b.startsWith('Uncommitted') || b.startsWith('No committed') ||
    b.startsWith('Canonical Story validation') || b.startsWith('Canonical protected-decision'))
  return { jobId: job.jobId, headSha: head, baseSha: job.baseSha, branch: job.branch,
    targetBranch, targetSha, validation, diagnostics, protection, merge,
    blockers, canPublish: !hard, linked }
}
export function publicationDescription(job: JobStartResult, view: PublicationPreview) {
  return [
    'NovelTea Story draft generated from a pinned, verified job revision.',
    '', 'Job: `' + job.jobId + '`', 'Base commit: `' + job.baseSha + '`',
    'Verified head: `' + view.headSha + '`',
    'Canonical validation: ' + view.validation + ' (protection: ' + view.protection + ')',
    'Merge preview: ' + view.merge, '', 'Outstanding blockers / review obligations:',
    ...(view.blockers.length ? view.blockers.map(b => '- ' + b) : ['- None reported; human review is still required.']),
    '', 'Draft only. No automatic merge, rebase or protected-decision approval.',
  ].join('\n')
}
export function pushVerifiedBranch(job: JobStartResult, source: PublicationSource,
  token: string, head: string) {
  const remote = remotePublicationHead(job, source, token, job.branch)
  if (remote && remote !== head && publicationGit(job, source, token,
    ['merge-base', '--is-ancestor', remote, head], true).code !== 0)
    throw new PublicationFailure(409, 'Remote job branch diverged. Never force-push or overwrite it.')
  if (remote !== head) {
    gitOutput(job, source, token, 'push', 'origin', 'HEAD:refs/heads/' + job.branch)
    if (remotePublicationHead(job, source, token, job.branch) !== head)
      throw new PublicationFailure(409, 'Remote push outcome is uncertain; retry to reconcile the branch.')
  }
}
export async function readPublicationRequest(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) throw new PublicationFailure(400, 'Missing publication request.')
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 2048) throw new PublicationFailure(413, 'Publication request is too large.')
      parts.push(value)
    }
  } finally { reader.releaseLock() }
  let input: { headSha?: string; targetSha?: string; allowPartial?: boolean }
  try { input = JSON.parse(Buffer.concat(parts).toString('utf8')) }
  catch { throw new PublicationFailure(400, 'Invalid publication request.') }
  if (!SHA.test(input?.headSha ?? '') || !SHA.test(input?.targetSha ?? '') ||
      (input.allowPartial !== undefined && typeof input.allowPartial !== 'boolean'))
    throw new PublicationFailure(400, 'Provide exact preview HEADs and confirmation.')
  return input
}
