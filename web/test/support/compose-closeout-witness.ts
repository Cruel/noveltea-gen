/** Credential-free Compose #143 data and least-privilege witness.
 * Runs inside a disposable Web or controller container, not on the host.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createStudioAuth, readAuthConfig } from '../../src/lib/auth'
import { openSharedStudioStore, selectedStudioDatabaseOptions } from '../../src/db/shared-studio-store'

const [operation, probe, owner] = process.argv.slice(2)
if (!operation || !probe) throw new Error('Expected operation and disposable witness ID')

if (operation === 'controller-permissions') {
  const { Client } = await import('pg')
  const client = new Client()
  await client.connect()
  try {
    assert.equal((await client.query('SELECT 1 AS connected')).rows[0].connected, 1)
    await client.query('SELECT count(*) FROM controller_catalog.trusted_jobs')
    for (const statement of [
      'SELECT * FROM public.pi_credentials',
      'SELECT * FROM public.git_connections',
      'SELECT * FROM public.studio_sessions',
      'UPDATE controller_catalog.trusted_jobs SET directory = \'bad\'',
      'CREATE TABLE public.s18_intrusion (id integer)',
      'CREATE TEMP TABLE s18_intrusion (id integer)',
    ]) {
      let denied = false
      try { await client.query(statement) }
      catch { denied = true }
      assert.ok(denied, 'Controller role unexpectedly permitted: ' + statement)
    }
    console.log('PASS controller restricted read-only trusted catalog')
  } finally {
    await client.end()
  }
} else {
  const store = openSharedStudioStore(selectedStudioDatabaseOptions())
  try {
    await store.assertReady()
    const repo = 's18-' + probe
    if (operation === 'seed') {
      const auth = createStudioAuth(store, readAuthConfig())
      const user = await (await auth.$context).internalAdapter.createUser({
        name: 'S18 disposable witness',
        email: 's18-' + randomUUID() + '@example.invalid',
        emailVerified: true,
      }, { method: 'test' })
      await store.persistence.repositories.upsert(user.id, 'github', repo,
        'Certification/Preserved', null, repo, new Date().toISOString())
      console.log('CERT_OWNER=' + user.id)
    } else if (operation === 'check') {
      if (!owner) throw new Error('Missing persisted owner from seed')
      const record = await store.persistence.repositories.get(owner, repo)
      assert.equal(record?.name, 'Certification/Preserved')
      assert.equal(await store.persistence.repositories.get('another-owner', repo), null)
      console.log('PASS durable StudioStore fixture across startup and service recreation')
    } else {
      throw new Error('Unsupported Compose witness operation: ' + operation)
    }
  } finally {
    await store.close()
  }
}
