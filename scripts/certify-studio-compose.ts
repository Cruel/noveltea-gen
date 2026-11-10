/**
 * #143 disposable full-stack Compose closeout.
 * Never reuses, resets or deletes the operator's database or named volumes.
 * This requires an existing rootless daemon, native CLI and skills checkout.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

const backend = process.argv[2]
assert.ok(backend === 'sqlite' || backend === 'postgres',
  'Usage: pnpm certify:studio-compose sqlite|postgres')
const root = resolve('.')
const project = 'nt-s18-' + randomUUID().replaceAll('-', '').slice(0, 12)
const files = [
  '-f', 'compose.yaml',
  ...(backend === 'postgres' ? ['-f', 'compose.postgres.yaml'] : []),
  '-f', 'compose.studio-cert.yaml', // Generated disposable credentials; never inherit web/.env
]
const random = () => randomBytes(36).toString('hex')
const names = ['app', 'state', 'cache', 'controller', 'postgres']
const volumes = Object.fromEntries(names.map(name => [name, project + '-' + name]))
const env = {
  ...process.env,
  NT_APP_VOLUME_NAME: volumes.app,
  NT_STATE_VOLUME_NAME: volumes.state,
  NT_CACHE_VOLUME_NAME: volumes.cache,
  NT_CONTROLLER_VOLUME_NAME: volumes.controller,
  NT_PG_VOLUME_NAME: volumes.postgres,
  NT_PG_ADMIN_PASSWORD: random(),
  NT_PG_APP_PASSWORD: random(),
  NT_PG_CONTROLLER_PASSWORD: random(),
  NT_AGENT_RPC_TOKEN: random(),
  NT_PI_CREDENTIAL_KEY: random(),
  BETTER_AUTH_SECRET: random(),
  GITHUB_CLIENT_ID: 'disposable-ci-github',
  GITHUB_CLIENT_SECRET: random(),
  GITLAB_CLIENT_ID: 'disposable-ci-gitlab',
  GITLAB_CLIENT_SECRET: random(),
  NT_NATIVE_CLI_HOST: process.env.NT_NATIVE_CLI_HOST ??
    resolve(root, '../nt/build/cli/linux/noveltea'),
  NT_SKILLS_HOST: process.env.NT_SKILLS_HOST ??
    resolve(root, '../noveltea-skills'),
}
const probeId = randomUUID()
function docker(...args: string[]) {
  return execFileSync('docker', args, {
    cwd: root, env, encoding: 'utf8', timeout: 220_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
function compose(...args: string[]) {
  return docker('compose', '-p', project, ...files, ...args)
}
function getServiceId(service: string) {
  const id = compose('ps', '-q', service)
  assert.ok(id, service + ' did not start')
  return id
}
function inspectNetworks(service: string): string[] {
  return Object.keys(JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Networks}}',
    getServiceId(service))) as Record<string, unknown>)
}
function assertTopology() {
  const expected = project + '_pg-controller'
  if (backend === 'sqlite') {
    assert.equal(docker('inspect', '-f', '{{.HostConfig.NetworkMode}}', getServiceId('controller')), 'none')
  } else {
    assert.deepEqual(inspectNetworks('controller'), [expected],
      'Daemon-facing controller must have no shared Web/Agent network')
    const pgs = inspectNetworks('postgres')
    assert.ok(pgs.includes(project + '_pg-controller') && pgs.includes(project + '_pg-app'))
    for (const service of ['web', 'agent']) {
      assert.ok(!inspectNetworks(service).includes(expected),
        service + ' unexpectedly joined the controller-only DB network')
    }
    assert.equal(docker('port', getServiceId('postgres')), '',
      'PostgreSQL host port was published')
    const dns = [
      "const dns=require('node:dns').promises;",
      "Promise.all([dns.lookup('postgres').then(()=>true,()=>false),",
      "dns.lookup('web').then(()=>true,()=>false),",
      "dns.lookup('agent').then(()=>true,()=>false)]).then(x=>process.exit(",
      "x[0]&&!x[1]&&!x[2]?0:2))",
    ].join('')
    compose('exec', '-T', 'controller', 'node', '-e', dns)
    assert.match(compose('exec', '-T', '-w', '/app/web', 'controller', 'pnpm', 'exec',
      'tsx', 'test/support/compose-closeout-witness.ts',
      'controller-permissions', probeId), /PASS controller restricted/)
  }
}
function witness(operation: 'seed' | 'check', owner?: string) {
  return compose('exec', '-T', '-w', '/app/web', 'web',
    'pnpm', 'exec', 'tsx', 'test/support/compose-closeout-witness.ts',
    operation, probeId, ...(owner ? [owner] : []))
}
function checkWeb() {
  assert.match(compose('ps', '--format', 'json'), /"Health": "healthy"|"Health":"healthy"/,
    'Compose has no healthy services')
  const response = spawnSync('curl', ['--fail', '--silent', '--output', '/dev/null',
    '--write-out', '%{http_code}', 'http://127.0.0.1:' + env.NT_STUDIO_HOST_PORT + '/login'],
    { encoding: 'utf8', timeout: 7000 })
  assert.equal(response.status, 0, response.stderr)
  assert.equal(response.stdout, '200')
}
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((yes, no) => {
    server.once('error', no)
    server.listen(0, '127.0.0.1', () => yes())
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>(done => server.close(() => done()))
  return port
}
async function main() {
  const security = JSON.parse(docker('info', '--format', '{{json .SecurityOptions}}')) as string[]
  assert.ok(security.some(s => /(^|=)rootless$/.test(s)), 'Refusing nonrootless Docker')
  assert.ok(existsSync(env.NT_NATIVE_CLI_HOST), 'Missing native CLI for real Compose startup')
  assert.ok(existsSync(env.NT_SKILLS_HOST), 'Missing native skills checkout')
  for (const volume of Object.values(volumes)) {
    const found = spawnSync('docker', ['volume', 'inspect', volume], { cwd: root, env,
      stdio: 'ignore' })
    assert.notEqual(found.status, 0, 'Refusing existing volume ' + volume)
  }
  assert.equal(docker('ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project), '')
  const port = await freePort()
  env.NT_STUDIO_HOST_PORT = String(port)
  env.BETTER_AUTH_URL = 'http://localhost:' + port
  compose('config', '--quiet')
  const plan = JSON.parse(compose('config', '--format', 'json')) as {
    volumes: Record<string, { name: string }>
    services: Record<string, { environment?: Record<string, string> }>
  }
  for (const [key, value] of Object.entries(volumes)) {
    if (key === 'postgres' && backend === 'sqlite') continue
    assert.equal(plan.volumes['noveltea-' + key]?.name, value,
      'Certification may not attach a developer volume: ' + key)
  }
  for (const key of ['app', 'state', 'cache']) {
    assert.equal(plan.services.controller?.environment?.['NT_SANDBOX_' + key.toUpperCase() + '_VOLUME'],
      volumes[key], 'Controller must inspect its own disposable ' + key + ' volume')
  }
  let attempted = false
  try {
    attempted = true
    console.log('S18 ' + backend + ': starting isolated Compose project ' + project)
    compose('up', '-d', process.env.NT_CERT_REUSE_LOCAL_IMAGES === '1' ? '--no-build' : '--build',
      '--wait', '--wait-timeout', '180')
    assert.match(compose('logs', '--no-color', 'init'), /database migrations ready/,
      'One-shot Kysely init did not complete successfully')
    assertTopology()
    checkWeb()
    console.log('S18 ' + backend + ': seeded runtime ready')
    const seeded = witness('seed')
    const match = seeded.match(/CERT_OWNER=([^\s]+)/)
    assert.ok(match, 'Failed to create real Better Auth + StudioStore fixture: ' + seeded)
    const owner = match[1]!
    witness('check', owner)
    for (const service of ['web', 'agent', 'controller', ...(backend === 'postgres' ? ['postgres'] : [])]) {
      console.log('S18 ' + backend + ': restarting ' + service)
      compose('restart', service)
      compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '120')
      assertTopology()
      checkWeb()
      assert.match(witness('check', owner), /PASS durable StudioStore fixture/)
    }
    console.log('S18 ' + backend + ': full down/up')
    compose('down', '--remove-orphans')
    compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '180')
    assert.match(compose('logs', '--no-color', 'init'), /database migrations ready/,
      'Recreated one-shot init failed')
    assertTopology()
    checkWeb()
    assert.match(witness('check', owner), /PASS durable StudioStore fixture/)
    console.log('PASS #143 ' + backend + ' full Compose boot, migrations, Web/Agent/controller,' +
      ' persistence, service restarts, down/up, private DB topology and least-privilege access')
  } catch (error) {
    try { console.error('Disposable init/service diagnostics:\n' + compose('logs', '--no-color', '--tail', '65', 'init', 'controller', 'agent', 'web')) }
    catch { /* Preserve the original startup error if logs are unavailable. */ }
    throw error
  } finally {
    if (attempted) {
      try { compose('down', '--remove-orphans') }
      catch (error) { throw new Error('Disposable Compose teardown failed; inspect ' + project, { cause: error }) }
      // Never use down -v: the base Compose project has fixed legacy names in
      // older files. Delete only the names we generated and verified above.
      for (const volume of Object.values(volumes)) {
        const result = spawnSync('docker', ['volume', 'inspect', volume],
          { cwd: root, env, stdio: 'ignore' })
        if (result.status === 0) docker('volume', 'rm', volume)
      }
    }
  }
}
await main()
