import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'node:test'
import {
  EmptyStoryContext,
  EmptyStoryWelcome,
  StoryChatPrompt,
} from '../src/components/story-first-chat-view'

test('an empty Story opens ordinary Chat and truthful Outline/Graph placeholders without a Job wizard', () => {
  const markup = renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(EmptyStoryContext),
      createElement(EmptyStoryWelcome),
      createElement(StoryChatPrompt, {
        value: '',
        creativeMode: 'autonomous',
        onCreativeModeChange: () => {},
        busy: false,
        sending: false,
        onChange: () => {},
        onSend: () => {},
      }),
    ),
  )
  assert.match(markup, /Story Outline/)
  assert.match(markup, /Story Graph/)
  assert.match(markup, /What would you like to create/)
  assert.match(markup, /aria-label="Story message"/)
  assert.match(markup, /aria-label="Initial Thread creative mode"/)
  assert.match(markup, /aria-label="Start Story Chat"/)
  assert.match(markup, />Send</)
  assert.doesNotMatch(markup, /Approve full-Story plan and run|Configure generation|Job wizard/)
})
