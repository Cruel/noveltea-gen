import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'node:test'
import { StudioSelect } from '../src/components/studio-select'
import { StoryDesktopWorkspace, StoryMobileWorkspace, DEFAULT_STORY_LAYOUT, STORY_LAYOUT_KEY,
  clampStoryHeight, parseStoryLayout, storyHeightForKey, storyHeightForPointer,
  parseStoryMobileView, mobileViewForKey, STORY_MOBILE_VIEW_KEY } from '../src/components/story-desktop-workspace'

test('Story desktop layout has two full-width stacked regions with aligned independent sidebars', () => {
  const markup = renderToStaticMarkup(createElement(StoryDesktopWorkspace, {
    outline: createElement('span', null, 'CANONICAL_OUTLINE'),
    graph: createElement('span', null, 'NATIVE_GRAPH'),
    threads: createElement('span', null, 'THREAD_NAVIGATION'),
    chat: createElement('span', null, 'CHAT_COMPOSER'),
  }))
  assert.match(markup, /aria-label="Story workspace layout"/)
  assert.match(markup, /aria-label="Story exploration"/)
  assert.match(markup, /aria-label="Thread and Chat workspace"/)
  assert.ok(markup.indexOf('CANONICAL_OUTLINE') < markup.indexOf('NATIVE_GRAPH'))
  assert.ok(markup.indexOf('NATIVE_GRAPH') < markup.indexOf('THREAD_NAVIGATION'))
  assert.ok(markup.indexOf('THREAD_NAVIGATION') < markup.indexOf('CHAT_COMPOSER'))
  assert.equal((markup.match(/grid-template-columns:minmax\(200px,252px\) minmax\(0,1fr\)/g) ?? []).length, 2)
  assert.match(markup, /role="separator"/)
  assert.match(markup, /tabindex="0"/)
  assert.match(markup, /aria-orientation="horizontal"/)
  assert.match(markup, /aria-valuemin="20"/)
  assert.match(markup, /aria-valuemax="70"/)
  assert.match(markup, /aria-valuenow="42"/)
  assert.match(markup, /aria-label="Collapse Outline sidebar"/)
  assert.match(markup, /aria-label="Collapse Thread sidebar"/)
  assert.match(markup, /aria-label="Collapse Story workspace"/)
})

test('mobile workspace exposes three exclusive accessible views while retaining the Chat draft', () => {
  const chat = createElement('textarea', { 'aria-label': 'Compose message', defaultValue: 'Unsent draft' })
  const slots = { chat, outline: createElement('span', null, 'STORY_OUTLINE'),
    graph: createElement('span', null, 'NATIVE_GRAPH'), onViewChange: () => {} }
  const chatMarkup = renderToStaticMarkup(createElement(StoryMobileWorkspace, { ...slots, view: 'chat' }))
  assert.match(chatMarkup, /aria-label="Selected Thread"/)
  assert.match(chatMarkup, /role="tablist" aria-label="Story workspace views"/)
  assert.equal((chatMarkup.match(/role="tab"/g) ?? []).length, 3)
  assert.equal((chatMarkup.match(/aria-selected="true"/g) ?? []).length, 1)
  assert.match(chatMarkup, /aria-label="Compose message"/)
  assert.match(chatMarkup, /Unsent draft/)
  assert.doesNotMatch(chatMarkup, /NATIVE_GRAPH|STORY_OUTLINE/)
  const graphMarkup = renderToStaticMarkup(createElement(StoryMobileWorkspace, { ...slots, view: 'graph' }))
  assert.match(graphMarkup, /NATIVE_GRAPH/)
  assert.doesNotMatch(graphMarkup, /STORY_OUTLINE/)
  assert.match(graphMarkup, /hidden=""[^>]*>.*Unsent draft/s)
  const outlineMarkup = renderToStaticMarkup(createElement(StoryMobileWorkspace, { ...slots, view: 'outline' }))
  assert.match(outlineMarkup, /STORY_OUTLINE/)
  assert.doesNotMatch(outlineMarkup, /NATIVE_GRAPH/)
  assert.match(outlineMarkup, /hidden=""[^>]*>.*Unsent draft/s)
})

test('mobile view tabs support keyboard previous/next and first/last without capturing unrelated keys', () => {
  assert.equal(mobileViewForKey('chat', 'ArrowRight'), 'outline')
  assert.equal(mobileViewForKey('outline', 'ArrowRight'), 'graph')
  assert.equal(mobileViewForKey('graph', 'ArrowRight'), 'chat')
  assert.equal(mobileViewForKey('chat', 'ArrowLeft'), 'graph')
  assert.equal(mobileViewForKey('graph', 'Home'), 'chat')
  assert.equal(mobileViewForKey('chat', 'End'), 'graph')
  assert.equal(mobileViewForKey('chat', 'Tab'), null)
  assert.equal(mobileViewForKey('outline', 'Escape'), null)
})

