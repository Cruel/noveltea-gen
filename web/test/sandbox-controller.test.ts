import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync, type spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { request } from 'node:http'
import { afterEach, test } from 'node:test'
import Database from 'better-sqlite3'
import { SandboxClient } from '../../src/sandbox-client'
import {
  createControllerServer, loadControllerConfig, resolveTrustedJob,
  SandboxController, SandboxError, type CommandRunner, type ControllerConfig,
} from '../src/sandbox-controller'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function sha(s: string) { return createHash('sha256').update(s).digest('hex') }
const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const IMAGE = 'sha256:' + 'e'.repeat(64)

function fixture(directory = 'story', jobId = ID) {
  const root = mkdtempSync(join(tmpdir(), 'noveltea-sandbox-'))
  roots.push(root)
  const appVolume = join(root, 'app'), stateVolume = join(root, 'state'), cacheVolume = join(root, 'cache')
  for (const dir of [appVolume, stateVolume, cacheVolume]) mkdirSync(dir)
  const config: ControllerConfig = {
    socket: join(root, 'socket', 'controller.sock'), token: 't'.repeat(64),
    appVolume, stateVolume, cacheVolume, image: 'noveltea-sandbox:local',
    containerState: '/var/lib/noveltea/state',
    containerCache: '/var/lib/noveltea/cache',
  }
  const db = new Database(join(appVolume, 'studio.sqlite'))
  db.exec(`CREATE TABLE studio_sessions (id TEXT, owner_user_id TEXT, story_id TEXT, source_commit_sha TEXT);
    CREATE TABLE stories (id TEXT, owner_user_id TEXT, repository_id TEXT, directory TEXT);
    CREATE TABLE repositories (id TEXT, owner_user_id TEXT, provider TEXT, provider_repository_id TEXT);`)
  db.prepare('INSERT INTO repositories VALUES (?,?,?,?)').run('repo-id', 'owner-1', 'github', '987')
  db.prepare('INSERT INTO stories VALUES (?,?,?,?)').run('story-id', 'owner-1', 'repo-id', directory)
  db.prepare('INSERT INTO studio_sessions VALUES (?,?,?,?)').run(jobId, 'owner-1', 'story-id', 'a'.repeat(40))
  db.close()
  const scoped = join(sha('owner-1'), sha('github:987'))
  const gitRoot = join(config.containerCache, scoped, 'base')
  const identity = sha(JSON.stringify([gitRoot, directory, jobId]))
  const repoRoot = join(config.containerCache, scoped)
  const stateDir = join(config.containerState, 'jobs', identity)
  const worktreeRoot = join(repoRoot, 'worktrees', identity)
  const path = join(cacheVolume, scoped, 'worktrees', identity)
  const story = join(path, directory)
  mkdirSync(story, { recursive: true })
  mkdirSync(join(stateVolume, 'jobs', identity), { recursive: true })
  writeFileSync(join(path, '.git'), 'gitdir: ' + gitRoot + '/.git/worktrees/' + identity + '\n')
  const registry = join(cacheVolume, scoped, 'base', '.git', 'worktrees', identity)
  mkdirSync(registry, { recursive: true })
  writeFileSync(join(registry, 'gitdir'), join(worktreeRoot, '.git') + '\n')
  writeFileSync(join(registry, 'HEAD'), 'ref: refs/heads/noveltea-gen/' + identity + '\n')
  const manifest = {
    version: 1, jobId, gitRoot, gitCommonDir: join(gitRoot, '.git'),
    storyRoot: join(gitRoot, directory), storyRelativePath: directory, baseSha: 'a'.repeat(40),
    branch: 'noveltea-gen/' + identity, stateDir, cacheRoot: repoRoot, worktreeRoot,
    worktreeStoryRoot: join(worktreeRoot, directory),
  }
  const manifestPath = join(stateVolume, 'jobs', identity, 'job.json')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return { config, path, story, manifest, manifestPath }
}

function docker() {
  const calls: string[][] = []
  const containers = new Map<string, Record<string, string>>()
  let started = false
  let image: string | null = IMAGE
  const run: CommandRunner = args => {
    calls.push(args)
    if (args[0] === 'image') return { stdout: image ?? '', stderr: '', status: image ? 0 : 1 }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const result = containers.get(args[2]!)
      return { stdout: result ? JSON.stringify(result) : '', stderr: '', status: result ? 0 : 1 }
    }
    if (args[0] === 'create') {
      const name = args[args.indexOf('--name') + 1]!
      containers.set(name, Object.fromEntries(args.filter((v, i) => args[i-1] === '--label').map(v => v.split('=').length > 1 ? [v.slice(0,v.indexOf('=')),v.slice(v.indexOf('=')+1)] : [v,''])))
    }
    if (args[0] === 'start') started = true
    if (args[0] === 'stop') started = false
    if (args[0] === 'rm') containers.delete(args[2]!)
    if (args[0] === 'inspect' && args[1] === 'noveltea-job-' + ID)
      return { stdout: String(started), stderr: '', status: 0 }
    return { stdout: '', stderr: '', status: 0 }
  }
  return { calls, run, setImage: (next: string | null) => { image = next } }
}

