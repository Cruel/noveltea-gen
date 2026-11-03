/**
 * Verify the production host loopback redirect is forwarded to the Studio
 * callback route. Successful Pi code exchange and concurrent state isolation
 * are tested with synthetic credentials in web/test/pi-oauth-external.test.ts.
 * No real authorization state, credentials, or provider HTTP requests are used.
 */
import assert from 'node:assert/strict'

const callback = 'http://127.0.0.1:1455/auth/callback'
const unknown = await fetch(callback + '?state=unregistered&code=synthetic&client_id=synthetic', {
  signal: AbortSignal.timeout(3000),
  redirect: 'manual',
})
assert.equal(unknown.status, 409, 'unknown OAuth states must not complete a login')
assert.match(unknown.headers.get('cache-control') ?? '', /no-store/)

const clean = await fetch(callback, { signal: AbortSignal.timeout(3000) })
assert.equal(clean.status, 200, 'host loopback must reach the TanStack Start callback route')
assert.match(await clean.text(), /Return to NovelTea Studio/)
assert.match(clean.headers.get('referrer-policy') ?? '', /no-referrer/)

console.log('PASS host 127.0.0.1:1455 -> TanStack callback route, unknown state rejected')
