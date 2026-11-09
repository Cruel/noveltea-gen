import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { resolve } from 'node:path'

type ComposeService = {
  network_mode?: string
  networks?: Record<string, unknown>
  depends_on?: Record<string, { condition: string }>
  environment?: Record<string, string>
  env_file?: unknown[]
  ports?: unknown[]
  volumes?: Array<{ source?: string; target?: string }>
  healthcheck?: unknown
}
type ComposeConfig = {
  services: Record<string, ComposeService>
  networks: Record<string, { internal?: boolean }>
  volumes: Record<string, { name?: string }>
}

const root = resolve(import.meta.dirname, '../..')
const credentials = {
  NT_PG_ADMIN_PASSWORD: 'test-admin-placeholder',
  NT_PG_APP_PASSWORD: 'test-app-placeholder',
  NT_PG_CONTROLLER_PASSWORD: 'test-reader-placeholder',
}

function config(postgres: boolean, certification = false): ComposeConfig {
  return JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        '--profile',
        'dev',
        '-f',
        'compose.yaml',
        ...(postgres ? ['-f', 'compose.postgres.yaml'] : []),
        ...(certification ? ['-f', 'compose.postgres.test.yaml'] : []),
        'config',
        '--no-env-resolution',
        '--format',
        'json',
      ],
      { cwd: root, encoding: 'utf8', env: { ...process.env, ...credentials } },
    ),
  )
}

function service(manifest: ComposeConfig, name: string): ComposeService {
  const found = manifest.services[name]
  assert.ok(found, 'missing Compose service ' + name)
  return found
}
function network(manifest: ComposeConfig, name: string) {
  const found = manifest.networks[name]
  assert.ok(found, 'missing Compose network ' + name)
  return found
}

test('PostgreSQL selection fails closed until shared Kysely startup is available', () => {
  const result = spawnSync(process.execPath, ['deploy/compose-init.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NT_STUDIO_DB_BACKEND: 'postgres' },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /PostgreSQL Studio persistence is not yet installed/)
})

test('default Compose keeps SQLite and a networkless rootless Docker controller', () => {
  const base = config(false)
  assert.ok(!base.services.postgres)
  assert.equal(service(base, 'controller').network_mode, 'none')
  assert.ok(!service(base, 'controller').networks)
  for (const name of ['init', 'web', 'web-dev', 'agent']) {
    assert.notEqual(service(base, name).environment?.NT_STUDIO_DB_BACKEND, 'postgres')
  }
})

test('disposable PostgreSQL tests do not load developer service environment files', () => {
  const pg = config(true, true)
  for (const name of ['init', 'web', 'web-dev', 'agent']) {
    assert.deepEqual(service(pg, name).env_file ?? [], [])
  }
})

test('PostgreSQL Compose keeps the controller on its own internal DB-only network', () => {
  const pg = config(true)
  const controller = service(pg, 'controller')
  const postgres = service(pg, 'postgres')
  assert.ok(!controller.network_mode, 'PostgreSQL override must reset network_mode: none')
  assert.deepEqual(Object.keys(controller.networks ?? {}), ['pg-controller'])
  assert.equal(network(pg, 'pg-controller').internal, true)
  assert.equal(network(pg, 'pg-app').internal, true)
  assert.deepEqual(Object.keys(postgres.networks ?? {}).sort(), ['pg-app', 'pg-controller'])
  for (const name of ['web', 'web-dev', 'agent', 'init']) {
    const current = service(pg, name)
    const networks = Object.keys(current.networks ?? {})
    assert.ok(networks.includes('pg-app'), `${name} must reach PostgreSQL`)
    assert.ok(!networks.includes('pg-controller'), `${name} must not reach controller`)
    assert.equal(current.environment?.NT_STUDIO_DB_BACKEND, 'postgres')
    assert.equal(current.environment?.PGHOST, 'postgres')
    assert.equal(current.environment?.PGUSER, 'noveltea_app')
    assert.equal(current.depends_on?.postgres?.condition, 'service_healthy')
  }
  assert.ok(!postgres.ports?.length, 'PostgreSQL port must not be host-published')
  assert.ok(postgres.healthcheck)
  assert.ok(pg.volumes['noveltea-postgres'])
  assert.equal(controller.environment?.PGUSER, 'noveltea_controller')
  assert.ok(!('NT_PG_APP_PASSWORD' in (controller.environment ?? {})))
  assert.ok(!('NT_PG_CONTROLLER_PASSWORD' in (service(pg, 'web').environment ?? {})))
  assert.ok(controller.volumes?.some((volume) => volume.target === '/run/rootless-docker/docker.sock'))
  for (const name of ['init', 'web', 'agent']) {
    assert.ok(
      !service(pg, name).volumes?.some((volume) => volume.target === '/run/rootless-docker/docker.sock'),
    )
  }
})
