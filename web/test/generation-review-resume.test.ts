import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchesReviewRepairResumeBoundary } from '../src/lib/generation-controls.server'

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

test('verified author answer re-enters the original reviewer checkpoint without clearing its in-flight result', () => {
  const { saved, choice, repair, point } = valid()
  assert.equal(matchesReviewRepairResumeBoundary(saved, choice, repair, point), true)
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