test('registered Story job derives one trusted worktree and never mounts git or inbox', async () => {
  const { config, story } = fixture('')
  mkdirSync(join(story, '.story-inbox', 'ideas'), { recursive: true })
  writeFileSync(join(story, '.story-inbox', 'ideas', 'secret.yaml'), 'never mounted')
  mkdirSync(join(story, 'events'), { recursive: true })
  writeFileSync(join(story, 'events', 'existing.md'), 'safe')
  const { calls, run } = docker()
  const controller = new SandboxController(config, run)
  const acquired = await controller.acquire(ID)
  assert.equal(acquired.status, 'running')
  const create = calls.find(a => a[0] === 'create')!
  assert.ok(create.includes('none'))
  assert.ok(create.includes('--read-only'))
  assert.ok(create.includes('no-new-privileges'))
  assert.ok(create.includes('ALL'))
  const mounts = create.filter((v, i) => create[i-1] === '--mount')
  assert.equal(mounts.length, 12)
  assert.ok(mounts.every(v => v.includes('/story/') && !v.includes('.git') && !v.includes('.story-inbox')))
  assert.ok(mounts.some(v => v.includes('source=' + join(story, 'events'))))
  assert.ok(!create.some(a => a.includes('docker.sock')))
  assert.deepEqual(controller.inspect(ID), { jobId: ID, status: 'running' })
  assert.deepEqual(controller.dispose(ID), { jobId: ID, status: 'disposed' })
})

test('arbitrary UUID, mutated manifest and protected symlinks fail closed before Docker create', async () => {
  const { config, story, manifest, manifestPath } = fixture()
  const { run, calls } = docker()
  const controller = new SandboxController(config, run)
  assert.throws(() => resolveTrustedJob(config, 'ffffffff-ffff-4fff-8fff-ffffffffffff', IMAGE),
    (e: unknown) => e instanceof SandboxError && e.status === 404)
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, worktreeStoryRoot: '/etc' }))
  await assert.rejects(controller.acquire(ID), /trusted identity/)
  assert.equal(calls.filter(v => v[0] === 'create').length, 0)
  writeFileSync(manifestPath, JSON.stringify(manifest))
  mkdirSync(join(story, 'events'), { recursive: true })
  const { symlinkSync } = await import('node:fs')
  symlinkSync('/etc', join(story, 'events', 'forbidden'))
  await assert.rejects(controller.acquire(ID), /unsupported or redirected/)
  assert.equal(calls.filter(v => v[0] === 'create').length, 0)
})

test('a Git pointer to another job branch cannot authorize a mount', async () => {
  const { config, story } = fixture()
  const { run, calls } = docker()
  writeFileSync(join(story, '..', '.git'), 'gitdir: ' + config.containerCache + '/unrelated/.git/worktrees/other\n')
  await assert.rejects(new SandboxController(config, run).acquire(ID), /unsafe filesystem identity/)
  assert.equal(calls.filter(v => v[0] === 'create').length, 0)
})

test('rootless precondition rejects regular Docker before reading host storage', () => {
  assert.throws(() => loadControllerConfig({}, args => ({
    stdout: args[0] === 'info' ? JSON.stringify(['name=seccomp,profile=builtin']) : '/tmp',
    stderr: '', status: 0,
  })), /ROOTLESS Docker/)
})

