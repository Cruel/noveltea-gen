import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StoryCollectionsPanel } from '../src/components/story-collections-panel'
import type { StoryThread } from '../src/lib/threads.server'

const at = '2026-11-08T00:00:00Z'
const collections = [
  { id: 'c1', storyId: 's1', name: 'Ideas', createdAt: at, updatedAt: at },
  { id: 'c2', storyId: 's1', name: 'Drafts', createdAt: at, updatedAt: at },
]
const threads: StoryThread[] = [
  {
    id: 'parent',
    storyId: 's1',
    parentThreadId: null,
    collectionId: 'c1',
    title: 'Original',
    createdAt: at,
    activityAt: '2026-11-01T00:00:00Z',
    archivedAt: null,
    status: 'completed',
    currentWork: null,
    jobId: 'original-job',
  },
  {
    id: 'child',
    storyId: 's1',
    parentThreadId: 'parent',
    collectionId: 'c2',
    title: 'Variation',
    createdAt: at,
    activityAt: '2026-11-03T00:00:00Z',
    archivedAt: null,
    status: 'completed',
    currentWork: null,
    jobId: 'variation-job',
  },
  {
    id: 'loose',
    storyId: 's1',
    parentThreadId: null,
    collectionId: null,
    title: 'Unassigned',
    createdAt: at,
    activityAt: '2026-11-02T00:00:00Z',
    archivedAt: null,
    status: 'running',
    currentWork: 'Writing',
    jobId: 'loose-job',
  },
]
const props = {
  threads,
  collections,
  view: 'tree' as const,
  expandedIds: ['parent'],
  collapsedCollectionIds: [] as string[],
  selectedThreadId: 'child',
  archivedView: false,
  showAll: false,
  onShowAll: () => {},
  onToggleCollection: () => {},
  onCreateCollection: async () => {},
  onRenameCollection: async () => {},
  onRemoveCollection: () => {},
  onMoveThread: () => {},
  onExpand: () => {},
  onRenameThread: () => {},
  onArchiveChange: () => {},
  onDelete: () => {},
  onOpen: () => {},
}
test('Collection navigation keeps fork ancestry distinct from organizational grouping', () => {
  const grouped = renderToStaticMarkup(createElement(StoryCollectionsPanel, props))
  assert.match(grouped, /Story Collections/)
  assert.match(grouped, /Ideas Collection/)
  assert.match(grouped, /Drafts Collection/)
  assert.match(grouped, /Ungrouped Collection/)
  assert.match(
    grouped,
    /Forked from Original/,
    'cross-Collection ancestry must not disappear or be presented as a new fork root',
  )
  assert.match(grouped, /aria-label="Create Collection"/)
  assert.match(grouped, /Collection actions for Drafts/)
  assert.match(grouped, /Open chat for Variation/)
  assert.match(grouped, /Open chat for Unassigned/)

  const collapsed = renderToStaticMarkup(
    createElement(StoryCollectionsPanel, {
      ...props,
      selectedThreadId: 'loose',
      collapsedCollectionIds: ['c1', 'c2'],
    }),
  )
  assert.match(collapsed, /aria-label="Expand Drafts Collection"/)
  assert.doesNotMatch(collapsed, /Open chat for Variation/)
  assert.match(collapsed, /Open chat for Unassigned/)

  const selected = renderToStaticMarkup(
    createElement(StoryCollectionsPanel, {
      ...props,
      collapsedCollectionIds: ['c2'],
    }),
  )
  assert.match(
    selected,
    /Open chat for Variation/,
    'selected Thread cannot be concealed by saved collapsed group',
  )

  const all = renderToStaticMarkup(
    createElement(StoryCollectionsPanel, {
      ...props,
      showAll: true,
      view: 'flat',
    }),
  )
  assert.ok(all.indexOf('Open chat for Variation') < all.indexOf('Open chat for Unassigned'))
  assert.ok(all.indexOf('Open chat for Unassigned') < all.indexOf('Open chat for Original'))
  assert.match(all, /From Original/)

  const archived = renderToStaticMarkup(
    createElement(StoryCollectionsPanel, {
      ...props,
      archivedView: true,
      threads: threads.map((thread) =>
        thread.id === 'child' ? { ...thread, archivedAt: at, status: 'archived' as const } : thread,
      ),
    }),
  )
  assert.match(
    archived,
    /Forked from Original/,
    'an archived descendant in a different Collection keeps an explicit fork source',
  )
  assert.match(
    archived,
    /Ancestor/,
    'active parent ancestry is retained when inspecting archived descendants',
  )
})
