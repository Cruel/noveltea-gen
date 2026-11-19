import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readyLocalPiOAuth, syncLocalPiOAuth } from './support/local-pi-oauth'

const now = 1_800_000_000_000
const cred = (access: string, minutes: number) => ({
  type: 'oauth' as const, access, expires: now + minutes * 60_000,
  refresh: 'intentionally-not-a-real-refresh-grant',
})

test('certification refreshes expiring local OAuth before copying any credentials', () => {
  let renewals = 0
  let token = cred('old-access', 3)
  const options = { now: () => now, renew: () => { renewals++; token = cred('new-access', 60) },
    read: () => token }
  const fresh = readyLocalPiOAuth('openai', 'gpt-6.1-sol', options)
  assert.equal(fresh.access, 'new-access')
  assert.equal(fresh.refresh, 'intentionally-not-a-real-refresh-grant')
  assert.equal(renewals, 1)
  assert.equal(readyLocalPiOAuth('openai', 'gpt-6.1-sol', options), fresh)
  assert.equal(renewals, 1, 'Already fresh credentials are not needlessly refreshed')
})

test('certification can renew an already-expired local token but fails closed on bad renewal', () => {
  let reads = 0
  const fresh = readyLocalPiOAuth('openai', 'gpt-6.1-sol', {
    now: () => now, renew: () => {},
    read: () => {
      if (!reads++) throw Error('Access token expired')
      return cred('fresh', 60)
    },
  })
  assert.equal(fresh.access, 'fresh')
  assert.equal(reads, 2)
  assert.throws(() => readyLocalPiOAuth('openai', 'gpt-6.1-sol', {
    now: () => now, read: () => cred('still-old', 1), renew: () => {},
  }), /sufficient validity/)
  assert.throws(() => readyLocalPiOAuth('openai', 'gpt-6.1-sol', {
    now: () => now, read: () => cred('old', 1),
    renew: () => { throw Error('secret or token data') },
  }), /Local Pi OAuth renewal failed/)
})

test('long-running certification syncs only fresh access tokens, never source refresh credentials', async () => {
  const updates: ReturnType<typeof cred>[] = []
  let renewals = 0
  const opts = { now: () => now, renew: () => { renewals++ },
    read: () => cred('rotated-access', 60) }
  const update = async (next: ReturnType<typeof cred>) => { updates.push(next) }
  const fresh = cred('first-access', 50)
  assert.equal(await syncLocalPiOAuth('openai', 'gpt-6-luna', fresh, update, opts), fresh)
  assert.equal(renewals, 0)
  assert.equal(updates.length, 0)
  const old = cred('first-access', 30)
  const next = await syncLocalPiOAuth('openai', 'gpt-6-luna', old, update, opts)
  assert.equal(renewals, 1)
  assert.equal(next.access, 'rotated-access')
  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.refresh, 'intentionally-not-a-real-refresh-grant')
  assert.equal(await syncLocalPiOAuth('openai', 'gpt-6-luna', next, update, opts), next)
  assert.equal(renewals, 1, 'An unchanged adequate access token does not trigger another refresh')
})

test('certification fails closed when local login cannot renew safely', async () => {
  let updates = 0
  const update = async () => { updates++ }
  await assert.rejects(syncLocalPiOAuth('openai', 'gpt-6-luna', cred('old', 15), update,
    { now: () => now, renew: () => {}, read: () => cred('old', 15) }), /sufficient validity/)
  await assert.rejects(syncLocalPiOAuth('openai', 'gpt-6-luna', cred('old', 15), update,
    { now: () => now, renew: () => { throw Error('login expired') } }), /login expired/)
  assert.equal(updates, 0, 'Failed renewal must never replace a valid persisted credential')
})