test('trusted agent client acquires and streams execution through the private Unix socket', async () => {
  const { config } = fixture()
  mkdirSync(join(config.socket, '..'), { recursive: true })
  const tokenFile = join(config.appVolume, 'controller-token')
  writeFileSync(tokenFile, config.token, { mode: 0o600 })
  const { run } = docker()
  const controller = new SandboxController(config, run)
  // Exercise the transport and streaming shape without invoking a real daemon.
  controller.execute = async (_id, _argv, onData) => {
    onData('stdout', 'part one')
    onData('stdout', 'part two')
    return 0
  }
  const server = createControllerServer(controller)
  server.listen(config.socket)
  await once(server, 'listening')
  const client = new SandboxClient(config.socket, tokenFile)
  try {
    assert.equal((await client.acquire(ID)).status, 'running')
    const output: string[] = []
    const code = await client.execute(ID, ['sh', '-c', 'echo test'], (_stream, text) => output.push(text))
    assert.deepEqual(output, ['part one', 'part two'])
    assert.equal(code, 0)
    assert.equal((await client.inspect(ID)).status, 'running')
    assert.equal((await client.dispose(ID)).status, 'disposed')
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('uppercase persisted job UUIDs retain their exact Git identity through client transport', async () => {
  const upperId = ID.toUpperCase()
  const { config } = fixture('story', upperId)
  mkdirSync(join(config.socket, '..'), { recursive: true })
  const tokenFile = join(config.appVolume, 'controller-token')
  writeFileSync(tokenFile, config.token, { mode: 0o600 })
  const { run } = docker()
  const server = createControllerServer(new SandboxController(config, run))
  server.listen(config.socket)
  await once(server, 'listening')
  try {
    const client = new SandboxClient(config.socket, tokenFile)
    assert.equal((await client.acquire(upperId)).jobId, upperId)
    assert.equal((await client.inspect(upperId)).jobId, upperId)
  } finally { server.close(); await once(server, 'close') }
})

class FakeDockerExec extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  kill() { return true }
}

test('exec terminates all container descendants before reporting a writer boundary; streams UTF-8 safely', async () => {
  const { config } = fixture()
  const { calls, run } = docker()
  const child = new FakeDockerExec()
  const spawnExec = (() => child) as unknown as typeof spawn
  const controller = new SandboxController(config, run, spawnExec)
  await controller.acquire(ID)
  const out: string[] = []
  const err: string[] = []
  const execution = controller.execute(ID, ['sh', '-c', '(sleep 60; echo late >> /story/events/x.md) &'],
    (stream, data) => (stream === 'stdout' ? out : err).push(data))

  await assert.rejects(controller.execute(ID, ['true'], () => {}), /active operation/)
  assert.throws(() => controller.dispose(ID), /executing or being acquired/)
  const accent = Buffer.from('café')
  const emoji = Buffer.from('🍵')
  child.stdout.write(accent.subarray(0, 4))
  child.stdout.write(accent.subarray(4))
  child.stderr.write(emoji.subarray(0, 2))
  child.stderr.write(emoji.subarray(2))
  child.stdout.end()
  child.stderr.end()
  // A successful foreground exit must not resolve the request until the
  // sandbox has stopped (killing descendants) and restarted its clean init.
  child.emit('close', 0)
  assert.equal(await execution, 0)
  assert.equal(out.join(''), 'café')
  assert.equal(err.join(''), '🍵')
  const stop = calls.findIndex(args => args[0] === 'stop')
  assert.ok(stop > 0)
  assert.deepEqual(calls[stop]!.slice(0, 4), ['stop', '--time', '0', 'noveltea-job-' + ID])
  assert.ok(calls.slice(stop + 1).some(args => args[0] === 'start'))
  assert.deepEqual(controller.inspect(ID), { jobId: ID, status: 'running' })
})

test('failed Docker stop cannot turn a foreground exit into a successful execution boundary', async () => {
  const { config } = fixture()
  const { run, calls } = docker()
  const child = new FakeDockerExec()
  const failingStop: CommandRunner = args =>
    args[0] === 'stop' ? { stdout: '', stderr: '', status: 1 } : run(args)
  const controller = new SandboxController(config, failingStop,
    (() => child) as unknown as typeof spawn)
  await controller.acquire(ID)
  const execution = controller.execute(ID, ['sh', '-c', 'true'], () => {})
  child.stdout.end()
  child.stderr.end()
  child.emit('close', 0)
  await assert.rejects(execution, /stopped writer boundary/)
  assert.ok(calls.some(args => args[0] === 'rm' && args[2] === 'noveltea-job-' + ID))
  assert.throws(() => controller.inspect(ID), /has not been acquired/)
})

test('dispose checks the job identity, not the current image tag, after rebuild/removal', async () => {
  const { config } = fixture()
  const { run, calls, setImage } = docker()
  const controller = new SandboxController(config, run)
  await controller.acquire(ID)
  setImage('sha256:' + 'b'.repeat(64))
  assert.throws(() => controller.inspect(ID), /occupied by another identity/)
  assert.deepEqual(controller.dispose(ID), { jobId: ID, status: 'disposed' })
  await controller.acquire(ID)
  setImage(null)
  assert.deepEqual(controller.dispose(ID), { jobId: ID, status: 'disposed' })
  assert.equal(calls.filter(args => args[0] === 'rm').length, 2)
})

test('sandbox client decodes NDJSON whose UTF-8 accents and emoji split across socket chunks', async () => {
  const { config } = fixture()
  mkdirSync(join(config.socket, '..'), { recursive: true })
  const tokenFile = join(config.appVolume, 'controller-token')
  writeFileSync(tokenFile, config.token, { mode: 0o600 })
  const server = createServer(async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    const payload = Buffer.from('{"stream":"stdout","data":"café 🍵"}\n{"exitCode":0}\n')
    const accent = payload.indexOf(Buffer.from('é'))
    const emoji = payload.indexOf(Buffer.from('🍵'))
    for (const chunk of [
      payload.subarray(0, accent + 1),
      payload.subarray(accent + 1, emoji + 2),
      payload.subarray(emoji + 2),
    ]) {
      res.write(chunk)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    res.end()
  })
  server.listen(config.socket)
  await once(server, 'listening')
  try {
    const out: string[] = []
    const client = new SandboxClient(config.socket, tokenFile)
    assert.equal(await client.execute(ID, ['echo', 'ignored'], (_stream, value) => out.push(value)), 0)
    assert.equal(out.join(''), 'café 🍵')
  } finally { server.close(); await once(server, 'close') }
})

test('real rootless Docker stops delayed background writers before returning success', {
  skip: process.env.NT_TEST_ROOTLESS_SANDBOX !== '1' &&
    'Set NT_TEST_ROOTLESS_SANDBOX=1 on a cgroup-v2/systemd rootless Docker host with the sandbox image.',
}, async () => {
  const flags = JSON.parse(execFileSync('docker', ['info', '--format', '{{json .SecurityOptions}}'], {
    encoding: 'utf8',
  })) as string[]
  assert.ok(flags.some(flag => /(^|=)rootless$/.test(flag)), 'Requires a rootless Docker daemon')
  assert.equal(execFileSync('docker', ['info', '--format', '{{.CgroupVersion}}/{{.CgroupDriver}}'], {
    encoding: 'utf8',
  }).trim(), '2/systemd')
  const { config, story } = fixture()
  config.image = process.env.NT_TEST_SANDBOX_IMAGE || 'noveltea-sandbox:local'
  mkdirSync(join(story, 'events'))
  writeFileSync(join(story, 'events', 'late.md'), '')
  const controller = new SandboxController(config)
  try {
    await controller.acquire(ID)
    // A regression that only checks for absent delayed writes could pass if
    // the sandbox never had write access at all. Prove the authorized bind
    // is writable before checking that background descendants are stopped.
    assert.equal(await controller.execute(ID,
      ['sh', '-c', 'printf allowed > /story/events/allowed.md'], () => {}), 0)
    assert.equal(readFileSync(join(story, 'events', 'allowed.md'), 'utf8'), 'allowed')
    assert.equal(await controller.execute(ID, ['sh', '-c',
      'test ! -e /story/.git && test ! -e /story/.story-inbox && ' +
      'test ! -e /run/secrets && test ! -e /var/run/docker.sock && ' +
      '! touch /etc/forbidden 2>/dev/null'], () => {}), 0)

    const status = await controller.execute(ID,
      ['sh', '-c', '(sleep 2; printf late >> /story/events/late.md) >/dev/null 2>&1 &'],
      () => {})
    assert.equal(status, 0)
    await new Promise<void>(resolve => setTimeout(resolve, 2400))
    assert.equal(readFileSync(join(story, 'events', 'late.md'), 'utf8'), '')
    assert.equal(controller.inspect(ID).status, 'running')
  } finally { controller.dispose(ID) }
})

test('controller HTTP rejects missing bearer, only accepts registered opaque job ids', async () => {
  const { config } = fixture()
  const { run, calls } = docker()
  const server = createControllerServer(new SandboxController(config, run))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  const send = (auth: boolean, payload: object) => new Promise<{ status: number; body: string }>((yes, no) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/v1/sandboxes', method: 'POST',
      headers: { ...(auth ? { authorization: 'Bearer ' + config.token } : {}), 'content-type': 'application/json' },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => yes({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', no)
    req.end(JSON.stringify(payload))
  })
  try {
    assert.equal((await send(false, { jobId: ID })).status, 401)
    assert.equal((await send(true, { jobId: '../../other-worktree' })).status, 400)
    assert.equal((await send(true, { jobId: ID, mount: '/etc' })).status, 201)
    assert.equal(calls.filter(v => v[0] === 'create').length, 1)
    assert.ok(!calls.some(v => v.includes('/etc')))
  } finally { server.close(); await once(server, 'close') }
})
