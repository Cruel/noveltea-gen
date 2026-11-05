import { randomUUID } from 'node:crypto'
import { lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StudioDatabase } from '../db/connection'
import type { JobStartResult } from '../../../src/job'
import { runRevisionAction } from '../../../src/revision'
import { requestTrustedApproval, recordTrustedControllerDecision } from '../../../src/trusted-approval'
import type { ProtectedDecisionChange, RevisionPreview } from './story-revision-plan'
import { ThreadChatError } from './thread-chat.server'

const SHA = /^[a-f0-9]{40}$/
const DIGEST = /^[a-f0-9]{64}$/
const workItem = 'thread-protected'
type Receipt = {
  messageId: string; owner: string; threadId: string; sourceJobId: string; sourceSha: string
  digest: string; changeJson: string; nonce: string; decision: 'approved' | 'rejected'
  principal: string; recordedAt: string; consumedSha: string | null
}

const receiptQuery = `SELECT message_id AS messageId,owner_user_id AS owner,
  thread_id AS threadId,source_job_id AS sourceJobId,source_sha AS sourceSha,
  proposal_sha256 AS digest,change_json AS changeJson,nonce,decision,
  principal,recorded_at AS recordedAt,consumed_sha AS consumedSha
  FROM thread_protected_decisions WHERE message_id=?`

function matching(receipt: Receipt, owner: string, threadId: string, messageId: string,
  sourceJobId: string, plan: RevisionPreview): boolean {
  return receipt.messageId === messageId && receipt.owner === owner &&
    receipt.threadId === threadId && receipt.sourceJobId === sourceJobId &&
    receipt.sourceSha === plan.headSha && receipt.digest === plan.digest &&
    receipt.changeJson === JSON.stringify(plan.protectedChange) &&
    receipt.principal === 'user:' + owner &&
    DIGEST.test(receipt.digest) && SHA.test(receipt.sourceSha) &&
    /^[0-9a-f-]{36}$/i.test(receipt.nonce)
}

/** No caller-supplied principal or inline digest grants consent. This is only
 * called by an authenticated POST handler after a fresh canonical preview.
 * A denial creates no Git job, worktree, or Story mutation. */
