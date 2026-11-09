import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultStoryGraphPreferences, parseStoryGraphPreferences,
  readStoryGraphPreferences, saveStoryGraphPreferences } from '../src/lib/story-graph-preferences'

test('Graph persisted preferences parse safely and reject invalid pan/zoom or filters', () => {
  assert.deepEqual(parseStoryGraphPreferences('bad JSON'), defaultStoryGraphPreferences)
  const preferences = parseStoryGraphPreferences(JSON.stringify({
    selectedId: 'event.chapter', kind: 'event', limit: 40, scope: 'related',
    connectedOnly: true, collapseOuter: false, showDeleted: false,
    followActivity: true, viewport: { x: 135.25, y: -65.4, zoom: 1.8 },
  }))
  assert.equal(preferences.selectedId, 'event.chapter')
  assert.equal(preferences.kind, 'event')
  assert.equal(preferences.scope, 'related')
  assert.equal(preferences.limit, 40)
  assert.equal(preferences.followActivity, true)
  assert.deepEqual(preferences.viewport, { x: 135.25, y: -65.4, zoom: 1.8 })
  assert.deepEqual(parseStoryGraphPreferences(JSON.stringify({
    selectedId: 'a'.repeat(129), kind: 'x'.repeat(100), limit: 15,
    viewport: { x: 0, y: 0, zoom: 1000 },
  })), defaultStoryGraphPreferences)
})

test('per-Thread Graph selections never bleed across Thread identities', () => {
  // Storage helpers deliberately don't require browser globals during SSR.
  assert.deepEqual(readStoryGraphPreferences('story-a', 'thread-one'), defaultStoryGraphPreferences)
  saveStoryGraphPreferences('story-a', 'thread-one', { selectedId: 'event.chapter' })
  assert.equal(readStoryGraphPreferences('story-a', 'thread-two').selectedId, null)
})
