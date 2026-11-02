/**
 * #71: black-box Compose/controller restart smoke with isolated, disposable
 * service state. Never attach to an existing NovelTea deployment or volume.
 * Does not represent OAuth, external provider, or real-Pi certification.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve('.')
const volumeNames = ['noveltea-app', 'noveltea-state', 'noveltea-cache']
const env = { ...process.env }
const rawPort = process.env.NT_COMPOSE_CERT_PORT ?? '3000'
const webPort = Number(rawPort)
assert.ok(/^\d{1,5}$/.test(rawPort) && Number.isSafeInteger(webPort) &&
  webPort >= 1024 && webPort <= 65535, 'Invalid disposable Compose test port')
env.NT_STUDIO_HOST_PORT = String(webPort)
const probeId = randomUUID()
function docker(...args: string[]): string {
  return execFileSync('docker', args, { cwd: root, env, encoding: 'utf8',
    timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function preflight() {
  const flags = JSON.parse(docker('info', '--format', '{{json .SecurityOptions}}')) as string[]
  assert.ok(flags.some(v => /(^|=)rootless$/.test(v)), 'Refusing nonrootless Docker')
  assert.equal(docker('info', '--format', '{{.CgroupVersion}}/{{.CgroupDriver}}'), '2/systemd')
  for (const name of volumeNames) {
    const found = execFileSync('docker', ['volume', 'ls', '-q', '--filter', 'name=^' + name + '$'],
      { encoding: 'utf8' }).trim()
    assert.equal(found, '', 'Refusing to touch existing volume ' + name)
  }
  assert.equal(docker('ps', '-aq', '--filter', 'label=com.docker.compose.project=noveltea'),
    '', 'Refusing to touch existing NovelTea containers')
}
async function freeWebPort() {
  const server = createServer()
  server.once('error', () => {})
  try {
    server.listen(webPort, '127.0.0.1')
    await once(server, 'listening')
  } catch { throw Error('Port ' + webPort + ' is occupied; refusing to disturb the existing service') }
  finally { if (server.listening) server.close() }
}
async function delay(ms: number) { await new Promise(resolve => setTimeout(resolve, ms)) }
async function httpSocket(path: string, bearer?: string): Promise<number> {
  return await new Promise((yes, no) => {
    const req = request({ socketPath: path, path: '/v1/sandboxes/ffffffff-ffff-4fff-8fff-ffffffffffff',
      headers: bearer ? { authorization: 'Bearer ' + bearer } : {}, timeout: 4000 },
    res => { res.resume(); res.on('end', () => yes(res.statusCode ?? 0)) })
    req.on('timeout', () => req.destroy(Error('Controller request timed out')))
    req.on('error', no)
    req.end()
  })
}
async function checkWeb() {
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch('http://127.0.0.1:' + webPort + '/login', {
        signal: AbortSignal.timeout(1500),
      })
      if (response.status === 200) return
    } catch { /* service booting */ }
    await delay(300)
  }
  throw Error('Web login did not recover after restart')
}
const clientProbe = [
  "const http=require('node:http'),fs=require('node:fs');",
  "const token=fs.readFileSync('/run/secrets/noveltea-controller-token','utf8').trim();",
  "const req=http.request({socketPath:'/run/noveltea-controller/controller.sock',",
  "path:'/v1/sandboxes/ffffffff-ffff-4fff-8fff-ffffffffffff',",
  "headers:{authorization:'Bearer '+token}},res=>{res.resume();",
  "res.on('end',()=>{console.log('HTTP',res.statusCode);process.exit(res.statusCode===404?0:1)})});",
  "req.on('error',e=>{console.error(e.message);process.exit(2)});req.end();",
].join('')
async function checkAgent() {
  assert.match(docker('compose', 'exec', '-T', 'agent', 'node', '-e', clientProbe), /HTTP 404/)
  const agentHealth = "const token=process.env.NT_AGENT_RPC_TOKEN;if(!token)process.exit(2);" +
    "fetch('http://127.0.0.1:7001/health',{headers:{authorization:'Bearer '+token}})" +
    ".then(r=>process.exit(r.status===200?0:1),()=>process.exit(3))"
  const webHealth = "const token=process.env.NT_AGENT_RPC_TOKEN;if(!token)process.exit(2);" +
    "fetch('http://agent:7001/health',{headers:{authorization:'Bearer '+token}})" +
    ".then(r=>process.exit(r.status===200?0:1),()=>process.exit(3))"
  // Docker marks a container as running before its Node entrypoint starts
  // listening. Test both the local agent and private Studio-to-agent bridge
  // with bounded retries, but fail certification if startup never succeeds.
  for (let i = 0; i < 50; i++) {
    try {
      docker('compose', 'exec', '-T', 'agent', 'node', '-e', agentHealth)
      docker('compose', 'exec', '-T', 'web', 'node', '-e', webHealth)
      break
    } catch (error) {
      if (i === 49) throw Error('Private agent did not become healthy or reachable from Studio', { cause: error })
      await delay(300)
    }
  }
  docker('compose', 'exec', '-T', 'web', 'test', '!', '-e', '/var/run/docker.sock')
  docker('compose', 'exec', '-T', 'agent', 'test', '!', '-e', '/var/run/docker.sock')
  docker('compose', 'exec', '-T', 'web', 'test', '!', '-e', '/run/secrets/noveltea-controller-token')
}
function sqlite(service: 'web'|'agent', db: string, statement: string): string {
  const code = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(db)});try{${statement}}finally{db.close()}`
  return docker('compose', 'exec', '-T', service, 'node', '-e', code)
}
function seed(service: 'web'|'agent', database: string) {
  sqlite(service, database, `db.exec("CREATE TABLE certification_restart_probe (id TEXT PRIMARY KEY)");db.prepare("INSERT INTO certification_restart_probe VALUES (?)").run(${JSON.stringify(probeId)});`)
}
function checkSeed(service: 'web'|'agent', database: string) {
  assert.equal(sqlite(service, database, `console.log(db.prepare("SELECT id FROM certification_restart_probe").get()?.id)`),
    probeId, service + ' durable state was lost')
}
async function main() {
  preflight()
  await freeWebPort()
  const dir = mkdtempSync(join(tmpdir(), 'nt-compose-cert-'))
  const tokenFile = join(dir, 'token')
  const socket = join(dir, 'controller.sock')
  const token = randomBytes(48).toString('hex')
  writeFileSync(tokenFile, token + '\n', { mode: 0o600 })
  Object.assign(env, { NT_CONTROLLER_SOCKET_DIR: dir, NT_CONTROLLER_TOKEN_FILE: tokenFile,
    NT_SANDBOX_SOCKET: socket, NT_SANDBOX_TOKEN_FILE: tokenFile })
  let controller: ChildProcess | undefined, created = false
  async function launchController() {
    controller = spawn(process.execPath, ['--import', 'tsx', 'web/src/host-controller.ts'],
      { cwd: root, env, stdio: 'ignore' })
    for (let i = 0; i < 80; i++) {
      if (controller.exitCode !== null) throw Error('Host controller quit before its socket was available')
      if (existsSync(socket)) return
      await delay(250)
    }
    throw Error('Host controller socket was not created')
  }
  async function stopController() {
    if (!controller) return
    const proc = controller
    controller = undefined
    if (proc.exitCode === null) {
      proc.kill('SIGTERM')
      await Promise.race([once(proc, 'exit'), delay(2000)])
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL')
        await once(proc, 'exit')
      }
    }
    if (existsSync(socket)) unlinkSync(socket)
  }
  try {
    docker('compose', 'config', '--quiet')
    // Rebuild from the checkout being certified, never silently reuse stale images.
    docker('compose', 'build', 'web')
    docker('build', '-f', 'deploy/sandbox.Dockerfile', '-t', 'noveltea-sandbox:local', '.')
    created = true
    docker('compose', 'create')
    await launchController()
    assert.equal(await httpSocket(socket), 401, 'Controller permits unauthenticated access')
    docker('compose', 'run', '--rm', '--no-deps', 'web', 'pnpm', '--filter', '@noveltea/studio', 'migrate')
    assert.equal(await httpSocket(socket, token), 404, 'Authenticated unknown job must be rejected')
    docker('compose', 'up', '-d', 'web', 'agent')
    await checkWeb()
    await checkAgent()
    const appDb = '/var/lib/noveltea/app/studio.sqlite'
    const graphDb = '/var/lib/noveltea/state/agent-certification-probe.sqlite'
    seed('web', appDb)
    seed('agent', graphDb)
    // Restart each independently, not just a combined Compose restart.
    docker('compose', 'restart', 'web')
    await checkWeb()
    checkSeed('web', appDb)
    await checkAgent()
    docker('compose', 'restart', 'agent')
    await checkAgent()
    checkSeed('agent', graphDb)
    checkSeed('web', appDb)
    // Controller runs outside Compose, and must be independently replaceable.
    await stopController()
    await launchController()
    assert.equal(await httpSocket(socket), 401)
    assert.equal(await httpSocket(socket, token), 404)
    await checkAgent()
    await checkWeb()
    checkSeed('web', appDb)
    checkSeed('agent', graphDb)
    console.log('PASS rootless Compose, private authenticated web-to-agent health, controller isolation, independent service restarts and persisted state')
  } finally {
    await stopController()
    let cleanupError: unknown
    if (created) {
      try { docker('compose', 'down', '--volumes', '--remove-orphans') }
      catch (error) { cleanupError = error }
    }
    rmSync(dir, { recursive: true, force: true })
    if (cleanupError) throw Error('Compose teardown failed; inspect leftover test volumes and containers',
      { cause: cleanupError })
  }
}
await main()
