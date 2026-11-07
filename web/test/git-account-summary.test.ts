import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountForRepository, credentialForAccount, gitAccounts } from '../src/lib/git-accounts'

test('Git accounts merge matching login and repository identities for both providers', () => {
  const settings = {
    loginMethods: [
      { id: 'login-gh', provider: 'github' as const, accountId: '42' },
      { id: 'login-gl', provider: 'gitlab' as const, accountId: '43' },
    ],
    gitConnections: [
      { id: 'gh', provider: 'github' as const, accountId: '42', login: 'cruel',
        status: 'connected' as const, accessExpiresAt: null },
      { id: 'gl', provider: 'gitlab' as const, accountId: '43', login: 'cruel',
        status: 'connected' as const, accessExpiresAt: null },
      { id: 'other', provider: 'github' as const, accountId: '99', login: 'other',
        status: 'reauthorize' as const, accessExpiresAt: null },
    ],
  }
  const accounts = gitAccounts(settings)
  assert.equal(accounts.length, 3, 'matching provider/account identities should appear only once')
  assert.deepEqual(accounts.map(account => [account.key, account.loginMethod]),
    [['github:42', true], ['github:99', false], ['gitlab:43', true]])
  const gh = accounts.find(account => account.key === 'github:42')!
  const gl = accounts.find(account => account.key === 'gitlab:43')!
  assert.equal(gh.login, 'cruel')
  assert.equal(gl.login, 'cruel')
  assert.equal(credentialForAccount(gh, 1), 'gh')
  assert.equal(credentialForAccount(gl, 1), 'gl')
  assert.equal(credentialForAccount(accounts.find(account => account.key === 'github:99')!, 1), undefined,
    'unauthorized connections must not become repository binding choices')
  assert.equal(accountForRepository({ id: 'a', provider: 'github', name: 'cruel/story', connectionId: null }, accounts)?.key,
    'github:42')
  assert.equal(accountForRepository({ id: 'b', provider: 'gitlab', name: 'cruel/story', connectionId: 'gl' }, accounts)?.key,
    'gitlab:43')
})

test('login-only accounts are first-class and ambiguous login bindings remain unassigned', () => {
  const settings = {
    loginMethods: [
      { id: 'a', provider: 'github' as const, accountId: '11' },
      { id: 'b', provider: 'github' as const, accountId: '12' },
      { id: 'c', provider: 'gitlab' as const, accountId: '13', login: 'cruel' },
    ],
    gitConnections: [],
  }
  const accounts = gitAccounts(settings)
  assert.equal(accounts.find(a => a.key === 'gitlab:13')?.login, 'cruel',
    'verified names from login-backed accounts appear in the unified account list')
  assert.equal(credentialForAccount(accounts.find(a => a.key === 'gitlab:13')!, 1), null,
    'login authorization is a valid repository selection')
  assert.equal(credentialForAccount(accounts.find(a => a.key === 'github:11')!, 2), undefined,
    'multiple login identities cannot silently select a credential')
  assert.equal(accountForRepository({ id: 'a', provider: 'github', name: 'test', connectionId: null }, accounts), null)
  assert.equal(accountForRepository({ id: 'b', provider: 'gitlab', name: 'test', connectionId: null }, accounts)?.key,
    'gitlab:13')
})
