import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchesReviewRepairResumeBoundary, matchesGuidedRepairResumeBoundary,
  matchesRepairSteeringReviewBoundary } from '../src/lib/generation-controls.server'
import type { AuthorRepairGrant } from '../../src/repair-ledger'

const sha = 'a'.repeat(40)
const valid = () => {
  const saved = {
    status: 'paused',
    reason: 'Independent reviewer rejected the specialist draft; the original writer disputes correction. An authenticated Author Choice is pending.',
    active: { stage: 'foundations', id: 'foundations' },
    result: { status: 'review-handoff', headSha: sha },
    ideaTask: null,
    ideaResult: null,
  }
  const choice = { id: 'exact-answer', workItem: 'repair-' + sha }
  const repair = {
    phase: 'awaiting-author',
    choiceId: choice.id,
    baselineHead: sha,
    sourceCommitSha: sha,
    origin: { workItem: 'world-foundations' },
  } as Parameters<typeof matchesReviewRepairResumeBoundary>[2]
  const point = {
    eligible: true,
    commitSha: sha,
    semanticReview: 'failed',
    workItem: 'world-foundations',
  } as Parameters<typeof matchesReviewRepairResumeBoundary>[3]
  return { saved, choice, repair, point }
}

test('exhausted correction guidance may re-enter only the saved original review, never its writer', () => {
  const head = 'b'.repeat(40)
  const root = sha
  const source = 'c'.repeat(40)
  const saved = { status: 'blocked',
    reason: 'Bounded original-session corrections did not pass independent rereview.',
    active: { stage: 'event', milestone: 'milestone.witness' },
    result: { status: 'event-cluster-committed', headSha: root },
    ideaTask: null, ideaResult: null,
  }
  const repair = {
    phase: 'failed' as const, rootFailureSha: root, sourceCommitSha: source,
    repairedCommitSha: head, baselineHead: head,
  }
  const grant = {
    id: 'e'.repeat(64), authorId: 'author', rootFailureSha: root,
    sourceSha: source, headSha: head, guidance: 'Correct the witness timing',
    localLimit: 3, turnLimit: 13,
  } satisfies AuthorRepairGrant
  const point = { eligible: true, commitSha: head, semanticReview: 'failed' as const,
    workItem: 'repair-' + source,
  }
  const valid = () => matchesGuidedRepairResumeBoundary(saved, repair, grant, point, head)
  assert.equal(valid(), true)
  assert.equal(matchesGuidedRepairResumeBoundary(
    { ...saved, result: { status: 'event-cluster-committed', headSha: head } },
    repair, grant, point, head), false)
  assert.equal(matchesGuidedRepairResumeBoundary(
    { ...saved, status: 'running' }, repair, grant, point, head), false)
  assert.equal(matchesGuidedRepairResumeBoundary(
    { ...saved, reason: 'Unrelated disk conflict' }, repair, grant, point, head), false)
  assert.equal(matchesGuidedRepairResumeBoundary(
    { ...saved, result: { status: 'wrong-dispatch', headSha: root } },
    repair, grant, point, head), false)
  assert.equal(matchesGuidedRepairResumeBoundary(
    { ...saved, ideaTask: { id: 'other' } },
    repair, grant, point, head), false)
  assert.equal(matchesGuidedRepairResumeBoundary(
    saved, { ...repair, phase: 'blocked' }, grant, point, head), false)
  assert.equal(matchesGuidedRepairResumeBoundary(
    saved, repair, { ...grant, sourceSha: root }, point, head), false)
  assert.equal(matchesGuidedRepairResumeBoundary(
    saved, repair, { ...grant, headSha: root }, point, head), false)
  assert.equal(matchesGuidedRepairResumeBoundary(
    saved, repair, grant, { ...point, eligible: false }, head), false)
  assert.equal(matchesGuidedRepairResumeBoundary(
    saved, repair, grant, { ...point, semanticReview: 'passed' }, head), false)
  assert.equal(matchesGuidedRepairResumeBoundary(
    saved, repair, grant, { ...point, workItem: 'event-witness' }, head), false)
  assert.equal(matchesGuidedRepairResumeBoundary(
    saved, repair, grant, point, root), false)
})

