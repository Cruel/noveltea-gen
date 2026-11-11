import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadChatHeader } from '../src/components/thread-chat-header'

const source = (path: string) => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8')
const props = {
  title: 'A Thread with a very long title about writing a scene between two people',
  mode: 'autonomous' as const,
  modeDisabled: false,
  status: 'running',
  showReview: false,
  onModeChange: () => {},
  onReview: () => {},
}

test('Thread Chat uses a single compact header and never advertises empty review', () => {
  const pending = renderToStaticMarkup(createElement(ThreadChatHeader, props))
  assert.match(pending, /<header class="story-chat-header/)
  assert.match(pending, /min-w-0 flex-1 truncate/)
  assert.match(pending, /aria-label="Thread default creative mode"/)
  assert.match(pending, /aria-label="Latest run status"/)
  assert.match(pending, /running/)
  assert.doesNotMatch(pending, /Review changes|Execution Details/)
  const changed = renderToStaticMarkup(createElement(ThreadChatHeader, {
    ...props, showReview: true,
  }))
  assert.match(changed, />Review changes<\/button>/)
  const noThread = renderToStaticMarkup(createElement(ThreadChatHeader, {
    ...props, mode: null, status: null,
  }))
  assert.doesNotMatch(noThread, /Thread default creative mode|Latest run status/)
})

test('Review Changes requires real verified cumulative Git differences', () => {
  const route = source('routes/_protected/stories/$storyId/index.tsx')
  assert.match(route, /queryFn: \(\) => getThreadReview/)
  assert.match(route, /enabled: !!explorerThreadId && !!reviewRevision/)
  assert.match(route, /reviewAvailability\.data\?\.files\.length/)
  assert.match(route, /reviewAvailability\.data\.headSha === reviewRevision/)
  assert.match(route, /showReview=\{!creatingThread && hasReviewableChanges\}/)
  assert.match(route, /<ThreadChatHeader/)
  assert.doesNotMatch(route, /\{explorerThreadId && <Button[^}]*Review changes/)
  assert.match(route, /await setCreativeMode\(\{ data: \{ threadId: explorerThreadId, mode \} \}\)/)
})

test('Chat message styling overrides legacy unlayered list, section and header rules', () => {
  const chat = source('components/thread-chat.tsx')
  const styles = source('style.css')
  assert.match(chat, /thread-chat-message min-w-0 w-fit max-w-\[92%\]/)
  assert.match(chat, /ml-auto bg-secondary\/70/)
  assert.match(chat, /mr-auto bg-muted\/30/)
  assert.match(chat, /className="mx-auto my-0 grid w-full max-w-3xl gap-3 p-0"/)
  assert.doesNotMatch(chat, /<a href="#thread-execution-details"/)
  assert.doesNotMatch(chat, />Thread mode/)
  assert.match(styles, /header\.story-chat-header \{[^}]*flex-wrap: nowrap/)
  assert.match(styles, /section\[aria-label="Thread chat"\] \{[^}]*padding: 0; border: 0/)
  assert.match(styles, /li\.thread-chat-message \{ padding: \.7rem 1rem; border: 0; \}/)
  assert.match(styles, /li\.thread-chat-message > p \{ margin: 0; color: var\(--foreground\)/)
})
