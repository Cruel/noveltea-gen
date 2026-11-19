import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadRepairContent } from '../src/components/thread-repair-content'
import type { JobControls } from '../src/lib/jobs.functions'

const sha = (letter: string) => letter.repeat(40)
function render(repair: NonNullable<JobControls['repair']>,
  status: string, reason: string | null = 'Independent review correction allowance exhausted.',
  budgetPause?: string, queue?: string | null) {
  return renderToStaticMarkup(createElement(ThreadRepairContent, {
    repair, status, reason, budgetPause, queue, onContinue: async () => {},
  }))
}
const repair: NonNullable<JobControls['repair']> = {
  attempts: 2, limit: 12,
  findings: [{
    id: 'finding-1', type: 'continuity', specialist: 'event-witness',
    outcome: 'Witness testimony supports the discovery', paths: ['events/witness.md'],
    status: 'open', sourceSha: sha('a'), reviewDigest: 'f'.repeat(64),
    attempts: 2, allowance: 2,
    message: 'The witness appears after the deduction.',
    requiredCorrection: 'Present witness testimony before the deduction.',
  }],
  prerequisites: [], recent: [{ sourceSha: sha('b'), paths: ['events/witness.md'],
    outcome: 'failed', successorSha: sha('c') }],
  continuation: { sourceSha: sha('b'), rootSha: sha('a'),
    reviewedSha: sha('c'), remainingGrants: 2 },
}

test('exhausted repair offers bounded editorial guidance with independently reviewed finding details', () => {
  const html = render(repair, 'blocked')
  assert.match(html, /Correction allowance exhausted/)
  assert.match(html, /2\/12 Turn corrections/)
  assert.match(html, /continuity/)
  assert.match(html, /event-witness/)
  assert.match(html, /2\/2 attempts/)
  assert.match(html, /The witness appears after the deduction/)
  assert.match(html, /Present witness testimony before the deduction/)
  assert.match(html, /events\/witness\.md/)
  assert.match(html, /review ffffffffffff/)
  assert.match(html, /Allow one more correction and continue/)
  assert.doesNotMatch(html, /PRIVATE_PI_TRANSCRIPT/)
})

test('crash between author grant and queue admission retains resume without another grant', () => {
  const current = { ...repair, findings: [{ ...repair.findings[0]!, allowance: 3 }],
    continuation: { ...repair.continuation!, pendingGuidance: 'Focus on witness order.',
      remainingGrants: 1 } }
  const html = render(current, 'blocked')
  assert.match(html, /Authorized correction ready to continue/)
  assert.match(html, /Continue authorized correction/)
  assert.doesNotMatch(html, /Correction guidance \(optional\)/)
  assert.doesNotMatch(html, /Allow one more correction and continue/)
  const interrupted = render(current, 'paused')
  assert.match(interrupted, /Continue authorized correction/)
  const queued = render(current, 'paused', 'Independent review correction allowance exhausted.', undefined, 'queued')
  assert.doesNotMatch(queued, /Continue authorized correction/)
})

test('resource budgets and unrelated integrity stops never appear as an author extension approval', () => {
  const paused = render(repair, 'paused', 'Pi budget exhausted', 'Model call limit reached')
  assert.match(paused, /Resource budget paused separately: Model call limit reached/)
  assert.doesNotMatch(paused, /Allow one more correction and continue/)
  const invalid = render(repair, 'blocked', 'Integrity failure: source transcript altered')
  assert.doesNotMatch(invalid, /Allow one more correction and continue/)
  const running = render(repair, 'running', null)
  assert.match(running, /Correcting Story review/)
  assert.doesNotMatch(running, /Correction allowance exhausted/)
})
