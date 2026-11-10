import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStudioReadinessGate } from '../src/db/studio-readiness'

test('readiness caches successful inspection, coalesces callers, and limits PostgreSQL staleness', async () => {
  let time = 1_000, inspections = 0
  const gate = createStudioReadinessGate({
    now: () => time,
    async attest() { inspections++; await Promise.resolve() },
  })
  await Promise.all(Array.from({ length: 30 }, () => gate.assertReady()))
  assert.equal(inspections, 1)
  for (let i = 0; i < 100; i++) await gate.assertReady()
  assert.equal(inspections, 1, 'warm ordinary requests do not inspect schema')
  time += 4_999
  await gate.assertReady()
  assert.equal(inspections, 1)
  time++
  await Promise.all([gate.assertReady(), gate.assertReady(), gate.assertReady()])
  assert.equal(inspections, 2, 'bounded lease forces one fresh inspection')
  await gate.close()
  await assert.rejects(gate.assertReady(), /closed/)
})

test('SQLite DDL invalidates immediately and failed attestation never becomes ready', async () => {
  let time = 1_000, version = 3, calls = 0, valid = true
  const gate = createStudioReadinessGate({
    now: () => time,
    schemaVersion: () => version,
    async attest() {
      calls++
      if (!valid) throw new Error('Schema drift detected')
    },
  })
  await gate.assertReady()
  await gate.assertReady()
  assert.equal(calls, 1)
  version++
  valid = false
  await assert.rejects(gate.assertReady(), /Schema drift/)
  await assert.rejects(gate.assertReady(), /Schema drift/)
  assert.equal(calls, 3, 'failure is not cached')
  valid = true
  await gate.assertReady()
  assert.equal(calls, 4)
  time += 5_000
  await gate.assertReady()
  assert.equal(calls, 5, 'non-DDL mutation eventually revalidated')
  await gate.close()
})

test('readiness rejects schema changes during inspection without caching success', async () => {
  let version = 1, inspected = 0
  const gate = createStudioReadinessGate({
    schemaVersion: () => version,
    async attest() { inspected++; version++ },
  })
  await assert.rejects(gate.assertReady(), /changed during readiness/)
  await assert.rejects(gate.assertReady(), /changed during readiness/)
  assert.equal(inspected, 2)
  await gate.close()
})

test('closing a store fences and drains pending readiness before closing drivers', async () => {
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const gate = createStudioReadinessGate({ attest: async () => waiting })
  const inspection = gate.assertReady()
  const closing = gate.close()
  release()
  await assert.rejects(inspection, /closed/)
  await closing
  await assert.rejects(gate.assertReady(), /closed/)
})

test('explicit migration invalidation revokes a warm cache immediately', async () => {
  let inspections = 0
  const gate = createStudioReadinessGate({ attest: async () => { inspections++ } })
  await gate.assertReady()
  await gate.assertReady()
  assert.equal(inspections, 1)
  gate.invalidate()
  await gate.assertReady()
  assert.equal(inspections, 2)
  await gate.close()
  assert.throws(() => gate.invalidate(), /closed/)
})

test('invalidation racing an in-flight inspection cannot cache stale readiness', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const gate = createStudioReadinessGate({
    attest: async () => { if (++calls === 1) await pending },
  })
  const request = gate.assertReady()
  gate.invalidate()
  release()
  await assert.rejects(request, /invalidated/)
  await gate.assertReady()
  assert.equal(calls, 2)
  await gate.close()
})

test('readiness interval cannot exceed bounded revalidation maximum', () => {
  assert.throws(() => createStudioReadinessGate({
    attest: async () => {}, maxAgeMs: 10_000,
  }), /1–5000/)
})
