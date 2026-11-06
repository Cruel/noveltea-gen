import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { activePiTurn, observePiTurnLifecycle, registerPiTurn, type ActivePiTurn }
  from '../src/live-pi-registry'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function testTurn(): ActivePiTurn {
  return {
    jobId: randomUUID(), token: randomUUID(), workItem: 'character-foundations',
    expectedHead: 'a'.repeat(40),
    session: { sessionId: randomUUID(), isStreaming: true, messages: [],
      steer: async () => 'queued', followUp: async () => 'queued',
    } as unknown as ActivePiTurn['session'],
  }
}

test('asynchronous Pi lifecycle never exposes an uncommitted turn or reuses a pending owner', async () => {
  const turn = testTurn()
  const registered = deferred(), closed = deferred()
  const calls: string[] = []
  observePiTurnLifecycle(async (owner, phase) => {
    assert.equal(owner, turn)
    calls.push(phase)
    if (phase === 'registered') await registered.promise
    else await closed.promise
  })
  try {
    const registration = registerPiTurn(turn)
    assert.equal(activePiTurn(turn.jobId), undefined, 'turn stays invisible while storage is pending')
    await assert.rejects(registerPiTurn(turn), /already registered/)
    registered.resolve()
    const unregister = await registration
    assert.equal(activePiTurn(turn.jobId), turn, 'turn is visible only after durable registration')
    const closing = unregister()
    assert.equal(activePiTurn(turn.jobId), turn, 'do not prematurely remove the ownership fence')
    await assert.rejects(registerPiTurn(turn), /already registered/)
    closed.resolve()
    await closing
    assert.equal(activePiTurn(turn.jobId), undefined)
    assert.deepEqual(calls, ['registered', 'closed'])
  } finally {
    registered.resolve()
    closed.resolve()
    observePiTurnLifecycle(undefined)
  }
})

test('failed async registration or closure fails closed and permits deliberate retry', async () => {
  const turn = testTurn()
  let failRegistration = true, failClosure = true
  observePiTurnLifecycle(async (_, phase) => {
    if (phase === 'registered' && failRegistration)
      throw new Error('unavailable storage')
    if (phase === 'closed' && failClosure)
      throw new Error('unavailable storage')
  })
  try {
    await assert.rejects(registerPiTurn(turn), /unavailable storage/)
    assert.equal(activePiTurn(turn.jobId), undefined)
    failRegistration = false
    const unregister = await registerPiTurn(turn)
    await assert.rejects(unregister(), /unavailable storage/)
    assert.equal(activePiTurn(turn.jobId), turn, 'failed close must preserve the live owner')
    await assert.rejects(registerPiTurn(turn), /already registered/)
    failClosure = false
    await unregister()
    assert.equal(activePiTurn(turn.jobId), undefined)
  } finally {
    observePiTurnLifecycle(undefined)
  }
})
