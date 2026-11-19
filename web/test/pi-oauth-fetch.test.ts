import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withOpenAiOAuth401Retry } from '../src/lib/pi-oauth-fetch'

const url = 'https://api.openai.com/v1/responses'
const body = JSON.stringify({ model: 'gpt-6.1-sol', input: 'test' })
const request = (access = 'first') => ({
  method: 'POST', headers: { authorization: 'Bearer ' + access },
  body,
})

test('OpenAI request retries exactly once with a freshly rotated OAuth token on HTTP 401', async () => {
  const sent: Array<{ url: string; access: string | null; body: BodyInit | null | undefined }> = []
  let refreshed = 0
  const send: typeof fetch = async (input, init) => {
    sent.push({ url: String(input), access: new Headers(init?.headers).get('authorization'), body: init?.body })
    return new Response('', { status: sent.length === 1 ? 401 : 200 })
  }
  const wrapped = withOpenAiOAuth401Retry(send, async rejected => {
    refreshed++
    assert.equal(rejected, 'first')
    return 'second'
  })
  const response = await wrapped(url, request())
  assert.equal(response.status, 200)
  assert.equal(refreshed, 1)
  assert.deepEqual(sent, [
    { url, access: 'Bearer first', body },
    { url, access: 'Bearer second', body },
  ])
})

test('second unauthorized response is terminal and never triggers another refresh', async () => {
  let calls = 0
  let renewals = 0
  const wrapped = withOpenAiOAuth401Retry(async () => {
    calls++
    return new Response('', { status: 401 })
  }, async () => { renewals++; return 'new' })
  assert.equal((await wrapped(url, request())).status, 401)
  assert.equal(calls, 2)
  assert.equal(renewals, 1)
})

test('only eligible OpenAI bearer HTTP 401 requests are retryable', async () => {
  for (const status of [400, 403, 408, 429, 500, 503]) {
    let calls = 0, renewals = 0
    const wrapped = withOpenAiOAuth401Retry(async () => {
      calls++
      return new Response('', { status })
    }, async () => { renewals++; return 'new' })
    assert.equal((await wrapped(url, request())).status, status)
    assert.equal(calls, 1)
    assert.equal(renewals, 0)
  }

  for (const [target, init] of [
    ['https://other.example/v1/responses', request()],
    ['https://api.openai.com.attacker.invalid/v1/responses', request()],
    [url, { method: 'POST', headers: {}, body }],
    [url, { ...request(), method: 'PATCH' }],
    [url, { ...request(), body: new Uint8Array([1, 2]) }],
  ] as Array<[string, RequestInit]>) {
    let renewals = 0
    let calls = 0
    const wrapped = withOpenAiOAuth401Retry(async () => {
      calls++
      return new Response('', { status: 401 })
    }, async () => { renewals++; return 'new' })
    assert.equal((await wrapped(target, init)).status, 401)
    assert.equal(calls, 1)
    assert.equal(renewals, 0)
  }
})

test('API-key authentication failures keep their original 401 without an OAuth retry', async () => {
  let calls = 0
  const wrapped = withOpenAiOAuth401Retry(async () => {
    calls++
    return new Response('', { status: 401 })
  }, async () => null)
  assert.equal((await wrapped(url, request('api-key'))).status, 401)
  assert.equal(calls, 1)
})

test('failed or unchanged refresh stops before retrying and does not reveal credentials', async () => {
  const send = async () => new Response('', { status: 401 })
  for (const callback of [
    async () => undefined, async () => 'first',
    async (): Promise<string> => { throw Error('PRIVATE_REFRESH_GRANT') },
  ]) {
    let calls = 0
    const wrapped = withOpenAiOAuth401Retry(async () => {
      calls++
      return send()
    }, callback)
    await assert.rejects(wrapped(url, request()), error =>
      error instanceof Error && !error.message.includes('PRIVATE_REFRESH_GRANT') &&
      /refresh/.test(error.message))
    assert.equal(calls, 1, 'A failed renewal cannot replay the request')
  }
})
