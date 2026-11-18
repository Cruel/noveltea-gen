import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markWriteOutcome, providerWriteOutcome, titleForInitialization,
  validStoryTitle } from '../src/lib/story-initialization-contract'

test('guided initialization uses exact approved Creative Direction title, not empty manual form', () => {
  assert.equal(titleForInitialization('guided', '', 'The Last Bell'), 'The Last Bell')
  assert.equal(titleForInitialization('manual', '  Author Title  ', 'Ignored Title'), 'Author Title')
  assert.throws(() => titleForInitialization('guided', 'Manual Title'), /Story title/)
  assert.throws(() => titleForInitialization('guided', '', ''), /Story title/)
  assert.throws(() => titleForInitialization('guided', '', ' Trailing title '), /Story title/,
    'reviewed proposals must not be silently changed after approval')
  assert.equal(validStoryTitle('A'.repeat(120)), true)
  for (const title of ['A'.repeat(121), 'A\nB', '\u0000', '']) {
    assert.equal(validStoryTitle(title), false)
    assert.throws(() => titleForInitialization('guided', '', title), /Story title/)
  }
})

test('provider failures are known to be safe to retry only with an explicit no-mutation attestation', () => {
  const validation = markWriteOutcome(Response.json({error:'Invalid title'}, {status:400}), false)
  assert.equal(providerWriteOutcome(validation), 'not-attempted')
  const networkFailure = markWriteOutcome(Response.json({error:'Unknown commit'}, {status:503}), true)
  assert.equal(providerWriteOutcome(networkFailure), 'unknown')
  assert.equal(providerWriteOutcome(Response.json({error:'Legacy error'}, {status:400})), 'unknown')
})
