import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { openSharedStudioStore } from '../../src/db/shared-studio-store'
import { createStudioAuth } from '../../src/lib/auth'
import { storyChatDiscoveryRequest } from '../../src/lib/story-chat-discovery.server'

/** Resume a real Story Chat interrupt in a fresh OS process. No in-memory
 * checkpointer, model transport, or Studio connection is shared with the test. */
const input = JSON.parse(readFileSync(0, 'utf8')) as {
  options: Parameters<typeof openSharedStudioStore>[0]
  config: Parameters<typeof createStudioAuth>[1]
  url: string
  cookie: string
  storyId: string
  turnId: string
  submission: unknown
  questions: unknown[]
}
const store = openSharedStudioStore(input.options)
try {
  const auth = createStudioAuth(store, input.config)
  let calls = 0
  const response = await storyChatDiscoveryRequest(auth, store,
    new Request(input.url + '/api/story-chat-discovery', {
      method: 'POST', headers: { cookie: input.cookie, origin: input.url },
      body: JSON.stringify(input.submission),
    }), input.url, input.storyId, input.turnId, async state => {
      calls++
      assert.equal(state.accepted?.length, 1)
      assert.match(state.turns.at(-1)!.text, /Investigate a missing person/)
      return JSON.stringify({ phase: 'questions', questions: { questions: input.questions } })
    })
  assert.equal(calls, 1)
  process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }))
} finally {
  await store.close()
}
