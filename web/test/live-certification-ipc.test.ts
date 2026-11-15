import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { existsSync, statSync } from 'node:fs'
import { once } from 'node:events'
import { test } from 'node:test'
import { createLiveCertificationIpc } from './support/live-certification-ipc'

test('durable certification roots use short private live-only Unix transport', async () => {
  const first = createLiveCertificationIpc()
  const second = createLiveCertificationIpc()
  const server = createServer()
  try {
    assert.notEqual(first.socket, second.socket)
    assert.ok(Buffer.byteLength(first.socket) < 104)
    assert.equal(statSync(first.directory).mode & 0o777, 0o700)
    server.listen(first.socket)
    await once(server, 'listening')
    assert.ok(existsSync(first.socket))
    assert.ok(existsSync(second.directory))
  } finally {
    if (server.listening) {
      server.close()
      await once(server, 'close')
    }
    first.dispose()
    second.dispose()
  }
  assert.equal(existsSync(first.directory), false)
  assert.equal(existsSync(second.directory), false)
})
