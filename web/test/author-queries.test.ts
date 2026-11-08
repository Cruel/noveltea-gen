import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueryClient } from '@tanstack/react-query'
import { authorInteractionsKey, parseAuthorState, isAuthorState } from '../src/lib/author-state'

test('author decision observers share one parsed cache representation', () => {
  const jobId = 'cb8dece0-eeed-4625-abe0-f3d5d207b915'
  const raw = JSON.stringify({
    status: 'blocked', items: [], decisions: [], choice: null,
  })
  const state = parseAuthorState(raw)
  assert.deepEqual(state, { status: 'blocked', items: [], decisions: [], choice: null })
  const client = new QueryClient()
  const key = authorInteractionsKey(jobId)
  client.setQueryData(key, state)
  const stored = client.getQueryData<typeof state>(key)
  assert.ok(stored && Array.isArray(stored.items))
  assert.ok(stored && Array.isArray(stored.decisions))
  assert.equal(typeof stored, 'object', 'do not cache the raw JSON string')
  assert.equal(authorInteractionsKey(jobId)[1], jobId)
  assert.equal(isAuthorState(stored), true)
  assert.equal(isAuthorState(raw), false, 'a cached JSON string must not render as author decisions')
  client.clear()
})

test('malformed author state is rejected before it can enter the shared query cache', () => {
  assert.throws(() => parseAuthorState('{}'), /Incomplete author interaction response/)
  assert.throws(() => parseAuthorState('"string"'), /Invalid author interaction response/)
  assert.throws(() => parseAuthorState('{"status":"blocked","items":[],"decisions":null,"choice":null}'),
    /Incomplete author interaction response/)
  assert.throws(() => parseAuthorState('invalid json'), SyntaxError)
})
