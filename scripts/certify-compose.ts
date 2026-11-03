/**
 * #71: black-box, disposable one-command Compose certification.
 * Refuse every existing NovelTea volume/container; never mutate real Studio
 * data. Controller and its token are provisioned by Compose, not a host task.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

const root = resolve('.')
const volumes = ['noveltea-app', 'noveltea-state', 'noveltea-cache', 'noveltea-controller']
const env = { ...process.env }
const rawPort = process.env.NT_COMPOSE_CERT_PORT ?? '3000'
const webPort = Number(rawPort)
assert.ok(/^\d{1,5}$/.test(rawPort) && Number.isSafeInteger(webPort) &&
  webPort >= 1024 && webPort <= 65535, 'Invalid disposable Compose test port')
env.NT_STUDIO_HOST_PORT = String(webPort)
const probeId = randomUUID()
function docker(...args: string[]): string {
  return execFileSync('docker', args, { cwd: root, env, encoding: 'utf8',
    timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function preflight() {
  const flags = JSON.parse(docker('info', '--format', '{{json .SecurityOptions}}')) as string[]
  assert.ok(flags.some(v => /(^|=)rootless$/.test(v)), 'Refusing nonrootless Docker')
  assert.equal(docker('info', '--format', '{{.CgroupVersion}}/{{.CgroupDriver}}'), '2/systemd')
  for (const name of volumes) {
    assert.equal(docker('volume', 'ls', '-q', '--filter', 'name=^' + name + '$'), '',
      'Refusing to touch existing volume ' + name)
  }
  assert.equal(docker('ps', '-aq', '--filter', 'label=com.docker.compose.project=noveltea'),
    '', 'Refusing to touch existing NovelTea containers')
}
async function freeWebPort() {
  // Studio serves its OAuth callback on the same published HTTP port.
  for (const port of new Set([webPort])) {
    const server = createServer()
    server.once('error', () => {})
    try {
      server.listen(port, '127.0.0.1')
      await once(server, 'listening')
    } catch { throw Error('Port ' + port + ' is occupied; refusing to disturb an existing service') }
    finally { if (server.listening) server.close() }
  }
}
async function delay(ms: number) { await new Promise(resolve => setTimeout(resolve, ms)) }
async function checkWeb() {
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch('http://127.0.0.1:' + webPort + '/login', {
        signal: AbortSignal.timeout(1500),
      })
      if (response.status === 200) return
    } catch { /* still starting */ }
    await delay(300)
  }
  throw Error('Studio login did not become healthy after startup/restart')
}
const agentHealth = "const token=process.env.NT_AGENT_RPC_TOKEN;if(!token)process.exit(2);" +
  "fetch('http://127.0.0.1:7001/health',{headers:{authorization:'Bearer '+token}})" +
  ".then(r=>process.exit(r.status===200?0:1),()=>process.exit(3))"
const webToAgentHealth = "const token=process.env.NT_AGENT_RPC_TOKEN;if(!token)process.exit(2);" +
  "fetch('http://agent:7001/health',{headers:{authorization:'Bearer '+token}})" +
  ".then(r=>process.exit(r.status===200?0:1),()=>process.exit(3))"
