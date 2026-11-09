import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'node:test'
import type { ExplorerIndex, ExplorerRecord } from '../src/lib/story-explorer.server'
import { StoryWorkspaceOutline } from '../src/components/story-workspace-outline'

const record = (id: string, type: string, title: string, arcs: string[] = [],
  events: string[] = []): ExplorerRecord => ({
  id, type, title, arcs, events, status: 'draft', path: type + 's/' + id + '.md',
})
const index: ExplorerIndex = {
  baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
  validation: 'passed', protection: 'checked', readiness: null,
  records: [
    record('creative-direction.story', 'creative-direction', 'Direction'),
    record('arc.warning', 'arc', 'Warning'),
    record('milestone.bell', 'milestone', 'Bell milestone', ['arc.warning'], ['event.bell']),
    { ...record('event.bell', 'event', 'Ring the bell', ['arc.warning']),
      change: { committed: 'modified' } },
    record('event.unassigned', 'event', 'Unassigned Event'),
    record('character.one', 'character', 'Character One'),
  ],
  diagnostics: [{ path: 'events/event.bell.md', code: 'missing-field', message: 'Source required' }],
  deletedRecords: [{ id: 'event.retired', type: 'event', title: 'Retired Event',
    path: 'events/retired.md', arcs: [], change: { committed: 'deleted' } }],
  unindexedRecords: [{ path: 'events/unindexed.md', change: { committed: 'added' } }],
}
test('selected verified record is shared by Outline and Graph without making deleted or unindexed paths selectable', () => {
  const markup = renderToStaticMarkup(createElement(StoryWorkspaceOutline, {
    index, selectedId: 'event.bell', onSelect: () => {},
  }))
  assert.match(markup, /aria-label="Canonical Story Outline" class="story-workspace-outline/)
  assert.doesNotMatch(markup, /\btruncate\b/)
  // Unlayered global `nav { display:flex; gap:1.5rem }` otherwise creates three
  // compressed columns rather than a readable vertical record hierarchy.
  const styles = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')
  assert.match(styles, /\.story-workspace-outline\s*\{\s*display:\s*flex;\s*flex-direction:\s*column;\s*gap:/)
  assert.match(styles, /\.story-workspace-outline\s*>\s*details\s*\{[^}]*width:\s*100%/)
  assert.ok(markup.indexOf('Warning') < markup.indexOf('Bell milestone'))
  assert.ok(markup.indexOf('Bell milestone') < markup.indexOf('Ring the bell'))
  assert.match(markup, /aria-current="true"/)
  assert.match(markup, /modified · verified/)
  assert.match(markup, /diagnostics/)
  assert.match(markup, /Retired Event/)
  assert.match(markup, /unindexed\.md/)
  assert.doesNotMatch(markup, /data-record-id="event\.retired"/)
  assert.doesNotMatch(markup, /data-record-id="event\.unindexed"/)
  const switched = renderToStaticMarkup(createElement(StoryWorkspaceOutline, {
    index: { ...index, headSha: 'c'.repeat(40), records: index.records.map(r =>
      r.id === 'event.bell' ? { ...r, title: 'Bell alternate', change: undefined } : r) },
    selectedId: 'event.bell', onSelect: () => {},
  }))
  assert.match(switched, /Bell alternate/)
  assert.doesNotMatch(switched, /modified · verified/)
  assert.match(switched, /aria-current="true"/)
  assert.doesNotMatch(switched, /Ring the bell/)
})

test('record highlights remain separate from canonical selection, with explicit unverified provenance', () => {
  const markup = renderToStaticMarkup(createElement(StoryWorkspaceOutline, {
    index, selectedId: 'event.bell', onSelect: () => {},
    highlights: { 'event.bell': 'verified', 'character.one': 'proposed',
      'event.unassigned': 'working' },
  }))
  assert.match(markup, /data-record-id="event.bell" data-activity="verified"/)
  assert.match(markup, /data-record-id="character.one" data-activity="proposed"/)
  assert.match(markup, /aria-label="Character One · Pi-proposed, unverified"/)
  assert.match(markup, /data-record-id="event.unassigned" data-activity="working"/)
  assert.equal((markup.match(/aria-current="true"/g) ?? []).length, 1)
  assert.doesNotMatch(markup, /data-activity="proposed"[^>]+aria-current="true"/)
})

test('desktop/mobile Story panes share Thread-scoped overlays without forced viewport changes', () => {
  const route = readFileSync(new URL('../src/routes/_protected/stories/$storyId/conversations.tsx', import.meta.url), 'utf8')
  const graph = readFileSync(new URL('../src/routes/_protected/jobs/-StoryRelationshipGraph.tsx', import.meta.url), 'utf8')
  const activity = readFileSync(new URL('../src/components/thread-run-activity.tsx', import.meta.url), 'utf8')
  const chat = readFileSync(new URL('../src/components/thread-chat.tsx', import.meta.url), 'utf8')
  assert.match(route, /highlights=\{highlights\}/)
  assert.match(chat, /data-turn-activity=/)
  assert.match(chat, /onMouseEnter=\{item.role === 'user'/)
  assert.match(chat, /onFocus=\{item.role === 'user'/)
  assert.match(chat, /turn\.id === messageId\)\?\.executionIds/)
  assert.match(chat, /linked\.includes\(evidence\.jobId\)/)
  assert.match(chat, /evidence\.kind === 'verified'/)
  assert.match(route, /<StoryDesktopWorkspace outline=\{outlinePanel\}/)
  assert.match(route, /explorerView === 'graph'/)
  assert.match(route, /explorerView === 'outline'/)
  assert.match(route, /onActivityPin=\{onActivityPin\}/)
  assert.match(activity, /Highlight in Story/)
  assert.match(graph, /onMoveEnd=\{rememberViewport\}/)
  assert.match(graph, /defaultViewport=\{initialViewport/)
  assert.match(graph, /Follow activity \(moves viewport\)/)
  assert.match(graph, /duration: 0/)
  assert.doesNotMatch(graph, /key=\{selectedId \+ scope/)
  assert.match(activity, /motion-reduce:transition-none/)
})

test('Story Graph owns the viewport and canonical record inspection is on demand', () => {
  const route = readFileSync(new URL('../src/routes/_protected/stories/$storyId/conversations.tsx', import.meta.url), 'utf8')
  const inspector = readFileSync(new URL('../src/components/story-workspace-explorer.tsx', import.meta.url), 'utf8')
  const graph = readFileSync(new URL('../src/routes/_protected/jobs/-StoryRelationshipGraph.tsx', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')

  assert.match(route, /<StoryInspectorSheet[^>]*storyId=/)
  assert.match(route, /open=\{inspectorOpen\}/)
  assert.match(route, /onClick=\{\(\) => setInspectorOpen\(true\)\}>Inspect record/)
  assert.doesNotMatch(route, /max-h-\[40%\]/)
  assert.doesNotMatch(route, /<StoryWorkspaceInspector/)
  assert.match(inspector, /<SheetContent side="right" closeLabel="Close record inspector"/)
  assert.match(inspector, /\{open && <div className="min-h-0 flex-1 overflow-y-auto"/)
  assert.doesNotMatch(inspector, /max-h-64 overflow-auto/)
  assert.match(graph, /workspace \? <details className="story-workspace-graph-filters"/)
  assert.match(styles, /\.story-desktop-graph \.story-relationships \{[^}]*overflow: hidden;/)
  assert.match(styles, /\.story-desktop-graph \.story-graph-canvas \{[^}]*flex: 1 1 0%;[^}]*min-height: 0;/)
})
