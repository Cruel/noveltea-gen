import assert from 'node:assert/strict'
import { test } from 'node:test'
import { retryReadOnlyPreflight } from '../src/lib/read-only-preflight-retry'

const busy = () => Object.assign(new Error('database temporarily locked'), { code: 'SQLITE_BUSY' })

test('read-only transient preflight retries at most three times without new writer admissions', async () => {
  let reads = 0, guards = 0, writers = 0
  const result = await retryReadOnlyPreflight(async () => {
    reads++
    if (reads <= 2) throw busy()
    return 'ready'
  }, async () => { guards++; assert.equal(writers, 0) })
  assert.equal(result, 'ready')
  assert.equal(reads, 3)
  assert.ok(guards >= reads)
  assert.equal(writers, 0)

  reads = 0
  await assert.rejects(() => retryReadOnlyPreflight(async () => {
    reads++; throw busy()
  }, async () => {}), /temporarily locked/)
  assert.equal(reads, 3)
})

test('unknown, nontransient failures and changed source states are never retried', async () => {
  let calls = 0
  await assert.rejects(() => retryReadOnlyPreflight(async () => {
    calls++; throw new Error('validator rejected revision')
  }, async () => {}), /validator rejected/)
  assert.equal(calls, 1)

  let source = 'a'.repeat(40)
  calls = 0
  await assert.rejects(() => retryReadOnlyPreflight(async () => {
    calls++
    source = 'b'.repeat(40)
    throw busy()
  }, async () => {
    if (source !== 'a'.repeat(40)) throw new Error('source revision changed')
  }), /source revision changed/)
  assert.equal(calls, 1, 'never repeat a read after exact-source verification fails')
})