async function checkAgent() {
  for (let i = 0; i < 50; i++) {
    try {
      docker('compose', 'exec', '-T', 'agent', 'node', '-e', agentHealth)
      docker('compose', 'exec', '-T', 'web', 'node', '-e', webToAgentHealth)
      return
    } catch (error) {
      if (i === 49) throw Error('Authenticated agent is not reachable from Studio', { cause: error })
      await delay(300)
    }
  }
}
async function checkController() {
  // Compose restart returns when the container starts, before the private
  // Unix socket is ready. Poll controller authentication at startup/restarts.
  for (let i = 0; i < 50; i++) {
    try {
      docker('compose', 'exec', '-T', 'controller', 'node', 'deploy/controller-health.mjs')
      break
    } catch (error) {
      if (i === 49) throw Error('Compose controller did not recover after restart', { cause: error })
      await delay(300)
    }
  }
  assert.match(docker('compose', 'exec', '-T', 'controller', 'docker', 'info',
    '--format', '{{json .SecurityOptions}}'), /rootless/)
  docker('compose', 'exec', '-T', 'agent', 'test', '-S', '/run/noveltea-controller/controller.sock')
  docker('compose', 'exec', '-T', 'agent', 'test', '-f', '/run/noveltea-controller/token')
  for (const service of ['agent', 'web']) {
    docker('compose', 'exec', '-T', service, 'test', '!', '-e', '/var/run/docker.sock')
    docker('compose', 'exec', '-T', service, 'test', '!', '-e', '/run/rootless-docker/docker.sock')
  }
  docker('compose', 'exec', '-T', 'web', 'test', '!', '-e', '/run/noveltea-controller/token')
  docker('compose', 'exec', '-T', 'web', 'test', '!', '-e', '/run/noveltea-controller/controller.sock')
}
function sqlite(service: 'web' | 'agent', db: string, statement: string): string {
  const code = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(db)});try{${statement}}finally{db.close()}`
  return docker('compose', 'exec', '-T', service, 'node', '-e', code)
}
function seed(service: 'web' | 'agent', file: string) {
  sqlite(service, file, `db.exec("CREATE TABLE certification_restart_probe (id TEXT PRIMARY KEY)");db.prepare("INSERT INTO certification_restart_probe VALUES (?)").run(${JSON.stringify(probeId)});`)
}
function checkSeed(service: 'web' | 'agent', file: string) {
  assert.equal(sqlite(service, file,
    'console.log(db.prepare("SELECT id FROM certification_restart_probe").get()?.id)'),
    probeId, 'Durable ' + service + ' data was lost across restart')
}
async function main() {
  preflight()
  await freeWebPort()
  docker('compose', 'config', '--quiet')
  let created = false
  try {
    created = true
    // The exact production command must be sufficient on a brand-new host
    // with its rootless daemon, built binaries and web/.env preconfigured.
    docker('compose', 'up', '-d', '--build')
    await checkWeb()
    await checkAgent()
    await checkController()
    // Test the fixed browser loopback callback and SDK's code handling using
    // a synthetic token response; no paid login or real credentials involved.
    assert.match(execFileSync('node', ['scripts/check-compose-oauth-loopback.mjs'],
      { cwd: root, env, encoding: 'utf8', timeout: 30_000 }), /PASS callback reaches TanStack/)
    docker('compose', 'exec', '-T', 'web', '/opt/noveltea/noveltea', '--version')
    docker('compose', 'exec', '-T', 'agent', 'test', '-f',
      '/opt/noveltea-skills/skills/nt-story-architecture/SKILL.md')
    // Exercise the real rootless daemon's Story subtree mount, not just
    // controller health: this catches sidecar/host-volume path mismatches.
    assert.match(docker('compose', 'exec', '-T', 'agent', 'node', '--import', 'tsx',
      'scripts/compose-sandbox-smoke.ts'), /PASS registered Compose job/)
    const app = '/var/lib/noveltea/app/studio.sqlite'
    const graph = '/var/lib/noveltea/state/compose-certification.sqlite'
    seed('web', app)
    seed('agent', graph)
    for (const service of ['web', 'agent', 'controller'] as const) {
      docker('compose', 'restart', service)
      await checkWeb()
      await checkAgent()
      await checkController()
      checkSeed('web', app)
      checkSeed('agent', graph)
    }
    // Confirm the operator-facing *plain* command survives a full down/up,
    // including the stale controller socket in its persistent IPC volume.
    docker('compose', 'down')
    docker('compose', 'up', '-d')
    await checkWeb()
    await checkAgent()
    await checkController()
    checkSeed('web', app)
    checkSeed('agent', graph)
    console.log('PASS one-command rootless Compose first boot, native tools, private controller/agent, independent restarts, and durable state')
  } finally {
    if (created) {
      try { docker('compose', 'down', '--volumes', '--remove-orphans') }
      catch (error) { throw Error('Compose teardown failed: inspect disposable named volumes before continuing', { cause: error }) }
    }
  }
}
await main()