test('author scope review after a sealed failed correction cannot replay its writer', () => {
  const root = sha, previous = 'c'.repeat(40), head = 'b'.repeat(40)
  const saved = {
    status: 'paused', reason: 'Author approval required for live steering: protected decisions need exact consent.',
    active: { stage: 'event', milestone: 'milestone.witness' },
    result: { status: 'event-cluster-committed', headSha: root },
    ideaTask: null, ideaResult: null,
  }
  const repair = {
    phase: 'failed' as const, rootFailureSha: root, sourceCommitSha: previous,
    repairedCommitSha: head, baselineHead: head,
  }
  const point = { eligible: true, commitSha: head, semanticReview: 'failed' as const,
    workItem: 'repair-' + previous,
  }
  assert.equal(matchesRepairSteeringReviewBoundary(saved, repair, point, head), true)
  assert.equal(matchesRepairSteeringReviewBoundary(
    { ...saved, status: 'blocked' }, repair, point, head), false)
  assert.equal(matchesRepairSteeringReviewBoundary(
    { ...saved, result: { ...saved.result, headSha: head } },
    repair, point, head), false)
  assert.equal(matchesRepairSteeringReviewBoundary(
    saved, { ...repair, phase: 'reviewing' }, point, head), false)
  assert.equal(matchesRepairSteeringReviewBoundary(
    saved, repair, { ...point, semanticReview: 'required-pending' }, head), false)
  assert.equal(matchesRepairSteeringReviewBoundary(
    saved, repair, point, previous), false)
})

test('verified author answer re-enters the original reviewer checkpoint without clearing its in-flight result', () => {
  const { saved, choice, repair, point } = valid()
  assert.equal(matchesReviewRepairResumeBoundary(saved, choice, repair, point), true)
})

test('a committed Event review can resume its exact rejected author-choice checkpoint', () => {
  const { saved, choice, repair, point } = valid()
  const eventSaved = { ...saved,
    active: { stage: 'event', id: 'event:milestone.disclosure', milestone: 'milestone.disclosure' },
    result: { status: 'event-cluster-committed', headSha: sha } }
  repair.origin = { ...repair.origin, workItem: 'event-disclosure' }
  point.workItem = 'event-disclosure'
  assert.equal(matchesReviewRepairResumeBoundary(eventSaved, choice, repair, point), true)
  assert.equal(matchesReviewRepairResumeBoundary({ ...eventSaved,
    result: { status: 'interactive-slice-committed', headSha: sha } }, choice, repair, point), false)
  assert.equal(matchesReviewRepairResumeBoundary({ ...eventSaved,
    result: { status: 'event-cluster-committed', headSha: 'b'.repeat(40) } }, choice, repair, point), false)
  assert.equal(matchesReviewRepairResumeBoundary({ ...eventSaved,
    active: { stage: 'foundations', id: 'foundations' } }, choice, repair, point), false)
})

test('foreign, unverified, outdated or unrelated review choices cannot resume a writer', () => {
  const { saved, choice, repair, point } = valid()
  assert.equal(matchesReviewRepairResumeBoundary(saved, { ...choice, id: 'other' }, repair, point), false)
  assert.equal(matchesReviewRepairResumeBoundary(saved, { ...choice, workItem: 'world-foundations' }, repair, point), false)
  assert.equal(matchesReviewRepairResumeBoundary(saved, choice, { ...repair, phase: 'repairing' }, point), false)
  assert.equal(matchesReviewRepairResumeBoundary(saved, choice, { ...repair, baselineHead: 'b'.repeat(40) }, point), false)
  assert.equal(matchesReviewRepairResumeBoundary(saved, choice, repair, { ...point, eligible: false }), false)
  assert.equal(matchesReviewRepairResumeBoundary(saved, choice, repair, { ...point, semanticReview: 'passed' }), false)
  assert.equal(matchesReviewRepairResumeBoundary(saved, choice, repair, { ...point, workItem: 'character-foundations' }), false)
  assert.equal(matchesReviewRepairResumeBoundary({ ...saved, active: { stage: 'event' } }, choice, repair, point), false)
  assert.equal(matchesReviewRepairResumeBoundary({ ...saved, result: null }, choice, repair, point), false)
  assert.equal(matchesReviewRepairResumeBoundary({ ...saved, result: { status: 'review-handoff', headSha: 'b'.repeat(40) } }, choice, repair, point), false)
  assert.equal(matchesReviewRepairResumeBoundary({ ...saved, status: 'running' }, choice, repair, point), false)
  assert.equal(matchesReviewRepairResumeBoundary({ ...saved, ideaTask: {} }, choice, repair, point), false)
})
