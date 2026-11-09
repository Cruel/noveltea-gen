import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExplorerIndex, ExplorerRecord } from '../src/lib/story-explorer.server'
import { activityHighlights, visibleActivityStep } from '../src/lib/story-activity-overlay'
import type { ActivityStep } from '../src/lib/thread-activity'

const record = (id: string, path: string): ExplorerRecord => ({
  id, path, title: id, status: 'draft', type: 'event', arcs: [], events: [],
})
const index: ExplorerIndex = {
  baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), validation: 'passed',
  protection: 'checked', readiness: null, diagnostics: [],
  records: [record('event.first', 'events/first.md'), record('event.second', 'events/second.md')],
  deletedRecords: [{ path: 'events/removed.md', title: 'Removed', type: 'event',
    id: 'event.removed', arcs: [], change: { committed: 'deleted' } }],
  unindexedRecords: [{ path: 'events/unindexed.md', change: { committed: 'added' } }],
}
function step(kind: ActivityStep['kind'], state: ActivityStep['state'], files: string[],
  proposedPaths: string[] = []): ActivityStep {
  return { id: 1, kind, state, stage: 'event', milestone: 'event.second', files,
    outcome: null, at: '2026-11-09T00:00:00Z',
    detail: { source: kind === 'report' ? 'pi' : 'controller', proposedPaths } }
}
test('only canonical exact current records receive verified and proposed overlays', () => {
  assert.deepEqual(activityHighlights(index, step('stage', 'verified',
    ['events/first.md', 'events/removed.md', 'events/unindexed.md', '../outside.md'])), {
    'event.first': 'verified',
  })
  assert.deepEqual(activityHighlights(index, step('report', 'proposed', [],
    ['events/second.md', 'events/removed.md'])), { 'event.second': 'proposed' })
  assert.deepEqual(activityHighlights(index, step('stage', 'working', [])),
    { 'event.second': 'working' })
  assert.deepEqual(activityHighlights(index, step('stage', 'working', ['events/first.md'],
    ['events/second.md'])), { 'event.second': 'working' },
    'unverified controller work must not appear as a verified file')
  assert.deepEqual(activityHighlights(null, step('report', 'proposed', [], ['events/first.md'])), {})
})

test('cross-Thread hover never highlights another Thread; correct historical run is allowed', () => {
  const one = step('stage', 'verified', ['events/first.md'])
  const two = step('report', 'proposed', [], ['events/second.md'])
  const fallback = { jobId: 'job-new', step: two }
  assert.equal(visibleActivityStep({ threadId: 'thread-one', jobId: 'job-old', step: one },
    'thread-one', ['job-old', 'job-new'], fallback), one)
  assert.equal(visibleActivityStep({ threadId: 'thread-one', jobId: 'job-old', step: one },
    'thread-two', ['job-new'], fallback), two)
  assert.equal(visibleActivityStep(null, 'thread-two', [], fallback), null)
})