export function recordProtectedThreadDecision(store: StudioDatabase, owner: string,
  threadId: string, messageId: string, sourceJobId: string, plan: RevisionPreview,
  decision: 'approved' | 'rejected') {
  if (!plan.protectedChange || !DIGEST.test(plan.digest) || !SHA.test(plan.headSha))
    throw new ThreadChatError(409, 'There is no exact protected decision proposal to review.')
  return store.sqlite.transaction(() => {
    const message = store.sqlite.prepare(`SELECT body,phase FROM story_thread_messages
      WHERE id=? AND owner_user_id=? AND thread_id=? AND role='user'
        AND NOT EXISTS (SELECT 1 FROM story_thread_message_cancellations c
          WHERE c.message_id=story_thread_messages.id)`).get(messageId, owner, threadId) as
      { body: string; phase: string } | undefined
    const head = store.sqlite.prepare(`SELECT id FROM story_thread_messages
      WHERE owner_user_id=? AND thread_id=? AND role='user'
        AND phase IN ('queued','preparing','running','blocked')
        AND NOT EXISTS (SELECT 1 FROM story_thread_message_cancellations c
          WHERE c.message_id=story_thread_messages.id)
      ORDER BY sequence LIMIT 1`).get(owner, threadId) as { id: string } | undefined
    const run = store.sqlite.prepare(`SELECT r.job_id AS id,j.status,q.phase FROM story_thread_runs r
      JOIN studio_sessions j ON j.id=r.job_id AND j.owner_user_id=r.owner_user_id
      JOIN generation_run_queue q ON q.job_id=j.id AND q.owner_user_id=j.owner_user_id
      WHERE r.thread_id=? AND r.owner_user_id=? ORDER BY r.run_order DESC LIMIT 1`)
      .get(threadId, owner) as { id: string; status: string; phase: string } | undefined
    if (!message || message.body !== plan.request || message.phase !== 'queued' ||
        head?.id !== messageId || run?.id !== sourceJobId ||
        run.status !== 'completed' || run.phase !== 'finished')
      throw new ThreadChatError(409, 'Protected decision review is no longer the queued instruction at its verified source.')
    const existing = store.sqlite.prepare(receiptQuery).get(messageId) as Receipt | undefined
    if (existing) {
      if (!matching(existing, owner, threadId, messageId, sourceJobId, plan) ||
          existing.decision !== decision)
        throw new ThreadChatError(409, 'This instruction already has a different or stale protected decision receipt.')
      return { decision: existing.decision, digest: existing.digest }
    }
    store.sqlite.prepare(`INSERT INTO thread_protected_decisions
      (message_id,owner_user_id,thread_id,source_job_id,source_sha,proposal_sha256,
       change_json,nonce,decision,principal,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(messageId, owner, threadId, sourceJobId, plan.headSha, plan.digest,
        JSON.stringify(plan.protectedChange), randomUUID(), decision,
        'user:' + owner, new Date().toISOString())
    return { decision, digest: plan.digest }
  })()
}

/** The controller-owned DB is authoritative, not the browser's scope digest,
 * a copied parent approval or any model-provided signed-looking payload. */
export function assertProtectedThreadApproval(store: StudioDatabase, owner: string,
  threadId: string, messageId: string, sourceJobId: string, plan: RevisionPreview): Receipt {
  const receipt = store.sqlite.prepare(receiptQuery).get(messageId) as Receipt | undefined
  if (!receipt || !matching(receipt, owner, threadId, messageId, sourceJobId, plan) ||
      receipt.decision !== 'approved' || receipt.consumedSha)
    throw new ThreadChatError(409, 'This protected decision needs fresh, exact approval by the current Thread owner.')
  return receipt
}

function replacement(original: string, change: ProtectedDecisionChange): { bytes: string; line: number } {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(original)
  if (!match) throw new Error('Protected change requires canonical frontmatter.')
  const frontmatter = match[2]!
  const id = change.decision.split('#')[1]
  if (!id || !/^[a-z][a-z0-9-]*$/.test(id) || !frontmatter.includes('decisions:'))
    throw new Error('Protected decision identity is missing from canonical frontmatter.')
  const sections = frontmatter.split(/(?=^  - id:)/m)
  const hits = sections.map((part, index) => ({ part, index })).filter(({ part }) =>
    new RegExp('^  - id:\\s*(?:["\\\']?)' + id + '(?:["\\\']?)\\s*$', 'm').test(part))
  if (hits.length !== 1) throw new Error('Protected decision ID is missing or ambiguous.')
  const block = hits[0]!.part
  if (!/^    origin:\s*(?:user|"user"|'user')\s*$/m.test(block) ||
      !/^    authority:\s*(?:user-protected|"user-protected"|'user-protected')\s*$/m.test(block))
    throw new Error('The target is no longer an author-protected decision.')
  const lineMatch = /^    statement: (.*)$/m.exec(block)
  if (!lineMatch) throw new Error('Protected decision statement must be a single YAML scalar.')
  const raw = lineMatch[1]!.trim()
  let value: string
  if (raw.startsWith('"')) {
    try { value = JSON.parse(raw) as string }
    catch { throw new Error('Protected decision scalar is not safely editable.') }
  } else if (/^'(?:[^']|'')*'$/.test(raw)) {
    value = raw.slice(1, -1).replace(/''/g, "'")
  } else if (raw && !/[#\\[\\]{}&*!|>]/.test(raw)) {
    value = raw
  } else throw new Error('Protected decision scalar is not safely editable.')
  if (value !== change.before)
    throw new Error('Protected decision statement no longer matches the exact reviewed baseline.')
  const changedBlock = block.replace(lineMatch[0], '    statement: ' + JSON.stringify(change.after))
  const changedFrontmatter = sections.map((part, index) =>
    index === hits[0]!.index ? changedBlock : part).join('')
  const bytes = original.replace(match[0], match[1] + changedFrontmatter + match[3])
  const statementOffset = match[1]!.length + frontmatter.indexOf(block) +
    block.indexOf(lineMatch[0])
  const line = original.slice(0, statementOffset).split(/\r?\n/).length
  return { bytes, line }
}

async function approvalReference(job: JobStartResult, id: string, nonce: string,
  action: 'authorize' | 'review', digest: string) {
  const file = join(job.stateDir, 'thread-protected-' + action + '.json')
  await writeFile(file, JSON.stringify({ receiptId: id, nonce }), { mode: 0o600, flag: 'wx' })
  try {
    return await runRevisionAction({ story: job.storyRoot, job: job.jobId,
      workItem, action, proposal: digest, approvalFile: file })
  } finally { await rm(file, { force: true }) }
}

/** No Pi writer can modify the approved Creative Direction. A trusted web
 * controller applies the single exact text delta in an isolated child, asks
 * the native validator to enumerate every protected change, then issues
 * *child-job-scoped* ledger receipts before committing through revision.ts.
 * All preflight failures preserve the child for operator inspection. */
export async function commitProtectedThreadChange(job: JobStartResult, change: ProtectedDecisionChange,
  actor: string) {
  if (!/^creative-direction\/[a-z][a-z0-9-]*\.md$/.test(change.path) ||
      !/^creative-direction\.[a-z][a-z0-9-]*#[a-z][a-z0-9-]*$/.test(change.decision))
    throw new Error('Only an exact Creative Direction decision may be amended.')
  const path = join(job.worktreeStoryRoot, change.path)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path)
    throw new Error('Protected revision target is not a real regular Story file.')
  const old = await readFile(path, 'utf8')
  const edited = replacement(old, change)
  await writeFile(path, edited.bytes)
  const proposal = await runRevisionAction({ story: job.storyRoot, job: job.jobId,
    workItem, action: 'inspect', path: change.path })
  const deltas = proposal.protectedChanges
  if (deltas.length !== 1 || deltas[0]!.decision !== change.decision ||
      deltas[0]!.kind !== 'changed' || deltas[0]!.path !== change.path ||
      (deltas[0]!.before as { statement?: unknown })?.statement !== change.before ||
      (deltas[0]!.after as { statement?: unknown })?.statement !== change.after ||
      proposal.unrelatedUncommittedPaths.length)
    throw new Error('Native Git/validator protected diff is not exactly the author-reviewed change.')
  const changeReceipt = await requestTrustedApproval(job, {
    id: 'thread-protected-decision', kind: 'decision', workItemId: workItem,
    changeId: deltas[0]!.id,
  })
  const recorded = await recordTrustedControllerDecision(job, {
    id: changeReceipt.id, nonce: changeReceipt.nonce, proposalSha256: proposal.proposalSha256,
  }, 'approved', { source: 'trusted-web', principal: 'user:' + actor })
  await approvalReference(job, recorded.id, recorded.nonce, 'authorize', proposal.proposalSha256)
  const editorial = await requestTrustedApproval(job, {
    id: 'thread-protected-editorial', kind: 'editorial', workItemId: workItem,
    payload: {
      version: 1, kind: 'editorial', workItemId: workItem, jobId: job.jobId,
      threadId: job.threadId, baseSha: job.baseSha, verifiedHead: proposal.verifiedHead,
      proposalSha256: proposal.proposalSha256, verdict: 'pass',
      evidence: change.path + ':' + edited.line,
      notes: 'The author reviewed the exact before/after protected statement against the pinned baseline; only this one decision may change.',
    },
  })
  const editorialReceipt = await recordTrustedControllerDecision(job, {
    id: editorial.id, nonce: editorial.nonce, proposalSha256: proposal.proposalSha256,
  }, 'approved', { source: 'trusted-web', principal: 'user:' + actor })
  await approvalReference(job, editorialReceipt.id, editorialReceipt.nonce, 'review', proposal.proposalSha256)
  const committed = await runRevisionAction({ story: job.storyRoot, job: job.jobId,
    workItem, action: 'commit', proposal: proposal.proposalSha256 })
  if (committed.status !== 'committed' || !committed.commitSha || !SHA.test(committed.commitSha))
    throw new Error('Protected decision was not committed by the verified revision graph.')
  return committed.commitSha
}

export function markProtectedThreadConsumed(store: StudioDatabase, owner: string,
  messageId: string, sha: string) {
  if (!SHA.test(sha) || store.sqlite.prepare(`UPDATE thread_protected_decisions
    SET consumed_sha=? WHERE message_id=? AND owner_user_id=? AND decision='approved'
      AND consumed_sha IS NULL`).run(sha, messageId, owner).changes !== 1)
    throw new Error('Protected approval was already consumed or its commit identity changed.')
}

/** A protected-only child has a native revision receipt instead of a Pi graph.
 * Preserve this distinction: completion is not evidence of an agent run. */
export async function inspectProtectedThreadCompletion(store: StudioDatabase, owner: string,
  job: JobStartResult): Promise<boolean> {
  const receipt = store.sqlite.prepare(receiptQuery).get(job.jobId) as Receipt | undefined
  if (!receipt) return false
  if (receipt.owner !== owner || receipt.decision !== 'approved' ||
      !receipt.consumedSha || receipt.consumedSha !== job.headSha ||
      receipt.principal !== 'user:' + owner || !SHA.test(receipt.sourceSha) ||
      receipt.sourceSha !== job.baseSha)
    throw new Error('Protected Thread completion has stale or mismatched owner/Git authorization.')
  const status = await runRevisionAction({ story: job.storyRoot, job: job.jobId,
    workItem, action: 'status', proposal: '' })
  if (status.status !== 'committed' || status.commitSha !== receipt.consumedSha ||
      status.protectedChanges.length !== 1 ||
      status.protectedChanges[0]!.decision !==
        (JSON.parse(receipt.changeJson) as ProtectedDecisionChange).decision ||
      status.protectedChanges[0]!.authorization !== 'approved')
    throw new Error('Protected Thread revision receipts do not prove the exact authorized Git commit.')
  return true
}
