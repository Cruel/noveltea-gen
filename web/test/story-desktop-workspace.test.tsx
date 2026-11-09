import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'node:test'
import { StoryDesktopWorkspace, DEFAULT_STORY_LAYOUT, STORY_LAYOUT_KEY,
  clampStoryHeight, parseStoryLayout, storyHeightForKey } from '../src/components/story-desktop-workspace'

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
  assert.equal(clampStoryHeight(21.7), 22)
  assert.equal(clampStoryHeight(0), 20)
  assert.equal(clampStoryHeight(100), 70)
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