test('mobile view preference is independent of desktop layout and rejects invalid values', () => {
  assert.equal(STORY_MOBILE_VIEW_KEY, 'noveltea.story-workspace.mobile-view.v1')
  assert.equal(parseStoryMobileView(null), 'chat')
  assert.equal(parseStoryMobileView('outline'), 'outline')
  assert.equal(parseStoryMobileView('graph'), 'graph')
  assert.equal(parseStoryMobileView('chat'), 'chat')
  assert.equal(parseStoryMobileView('invalid'), 'chat')
  assert.equal(parseStoryMobileView('{"height":42}'), 'chat')
})

test('Story select renders the supplied label, not the opaque ID', () => {
  const markup = renderToStaticMarkup(createElement(StudioSelect, {
    value: '00000000-0000-4000-8000-000000000001',
    'aria-label': 'Selected Story',
    onValueChange: () => {},
    options: [
      { value: '00000000-0000-4000-8000-000000000001', label: 'The Last Bell · example' },
      { value: '00000000-0000-4000-8000-000000000002', label: 'Other Story' },
    ],
  }))
  assert.match(markup, /aria-label="Selected Story"/)
  assert.match(markup, /data-slot="select-value"[^>]*>The Last Bell · example<\/span>/)
  // Base UI legitimately stores the opaque value in an inaccessible hidden form input.
  assert.doesNotMatch(markup.slice(0, markup.indexOf('</button>')), /00000000-0000-4000-8000-000000000001/)
})

test('site-wide layout storage restores only valid bounded panel state', () => {
  assert.equal(STORY_LAYOUT_KEY, 'noveltea.story-workspace.layout.v1')
  assert.deepEqual(parseStoryLayout(null), DEFAULT_STORY_LAYOUT)
  assert.deepEqual(parseStoryLayout('not-json'), DEFAULT_STORY_LAYOUT)
  assert.deepEqual(parseStoryLayout('[]'), DEFAULT_STORY_LAYOUT)
  assert.deepEqual(parseStoryLayout('{"storyOpen":false,"outlineOpen":false,"threadsOpen":true,"height":64}'), {
    storyOpen: false, outlineOpen: false, threadsOpen: true, height: 64,
  })
  assert.equal(parseStoryLayout('{"height":100000}').height, 70)
  assert.equal(parseStoryLayout('{"height":-9}').height, 20)
  assert.equal(parseStoryLayout('{"height":"99"}').height, 42)
  assert.equal(clampStoryHeight(21.7), 21.7)
  assert.equal(clampStoryHeight(21.735), 21.74)
  assert.equal(clampStoryHeight(0), 20)
  assert.equal(clampStoryHeight(100), 70)
})

test('splitter follows single-pixel pointer moves smoothly without whole-percent snapping', () => {
  // One percent of an 800px workspace is 8px. Each pixel must still move the splitter.
  assert.equal(storyHeightForPointer(42, 200, 201, 800), 42.13)
  assert.equal(storyHeightForPointer(42, 200, 202, 800), 42.25)
  assert.equal(storyHeightForPointer(42, 200, 207, 800), 42.88)
  assert.equal(storyHeightForPointer(42, 200, 199, 800), 41.88)
  assert.equal(storyHeightForPointer(42, 200, 5000, 800), 70)
  assert.equal(storyHeightForPointer(42, 200, -5000, 800), 20)
  assert.equal(storyHeightForPointer(42, 200, 205, 0), 42)
  assert.equal(parseStoryLayout('{"height":42.13}').height, 42.13)
})

test('focused splitter keyboard controls are bounded and ignore unrelated keys', () => {
  assert.equal(storyHeightForKey(42, 'ArrowUp', false), 40)
  assert.equal(storyHeightForKey(42, 'ArrowDown', false), 44)
  assert.equal(storyHeightForKey(42, 'ArrowUp', true), 32)
  assert.equal(storyHeightForKey(42, 'ArrowDown', true), 52)
  assert.equal(storyHeightForKey(42, 'Home', false), 20)
  assert.equal(storyHeightForKey(42, 'End', false), 70)
  assert.equal(storyHeightForKey(20, 'ArrowUp', false), 20)
  assert.equal(storyHeightForKey(70, 'ArrowDown', true), 70)
  assert.equal(storyHeightForKey(42, 'Tab', false), null)
})
