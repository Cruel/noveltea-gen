/**
 * Verify the production host loopback redirect is forwarded to the Studio
 * callback route. Successful Pi code exchange and concurrent state isolation
 * are tested with synthetic credentials in web/test/pi-oauth-external.test.ts.
 * No real authorization state, credentials, or provider HTTP requests are used.
 */
import assert from 'node:assert/strict'

const callback = 'http://127.0.0.1:' + (process.env.NT_STUDIO_HOST_PORT ?? '3000') + '/auth/callback'
const unknown = await fetch(callback + '?state=unregistered&code=synthetic&client_id=synthetic', {
  signal: AbortSignal.timeout(3000),
  redirect: 'manual',
})
assert.equal(unknown.status, 409, 'unknown OAuth states must not complete a login')
assert.match(unknown.headers.get('cache-control') ?? '', /no-store/)

const completed = await fetch(callback + '?complete=1', { signal: AbortSignal.timeout(3000) })
assert.equal(completed.status, 200, 'host loopback must reach TanStack Start')
assert.match(await completed.text(), /oauth-popup-complete\.js/)
assert.match(completed.headers.get('referrer-policy') ?? '', /no-referrer/)
const script = await fetch(new URL('/oauth-popup-complete.js', callback),
  { signal: AbortSignal.timeout(3000) })
assert.equal(script.status, 200, 'production image must serve the popup completion script')
assert.match(await script.text(), /window\.close\(\)/)
console.log('PASS callback reaches TanStack, rejects unknown state, serves popup completion script')
