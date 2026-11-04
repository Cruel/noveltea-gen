import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeJobEvents } from '../src/lib/job-events.shared'
import type { ProgressEvent } from '../src/lib/generation-progress.server'

function event(id: number, kind: ProgressEvent['kind'] = 'working'): ProgressEvent {
  return { id, kind, stage: 'foundation', milestone: null, files: [],
    status: null, createdAt: new Date(id * 1000).toISOString() }
}

test('initial persisted history plus SSE additions remain chronological and deduplicated', () => {
  const history = [event(4), event(5), event(6)]
  assert.deepEqual(mergeJobEvents(history, [event(7), event(6), event(8)]).map(x => x.id),
    [4, 5, 6, 7, 8], 'replaying a stream cursor never duplicates an event')
  const withLive = mergeJobEvents(history, [event(7), event(8)])
  assert.deepEqual(mergeJobEvents(withLive, [event(2), event(3), event(4), event(1)])
    .map(x => x.id), [1, 2, 3, 4, 5, 6, 7, 8],
    'loading an older page must not discard events received while it loads')
  assert.deepEqual(mergeJobEvents(withLive, []), withLive,
    'an empty backfill cannot clear existing events')
  assert.deepEqual(history.map(x => x.id), [4, 5, 6],
    'merging must not mutate the original Query history')
})
