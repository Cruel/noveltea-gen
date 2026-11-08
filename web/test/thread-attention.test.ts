import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runAttentionText, canSendThreadFollowUp } from '../src/lib/thread-attention'

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

test('paused, blocked, interrupted and cancelled Threads never invite undeliverable follow-ups', () => {
  for (const status of ['paused', 'blocked', 'interrupted', 'cancelled', 'prepared', undefined])
    assert.equal(canSendThreadFollowUp(status, false), false, String(status))
  for (const status of ['running', 'queued', 'completed']) {
    assert.equal(canSendThreadFollowUp(status, false), true, status)
    assert.equal(canSendThreadFollowUp(status, true), false, status + ' archived')
  }
})
