import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_FULL_STORY_TIMEOUT_MINUTES,
  MAX_FULL_STORY_TIMEOUT_MINUTES,
  fullStoryTimeouts,
} from '../../scripts/live-new-story-timeout.mjs'

test('full Story certification keeps the 40-minute monitor and 45-minute test defaults', () => {
  assert.equal(DEFAULT_FULL_STORY_TIMEOUT_MINUTES, 40)
  assert.deepEqual(fullStoryTimeouts(undefined), {
    minutes: 40,
    monitorMs: 40 * 60_000,
    testMs: 45 * 60_000,
  })
})

test('full Story certification accepts an explicit large-generation timeout', () => {
  assert.deepEqual(fullStoryTimeouts('180'), {
    minutes: 180,
    monitorMs: 180 * 60_000,
    testMs: 185 * 60_000,
  })
  assert.deepEqual(fullStoryTimeouts(String(MAX_FULL_STORY_TIMEOUT_MINUTES)), {
    minutes: 1440,
    monitorMs: 1440 * 60_000,
    testMs: 1445 * 60_000,
  })
})

test('full Story certification rejects ambiguous or unreasonable timeouts', () => {
  for (const value of [
    '',
    '0',
    '-1',
    '1.5',
    ' 45',
    '45 ',
    '045',
    'Infinity',
    'NaN',
    '1441',
    '99999999999999999999999',
  ]) {
    assert.throws(
      () => fullStoryTimeouts(value),
      /NT_TEST_WEB_PI_TIMEOUT_MINUTES must be an integer from 1 to 1440/,
      value,
    )
  }
})
