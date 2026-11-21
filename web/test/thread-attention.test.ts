import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runAttentionText, runAttentionHeading, canSendThreadFollowUp } from '../src/lib/thread-attention'

test('blocked specialist failure remains legible without hiding preserved work', () => {
  const detail = 'foundations: Foundation specialist did not edit canonical Markdown.; event:a: Blocked dependency: foundations; composition:a: Blocked dependency'
  assert.match(runAttentionText('blocked', detail), /did not write|required canonical Story files/)
  assert.match(runAttentionText('blocked', detail), /preserved/)
  assert.doesNotMatch(runAttentionText('blocked', detail), /composition:a/)
  assert.equal(runAttentionText('blocked', null),
    'Generation stopped. Inspect the saved run for the cause and available recovery checkpoints.')
  assert.equal(runAttentionText('interrupted', 'Writer needs manual reconciliation; downstream blocked'),
    'Writer needs manual reconciliation')
  assert.equal(runAttentionText('prepared', null), 'This Thread has not started generating yet.')
})

test('#213 trusted Studio headings distinguish author input, budget pauses and completion', () => {
  assert.equal(runAttentionHeading('paused', { authorPending: true }), 'Author input required')
  assert.equal(runAttentionHeading('blocked', { authorPending: true }), 'Author input required')
  assert.equal(runAttentionHeading('paused', { budgetPaused: true }), 'Resource budget paused')
  assert.equal(runAttentionHeading('paused'), 'Generation paused')
  assert.equal(runAttentionHeading('blocked'), 'Generation stopped')
  assert.equal(runAttentionHeading('completed', { budgetPaused: true }),
    'Generation finished', 'historical budgets must not overwrite terminal success')
  assert.equal(runAttentionHeading('blocked', { retryableContinuation: true }),
    'Generation could not start')
  assert.equal(runAttentionHeading('running', { authorPending: true, budgetPaused: true }),
    'Generation status', 'stale controls must not claim a current pause')
})

test('paused, blocked, interrupted and cancelled Threads never invite undeliverable follow-ups', () => {
  for (const status of ['paused', 'blocked', 'interrupted', 'cancelled', 'prepared', undefined])
    assert.equal(canSendThreadFollowUp(status, false), false, String(status))
  for (const status of ['running', 'queued', 'completed']) {
    assert.equal(canSendThreadFollowUp(status, false), true, status)
    assert.equal(canSendThreadFollowUp(status, true), false, status + ' archived')
  }
})
