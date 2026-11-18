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

test('scope approval leaves the original Chat message editable but disables duplicate sends', () => {
  const markup = renderToStaticMarkup(createElement(StoryChatPrompt, {
    value: 'I want a conversation between two parties added.',
    creativeMode: 'autonomous',
    busy: false,
    sending: false,
    sendDisabled: true,
    onCreativeModeChange: () => {},
    onChange: () => {},
    onSend: () => {},
  }))
  assert.match(markup, /<textarea[^>]+aria-label="Story message"[^>]*>/)
  assert.doesNotMatch(markup.match(/<textarea[^>]+>/)?.[0] ?? '', /\sdisabled(?:\s|=|>)/,
    'The author must be able to supply the missing speaker names')
  assert.match(markup.match(/<button[^>]+>/)?.[0] ?? '', /\sdisabled=""/,
    'A reviewed or incomplete scope must not be submitted by pressing Send again')
})
