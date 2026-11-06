import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadList } from '../src/components/thread-list'
import { selectNavigationThreads } from '../src/lib/thread-navigation'
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
  const props = { threads, onExpand: (_id: string) => {}, onRename: (_thread: StoryThread) => {},
    onArchiveChange: (_thread: StoryThread, _archived: boolean) => {} }
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
  assert.match(expanded, /Restart Thread/,
    'each Thread exposes an accessible restart action without opening provider operations')
  assert.match(expanded, /aria-level="2"/)
  assert.match(expanded, /Execution timeline/)
  assert.doesNotMatch(expanded, /Branch from here/,
    'checkpoint actions load only after the authenticated timeline is expanded')
  assert.ok(expanded.indexOf('first-job') < expanded.indexOf('second-job'),
    'the active child promotes the parent above a newer sibling root')
  const flat = renderToStaticMarkup(createElement(ThreadList, {
    ...props, view: 'flat', expandedIds: [],
  }))
  assert.match(flat, /role="list"/)
  assert.ok(flat.indexOf('child-job') < flat.indexOf('second-job'))
  assert.ok(flat.indexOf('second-job') < flat.indexOf('first-job'))
})

test('archive navigation shows only active Threads by default and retains an archived descendant\'s ancestry', () => {
  const parent = thread('parent', null, 'completed', '2026-11-01T00:00:00Z')
  const child = thread('child', 'parent', 'archived', '2026-11-02T00:00:00Z')
  child.archivedAt = '2026-11-03T00:00:00Z'
  const activeThreads = selectNavigationThreads([parent, child], 'active')
  const archivedThreads = selectNavigationThreads([parent, child], 'archived')
  const props = {
    view: 'tree' as const, expandedIds: [], onExpand: (_id: string) => {},
    onRename: (_thread: StoryThread) => {},
    onArchiveChange: (_thread: StoryThread, _archived: boolean) => {},
  }
  const active = renderToStaticMarkup(createElement(ThreadList, {
    ...props, threads: activeThreads, archivedView: false,
  }))
  assert.match(active, /Archive Thread parent/)
  assert.doesNotMatch(active, /child-job/)
  const archived = renderToStaticMarkup(createElement(ThreadList, {
    ...props, threads: archivedThreads, archivedView: true,
  }))
  assert.match(archived, /parent-job/)
  assert.match(archived, /child-job/)
  assert.match(archived, /aria-level="2"/)
  assert.match(archived, /Restore Thread child/)
  assert.doesNotMatch(archived, /Archive Thread parent/)
  assert.match(archived, /Ancestor/)
  const archivedFlat = renderToStaticMarkup(createElement(ThreadList, {
    ...props, view: 'flat', threads: archivedThreads, archivedView: true,
  }))
  assert.match(archivedFlat, /From parent/,
    'the activity-sorted archived flat view still shows the original parent')
  parent.archivedAt = '2026-11-04T00:00:00Z'
  const unarchivedChild = thread('visible', 'parent', 'running', '2026-11-05T00:00:00Z')
  const activeAfterParentArchive = renderToStaticMarkup(createElement(ThreadList, {
    ...props, threads: selectNavigationThreads([parent, unarchivedChild], 'active'),
  }))
  assert.match(activeAfterParentArchive, /visible-job/)
  assert.match(activeAfterParentArchive, /Parent archived/)
  assert.doesNotMatch(activeAfterParentArchive, /parent-job/)
})

test('deleted parent remains a noninteractive lineage placeholder but a deleted leaf is hidden', () => {
  const parent = thread('parent', null, 'deleted', '2026-11-01T00:00:00Z')
  parent.deletedAt = '2026-11-05T00:00:00Z'
  parent.deletionCompleteAt = '2026-11-05T01:00:00Z'
  parent.jobId = null
  const child = thread('child', parent.id, 'completed', '2026-11-06T00:00:00Z')
  const threads = selectNavigationThreads([parent, child], 'active')
  assert.deepEqual(threads.map(item => item.id), ['parent', 'child'])
  const view = renderToStaticMarkup(createElement(ThreadList, {
    threads, view: 'tree', expandedIds: [], onExpand: () => {},
    onRename: () => {}, onArchiveChange: () => {}, onDelete: () => {},
  }))
  assert.match(view, /Deleted ancestor/)
  assert.match(view, /child-job/)
  assert.doesNotMatch(view, /parent-job/)
  assert.doesNotMatch(view, /Permanently delete Thread parent/)
  assert.doesNotMatch(view, /Rename Thread parent/)
  assert.match(view, /Permanently delete Thread child/)
  assert.deepEqual(selectNavigationThreads([parent], 'active'), [])
})
