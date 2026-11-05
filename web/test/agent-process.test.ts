import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from '../src/db/migrations'

const config = { baseURL: 'http://localhost:3000',
  secret: 'worker-process-test-secret-01234567890123456789',
  github: { clientId: 'gh', clientSecret: 'secret' },
  gitlab: { clientId: 'gl', clientSecret: 'secret' } }

async function unusedPort() {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve, reject) => probe.close(err => err ? reject(err) : resolve()))
  return port
}

test('dedicated agent is a real independent process with private authenticated command admission', {
  timeout: 20_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-agent-process-'))
  let child: ChildProcess | undefined
  try {
    const path = join(root, 'studio.sqlite')
    const database = openStudioDatabase(path)
    try { await migrateStudio(database, config) }
    finally { database.sqlite.close() }

    const port = await unusedPort()
    const token = randomBytes(48).toString('hex')
    child = spawn(process.execPath, ['--import', 'tsx', resolve('src/agent-worker.ts')], {
      cwd: resolve('.'),
      env: { ...process.env, NT_STUDIO_DB_PATH: path, NT_AGENT_PORT: String(port),
        NT_AGENT_RPC_TOKEN: token, NT_SANDBOX_SOCKET: join(root, 'controller.sock'),
        NT_SANDBOX_TOKEN_FILE: join(root, 'controller-token'),
        NT_REQUIRE_SANDBOX_TOOLS: '1', NT_REQUIRE_USER_PI_RUNTIME: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const endpoint = 'http://127.0.0.1:' + port
    let healthy = false
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) break
      try {
        const response = await fetch(endpoint + '/health', {
          headers: { authorization: 'Bearer ' + token },
          signal: AbortSignal.timeout(350),
        })
        if (response.status === 200) { healthy = true; break }
      } catch { /* agent has not finished initializing */ }
      await new Promise(resolve => setTimeout(resolve, 75))
    }
    assert.equal(healthy, true, 'separate agent process must start and expose authenticated health')
    assert.equal((await fetch(endpoint + '/health')).status, 401)
    assert.equal((await fetch(endpoint + '/health',
      { headers: { authorization: 'Bearer invalid' } })).status, 401)
    assert.equal((await fetch(endpoint + '/unknown',
      { headers: { authorization: 'Bearer ' + token } })).status, 404)

    child.kill('SIGTERM')
    const [code, signal] = await once(child, 'exit')
    assert.equal(signal, null)
    assert.equal(code, 0)
    child = undefined
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
    removeTestTree(root)
  }
})
