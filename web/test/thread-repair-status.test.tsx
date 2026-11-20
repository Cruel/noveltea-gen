import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadRepairContent } from '../src/components/thread-repair-content'
import type { JobControls } from '../src/lib/jobs.functions'

const sha = (letter: string) => letter.repeat(40)
function render(repair: NonNullable<JobControls['repair']>,
  status: string, reason: string | null = 'Independent review correction stopped for nonconvergence.',
  budgetPause?: string, queue?: string | null) {
  return renderToStaticMarkup(createElement(ThreadRepairContent, {
    repair, status, reason, budgetPause, queue, onContinue: async () => {},
  }))
}
const repair: NonNullable<JobControls['repair']> = {
  attempts: 2,
  findings: [{
    id: 'finding-1', type: 'continuity', specialist: 'event-witness',
    outcome: 'Witness testimony supports the discovery', paths: ['events/witness.md'],
    status: 'open', sourceSha: sha('a'), reviewDigest: 'f'.repeat(64),
    attempts: 2,
    message: 'The witness appears after the deduction.',
    requiredCorrection: 'Present witness testimony before the deduction.',
  }],
  prerequisites: [], recent: [{ sourceSha: sha('b'), paths: ['events/witness.md'],
    outcome: 'failed', successorSha: sha('c') }],
  continuation: { sourceSha: sha('b'), rootSha: sha('a'),
    reviewedSha: sha('c'), remainingGrants: 2 },
}

test('paused nonconvergent repair offers authenticated editorial guidance and sealed findings', () => {
  const html = render(repair, 'blocked')
  assert.match(html, /Review correction paused/)
  assert.match(html, /2 completed Turn corrections/)
  assert.match(html, /continuity/)
  assert.match(html, /event-witness/)
  assert.match(html, /2 attempts/)
  assert.match(html, /The witness appears after the deduction/)
  assert.match(html, /Present witness testimony before the deduction/)
  assert.match(html, /events\/witness\.md/)
  assert.match(html, /review ffffffffffff/)
  assert.match(html, /Continue with another correction/)
  assert.doesNotMatch(html, /PRIVATE_PI_TRANSCRIPT/)
})

test('crash between author grant and queue admission retains resume without another grant', () => {
  const current = { ...repair,
    continuation: { ...repair.continuation!, pendingGuidance: 'Focus on witness order.',
      remainingGrants: 1 } }
  const html = render(current, 'blocked')
  assert.match(html, /Authorized correction ready to continue/)
  assert.match(html, /Continue authorized correction/)
  assert.doesNotMatch(html, /Correction guidance \(optional\)/)
  assert.doesNotMatch(html, /Continue with another correction/)
  const interrupted = render(current, 'paused')
  assert.match(interrupted, /Continue authorized correction/)
  const queued = render(current, 'paused', 'Independent review correction stopped for nonconvergence.', undefined, 'queued')
  assert.doesNotMatch(queued, /Continue authorized correction/)
})

test('resource budgets and unrelated integrity stops never appear as an author extension approval', () => {
  const paused = render(repair, 'paused', 'Pi budget exhausted', 'Model call limit reached')
  assert.match(paused, /Resource budget paused separately: Model call limit reached/)
  assert.doesNotMatch(paused, /Continue with another correction/)
  const invalid = render(repair, 'blocked', 'Integrity failure: source transcript altered')
  assert.doesNotMatch(invalid, /Continue with another correction/)
  const running = render(repair, 'running', null)
  assert.match(running, /Correcting Story review/)
  assert.doesNotMatch(running, /Review correction paused/)
})
