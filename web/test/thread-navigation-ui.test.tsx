import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadList } from '../src/components/thread-list'
import type { StoryThread } from '../src/lib/threads.server'

const thread = (id: string, parentThreadId: string | null, status: StoryThread['status'],
  activityAt: string): StoryThread => ({
  id, parentThreadId, conversationId: 'conversation', title: id,
  activityAt, createdAt: '2026-11-01T00:00:00Z', archivedAt: null,
  status, currentWork: status === 'running' ? 'Event · arc.one' : null,
  jobId: id + '-job',
})

test('Thread navigation renders job links, progress and accessible reduced-motion expansion', () => {
  const threads = [
    thread('first', null, 'paused', '2026-11-01T00:00:00Z'),
    thread('second', null, 'completed', '2026-11-03T00:00:00Z'),
    thread('child', 'first', 'running', '2026-11-04T00:00:00Z'),
  ]
  const props = { threads, onExpand: (_id: string) => {}, onRename: (_thread: StoryThread) => {} }
  const collapsed = renderToStaticMarkup(createElement(ThreadList, {
    ...props, view: 'tree', expandedIds: [],
  }))
  assert.match(collapsed, /role="tree"/)
  assert.match(collapsed, /aria-expanded="false"/)
  assert.match(collapsed, /Expand first/)
  assert.doesNotMatch(collapsed, /child-job/)
  const expanded = renderToStaticMarkup(createElement(ThreadList, {
    ...props, view: 'tree', expandedIds: ['first'],
  }))
  assert.match(expanded, /child-job/)
  assert.match(expanded, /Event · arc.one/)
  assert.match(expanded, /motion-reduce:animate-none/)
  assert.match(expanded, /aria-level="2"/)
  assert.ok(expanded.indexOf('first-job') < expanded.indexOf('second-job'),
    'the active child promotes the parent above a newer sibling root')
  const flat = renderToStaticMarkup(createElement(ThreadList, {
    ...props, view: 'flat', expandedIds: [],
  }))
  assert.match(flat, /role="list"/)
  assert.ok(flat.indexOf('child-job') < flat.indexOf('second-job'))
  assert.ok(flat.indexOf('second-job') < flat.indexOf('first-job'))
})
