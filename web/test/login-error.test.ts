import assert from 'node:assert/strict'
import { test } from 'node:test'
import { oauthLoginError } from '../src/lib/oauth-login-error'

test('account conflict suggests last successful browser provider without asserting account ownership', () => {
  const callback = new URLSearchParams({ error: 'account_not_linked' })
  assert.equal(oauthLoginError(callback, 'github'),
    'Email already in use. You last signed in here with GitHub. Try GitHub, then link this provider in Settings.')
  assert.equal(oauthLoginError(callback, 'gitlab'),
    'Email already in use. You last signed in here with GitLab. Try GitLab, then link this provider in Settings.')
  assert.equal(oauthLoginError(callback),
    'Email already in use. Sign in with your existing provider, then link this provider in Settings.')
  assert.equal(oauthLoginError(callback, 'other-provider'), oauthLoginError(callback))
  assert.equal(oauthLoginError(new URLSearchParams({ error: 'access_denied' }), 'github'),
    'Authorization was cancelled or denied by the provider.')
})
