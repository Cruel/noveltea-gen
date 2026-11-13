import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { execFileSync, spawnSync, type spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { request } from 'node:http'
import { afterEach, test } from 'node:test'
import { createControllerFixtureDatabase } from './support/sqlite-controller-fixture'
import { SandboxClient } from '../../src/sandbox-client'
import { pinChatApprovedFoundation } from '../../src/chat-approved-foundation'
import { renderFoundation } from '../../src/foundation-record'
import type { JobStartResult } from '../../src/job'
import {
  createControllerServer, loadControllerConfig, resolveTrustedJob,
  SandboxController, SandboxError, verifyPinnedGenerationRevision,
  type CommandRunner, type ControllerConfig,
} from '../src/sandbox-controller'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function sha(s: string) { return createHash('sha256').update(s).digest('hex') }
const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const IMAGE = 'sha256:' + 'e'.repeat(64)

function fixture(directory = 'story', jobId = ID, configJson: string | null = null) {
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
  createControllerFixtureDatabase(appVolume, jobId, directory, configJson)
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

test('asynchronous catalog admission holds the job lock through acquire and dispose', async () => {
  const { config } = fixture()
  const { calls, run } = docker()
  const controller = new SandboxController(config, run)
  const pendingAcquire = controller.acquire(ID)
  await assert.rejects(controller.acquire(ID), /already in progress/)
  await assert.rejects(controller.dispose(ID), /executing or being acquired/)
  await pendingAcquire
  const pendingDispose = controller.dispose(ID)
  await assert.rejects(controller.acquire(ID), /already in progress/)
  await assert.rejects(controller.execute(ID, ['true'], () => {}), /active operation/)
  assert.equal((await pendingDispose).status, 'disposed')
  assert.equal(calls.filter(args => args[0] === 'create').length, 1)
})

test('registered Story job derives one trusted worktree and never mounts git or inbox', async () => {
  const { config, story } = fixture()
  mkdirSync(join(story, '..', '.story-inbox', 'ideas'), { recursive: true })
  writeFileSync(join(story, '..', '.story-inbox', 'ideas', 'secret.yaml'), 'never mounted')
  for (const name of ['events', 'choice-points', 'authored-content']) {
    mkdirSync(join(story, name), { recursive: true })
    writeFileSync(join(story, name, 'existing.md'), 'safe')
  }
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
  assert.deepEqual(mounts, [
    `type=bind,source=${story},target=/story,bind-propagation=rprivate`,
  ])
  assert.ok(!mounts[0]!.includes('.git') && !mounts[0]!.includes('.story-inbox'))
  assert.ok(!create.some(a => a.includes('docker.sock')))
  // New canonical directories are automatically visible without changing a mount allowlist.
  mkdirSync(join(story, 'new-record-type'))
  writeFileSync(join(story, 'new-record-type', 'note.md'), 'new')
  await controller.acquire(ID)
  assert.deepEqual(await controller.inspect(ID), { jobId: ID, status: 'running' })
  assert.deepEqual((await controller.dispose(ID)), { jobId: ID, status: 'disposed' })
})

test('historical generation pin must be the exact approved Foundation, not a forged ancestor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-generation-pin-'))
  roots.push(root)
  const repo = join(root, 'repo'), story = join(repo, 'story'), stateDir = join(root, 'state')
  mkdirSync(story, { recursive: true })
  mkdirSync(stateDir)
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Test Author')
  git('config', 'user.email', 'author@test.invalid')
  git('checkout', '-qb', 'noveltea-gen/verified-job')
  writeFileSync(join(story, 'README.txt'), 'Empty Story\n')
  git('add', '.'); git('commit', '-qm', 'Source baseline')
  const baseSha = git('rev-parse', 'HEAD')
  const job = {
    jobId: ID, baseSha, worktreeRoot: repo, worktreeStoryRoot: story,
    storyRelativePath: 'story', storyRoot: story, gitRoot: repo,
    stateDir, branch: 'noveltea-gen/verified-job', threadId: ID,
    validatorVersion: '1.0.0', status: 'ready', headSha: baseSha,
    cacheRoot: root,
  } as JobStartResult
  const draft = {
    id: 'foundation', title: 'A Mystery', premise: 'A train stops',
    central_conflict: 'The passenger disappears', genre: 'Mystery', tone: 'Eerie',
    player_experience: 'Investigate', scope: 'Overnight train',
    decisions: [{ id: 'train', statement: 'On an overnight train',
      origin: 'user' as const, authority: 'user-protected' as const }],
    body: 'The train must arrive before sunrise.',
  }
  await pinChatApprovedFoundation(job, {
    jobId: ID, sourceSha: baseSha, firstTurnId: ID, scope: 'whole-story',
    originalObjective: 'Make me a mystery game', proposalDigest: 'd'.repeat(64),
    skillId: 'b'.repeat(64), foundation: draft,
    creativeMode: 'autonomous', provider: 'openai', model: 'gpt-6-luna',
  })
  mkdirSync(join(story, 'creative-direction'))
  writeFileSync(join(story, 'creative-direction', 'foundation.md'), renderFoundation(draft))
  git('add', '.'); git('commit', '-qm', 'Approved foundation\n\nNovelTea-Job: ' + ID +
    '\nNovelTea-Work-Item: foundation')
  const foundationSha = git('rev-parse', 'HEAD')
  const foundationReceipt = {
    stage: 'committed', commitSha: foundationSha,
    authoredSha256: sha(renderFoundation(draft)),
  }
  writeFileSync(join(stateDir, 'foundation.json'), JSON.stringify(foundationReceipt))
  mkdirSync(join(story, 'arcs'))
  writeFileSync(join(story, 'arcs', 'opening.md'), 'A train mystery begins.\n')
  git('add', '.'); git('commit', '-qm', 'Architecture\n\nNovelTea-Job: ' + ID +
    '\nNovelTea-Work-Item: global-architecture')
  const verified = git('rev-parse', 'HEAD')
  const headReceipt = join(stateDir, 'revisions', 'verified-head.json')
  mkdirSync(join(stateDir, 'revisions'))
  writeFileSync(headReceipt, JSON.stringify({ version: 1, jobId: ID, headSha: verified,
    workItemId: 'global-architecture' }))
  assert.equal(await verifyPinnedGenerationRevision(job, baseSha, baseSha), true)
  assert.equal(await verifyPinnedGenerationRevision(job, foundationSha, baseSha), true)
  assert.equal(await verifyPinnedGenerationRevision(job, verified, baseSha), true)
  assert.equal(await verifyPinnedGenerationRevision(job, '0'.repeat(40), baseSha), false)
  assert.equal(await verifyPinnedGenerationRevision(job, foundationSha, 'f'.repeat(40)), false)
  writeFileSync(join(stateDir, 'foundation.json'), JSON.stringify({ ...foundationReceipt,
    authoredSha256: 'f'.repeat(64) }))
  assert.equal(await verifyPinnedGenerationRevision(job, foundationSha, baseSha), false)
  writeFileSync(join(stateDir, 'foundation.json'), JSON.stringify(foundationReceipt))
  const approvalPath = join(stateDir, 'chat-approved-foundation.json')
  const approval = readFileSync(approvalPath, 'utf8')
  writeFileSync(approvalPath, JSON.stringify({ ...JSON.parse(approval), firstTurnId: 'foreign' }))
  assert.equal(await verifyPinnedGenerationRevision(job, foundationSha, baseSha), false)
  writeFileSync(approvalPath, approval)
  git('checkout', '-qb', 'noveltea-gen/foreign-branch')
  assert.equal(await verifyPinnedGenerationRevision(job, foundationSha, baseSha), false)
  git('checkout', 'noveltea-gen/verified-job')
  writeFileSync(headReceipt, JSON.stringify({ version: 1, jobId: ID,
    headSha: 'e'.repeat(40), workItemId: 'global-architecture' }))
  await assert.rejects(() => verifyPinnedGenerationRevision(job, foundationSha, baseSha),
    /differs from the latest verified revision/)
})

const pinnedDraft = (limits: unknown, headSha = 'a'.repeat(40)) =>
  JSON.stringify({ version: 1, headSha, task: 'Story generation', limits, model: null })

test('controller derives per-job Docker ceilings only from pinned owner records, bounded by operator maxima', async () => {
  const { config } = fixture('story', ID,
    pinnedDraft({ cpu: 6, memoryMiB: 4096, pids: 900, activeSeconds: 30 }))
  config.maximums = { cpu: 2, memoryMiB: 768, pids: 200 }
  const resolved = await resolveTrustedJob(config, ID, IMAGE)
  assert.deepEqual(resolved.resources, { cpu: 2, memoryMiB: 768, pids: 200 })
  const { calls, run } = docker()
  const controller = new SandboxController(config, run)
  await controller.acquire(ID)
  const created = calls.find(args => args[0] === 'create')!
  const flag = (key: string) => created[created.indexOf(key) + 1]
  assert.equal(flag('--cpus'), '2')
  assert.equal(flag('--memory'), '768m')
  assert.equal(flag('--memory-swap'), '768m')
  assert.equal(flag('--pids-limit'), '200')
  assert.ok(created.includes('dev.noveltea.resources=' + resolved.resourceHash))
  await controller.acquire(ID)
  assert.equal(calls.filter(args => args[0] === 'create').length, 1)

  // Operator policy tightened after restart. Existing containers may be
  // disposed, but never reused with stale, excessive cgroup allowances.
  const tightened: ControllerConfig = { ...config,
    maximums: { cpu: 1, memoryMiB: 512, pids: 128 } }
  const restarted = new SandboxController(tightened, run)
  await assert.rejects(restarted.acquire(ID), /occupied by another identity/)
  assert.equal((await restarted.dispose(ID)).status, 'disposed')
  await restarted.acquire(ID)
  const second = calls.filter(args => args[0] === 'create').at(-1)!
  assert.equal(second[second.indexOf('--cpus') + 1], '1')
  assert.equal(second[second.indexOf('--memory') + 1], '512m')
})

test('missing, invalid and cross-job resource evidence never expands sandbox authority', async () => {
  const normal = fixture()
  const { calls, run } = docker()
  await new SandboxController(normal.config, run).acquire(ID)
  const defaults = calls.find(args => args[0] === 'create')!
  assert.equal(defaults[defaults.indexOf('--cpus') + 1], '1')
  assert.equal(defaults[defaults.indexOf('--memory') + 1], '512m')
  assert.equal(defaults[defaults.indexOf('--pids-limit') + 1], '128')

  for (const payload of [
    pinnedDraft({ cpu: -5 }),
    pinnedDraft({ cpu: 0 }),
    pinnedDraft({ cpu: '64' }),
    pinnedDraft({ memoryMiB: 7 }),
    pinnedDraft({ pids: 1.5 }),
    pinnedDraft({ cpu: 4, attackerSuppliedDockerFlags: ['--privileged'] }),
    pinnedDraft({ cpu: 4 }, 'b'.repeat(40)),
    '{invalid',
  ]) {
    const other = fixture('story', ID, payload)
    const dockerMock = docker()
    await assert.rejects(new SandboxController(other.config, dockerMock.run).acquire(ID),
      /resource configuration is invalid or unpinned/)
    assert.equal(dockerMock.calls.filter(args => args[0] === 'create').length, 0)
  }
})

test('Compose controller mounts only the vetted Story subpath of its named rootless volume', async () => {
  const { config, story } = fixture()
  config.sandboxCacheVolume = 'noveltea-cache'
  const { calls, run } = docker()
  const expected = story.slice(config.cacheVolume.length + 1).split('/').join('/')
  assert.equal((await resolveTrustedJob(config, ID, IMAGE)).storyRoot, story)
  assert.equal((await resolveTrustedJob(config, ID, IMAGE)).volumeSubpath, expected)
  await new SandboxController(config, run).acquire(ID)
  const create = calls.find(call => call[0] === 'create')!
  assert.ok(create.includes(`type=volume,source=noveltea-cache,target=/story,volume-subpath=${expected}`))
  assert.ok(!create.some(arg => arg.includes('type=bind')))
})

test('whole-root and nested author-inbox mounts fail closed instead of exposing trusted metadata', async () => {
  for (const directory of ['', 'legacy-story-root']) {
    const legacy = fixture(directory)
    const calls = docker()
    await assert.rejects(new SandboxController(legacy.config, calls.run).acquire(ID),
      /dedicated story\/ content directory/)
    assert.equal(calls.calls.filter(args => args[0] === 'create').length, 0)
  }

  const inboxStory = fixture()
  mkdirSync(join(inboxStory.story, '.story-inbox', 'ideas'), { recursive: true })
  writeFileSync(join(inboxStory.story, '.story-inbox', 'ideas', 'secret.yaml'), 'author-only')
  const inboxCalls = docker()
  await assert.rejects(new SandboxController(inboxStory.config, inboxCalls.run).acquire(ID),
    /hidden or restricted/)
  assert.equal(inboxCalls.calls.filter(args => args[0] === 'create').length, 0)
})

test('arbitrary UUID, mutated manifest and protected symlinks fail closed before Docker create', async () => {
  const { config, story, manifest, manifestPath } = fixture()
  const { run, calls } = docker()
  const controller = new SandboxController(config, run)
  await assert.rejects(resolveTrustedJob(config, 'ffffffff-ffff-4fff-8fff-ffffffffffff', IMAGE),
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

test('hidden entries, redirected paths, and special files are rejected before Docker is invoked', async () => {
  const invalid: Array<{ name: string; create: (story: string) => void; error: RegExp }> = [
    { name: 'hidden file', create: story => writeFileSync(join(story, '.env'), 'secret'), error: /hidden or restricted/ },
    { name: 'nested hidden directory', create: story => mkdirSync(join(story, 'arcs', '.private'), { recursive: true }), error: /hidden or restricted/ },
    { name: 'Git directory', create: story => mkdirSync(join(story, '.git')), error: /hidden or restricted/ },
    { name: 'symlink to host', create: story => symlinkSync('/etc', join(story, 'outside')), error: /unsupported or redirected/ },
    { name: 'nested symlink to sibling inbox', create: story => {
      mkdirSync(join(story, 'events'))
      symlinkSync('../../.story-inbox', join(story, 'events', 'inbox'))
    }, error: /unsupported or redirected/ },
  ]
  if (process.platform !== 'win32') {
    invalid.push({ name: 'FIFO special file', create: story => {
      const fifo = spawnSync('mkfifo', [join(story, 'reader')], { encoding: 'utf8' })
      assert.equal(fifo.status, 0, fifo.stderr)
    }, error: /unsupported or redirected/ });
  }
  for (const scenario of invalid) {
    const { config, story } = fixture()
    scenario.create(story)
    const { calls, run } = docker()
    await assert.rejects(new SandboxController(config, run).acquire(ID), scenario.error, scenario.name)
    assert.equal(calls.filter(args => args[0] === 'create').length, 0, scenario.name)
  }
})

test('old per-record container layouts are rejected, disposable, and never reused', async () => {
  const { config } = fixture()
  const { run, calls } = docker()
  let legacy = false
  const manipulated: CommandRunner = args => {
    const result = run(args)
    if (legacy && args[0] === 'container' && args[1] === 'inspect' && result.status === 0) {
      const labels = JSON.parse(result.stdout) as Record<string, string>
      labels['dev.noveltea.layout'] = 'record-mount-v1'
      return { ...result, stdout: JSON.stringify(labels) }
    }
    return result
  }
  const controller = new SandboxController(config, manipulated)
  await controller.acquire(ID)
  legacy = true
  await assert.rejects(controller.acquire(ID), /occupied by another identity/)
  await assert.rejects(controller.inspect(ID), /occupied by another identity/)
  assert.deepEqual((await controller.dispose(ID)), { jobId: ID, status: 'disposed' })
  legacy = false
  assert.equal((await controller.acquire(ID)).status, 'running')
  assert.equal(calls.filter(args => args[0] === 'create').length, 2)
  await controller.dispose(ID)
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

test('operator-only rootless controller settings validate resource maximums before startup', () => {
  const { config } = fixture()
  const tokenFile = join(config.appVolume, 'controller-secret')
  writeFileSync(tokenFile, config.token, { mode: 0o600 })
  const env = {
    NT_SANDBOX_SOCKET: config.socket, NT_SANDBOX_TOKEN_FILE: tokenFile,
    NT_SANDBOX_APP_VOLUME: 'app-operator-test',
    NT_SANDBOX_STATE_VOLUME: 'state-operator-test',
    NT_SANDBOX_CACHE_VOLUME: 'cache-operator-test',
    NT_SANDBOX_MAX_CPUS: '1.25',
    NT_SANDBOX_MAX_MEMORY_MIB: '640',
    NT_SANDBOX_MAX_PIDS: '96',
  }
  const run: CommandRunner = args => {
    if (args[0] === 'info') return { status: 0, stderr: '', stdout: args[2]?.includes('SecurityOptions')
      ? '["name=rootless"]' : '2/systemd' }
    if (args[0] === 'volume') return { status: 0, stderr: '',
      stdout: args[2] === 'app-operator-test' ? config.appVolume :
        args[2] === 'state-operator-test' ? config.stateVolume : config.cacheVolume }
    return { status: 1, stdout: '', stderr: 'Unexpected Docker call' }
  }
  const normal = loadControllerConfig(env, run)
  assert.deepEqual(normal.maximums, { cpu: 1.25, memoryMiB: 640, pids: 96 })
  assert.equal(normal.catalog, undefined, 'SQLite retains its own read-only volume catalog')
  const postgres = {
    ...env, NT_STUDIO_DB_BACKEND: 'postgres', PGHOST: 'postgres', PGPORT: '5432',
    PGDATABASE: 'noveltea', PGUSER: 'noveltea_controller', PGPASSWORD: 'reader-secret',
  }
  assert.deepEqual(loadControllerConfig(postgres, run).catalog, {
    backend: 'postgres', connection: {
      host: 'postgres', port: 5432, database: 'noveltea',
      user: 'noveltea_controller', password: 'reader-secret',
    },
  })
  for (const override of [
    { PGUSER: 'noveltea_app' }, { PGPASSWORD: '' }, { PGHOST: '' },
    { PGPORT: '0' }, { PGPORT: 'malicious' },
  ]) {
    assert.throws(() => loadControllerConfig({ ...postgres, ...override }, run),
      /restricted PostgreSQL catalog role|Invalid PostgreSQL trusted catalog port/)
  }
  for (const setting of [
    { NT_SANDBOX_MAX_CPUS: '0' }, { NT_SANDBOX_MAX_CPUS: '64.01' },
    { NT_SANDBOX_MAX_MEMORY_MIB: '1.5' }, { NT_SANDBOX_MAX_PIDS: '0' },
  ]) {
    assert.throws(() => loadControllerConfig({ ...env, ...setting }, run),
      /Invalid operator sandbox maximum/)
  }
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

/** Authorization now awaits the separate catalog before spawning Docker. */
async function waitForDockerExec(child: FakeDockerExec) {
  for (let i = 0; i < 200; i++) {
    if (child.stdout.listenerCount('data') && child.stderr.listenerCount('data')) return
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Fake Docker exec never attached its output listeners')
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
  await waitForDockerExec(child)

  await assert.rejects(controller.execute(ID, ['true'], () => {}), /active operation/)
  await assert.rejects(controller.dispose(ID), /executing or being acquired/)
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
  assert.deepEqual(await controller.inspect(ID), { jobId: ID, status: 'running' })
})

test('sandbox output overflow destroys the container and fails closed before reacquisition', async () => {
  const { config } = fixture()
  const { run, calls } = docker()
  const child = new FakeDockerExec()
  const controller = new SandboxController(config, run, (() => child) as unknown as typeof spawn)
  await controller.acquire(ID)
  const execution = controller.execute(ID, ['sh', '-c', 'yes'], () => {})
  await waitForDockerExec(child)
  child.stdout.write(Buffer.alloc(65 * 1024, 'x'))
  await assert.rejects(execution, /output limit/)
  assert.ok(calls.some(args => args[0] === 'rm' && args[2] === 'noveltea-job-' + ID))
  await assert.rejects(controller.inspect(ID), /has not been acquired/)
  assert.equal((await controller.acquire(ID)).status, 'running')
  await controller.dispose(ID)
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
  await waitForDockerExec(child)
  child.stdout.end()
  child.stderr.end()
  child.emit('close', 0)
  await assert.rejects(execution, /stopped writer boundary/)
  assert.ok(calls.some(args => args[0] === 'rm' && args[2] === 'noveltea-job-' + ID))
  await assert.rejects(controller.inspect(ID), /has not been acquired/)
})

test('dispose checks the job identity, not the current image tag, after rebuild/removal', async () => {
  const { config } = fixture()
  const { run, calls, setImage } = docker()
  const controller = new SandboxController(config, run)
  await controller.acquire(ID)
  setImage('sha256:' + 'b'.repeat(64))
  await assert.rejects(controller.inspect(ID), /occupied by another identity/)
  assert.deepEqual((await controller.dispose(ID)), { jobId: ID, status: 'disposed' })
  await controller.acquire(ID)
  setImage(null)
  assert.deepEqual((await controller.dispose(ID)), { jobId: ID, status: 'disposed' })
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
  const sibling = join(story, '..', 'other-job', 'story')
  mkdirSync(sibling, { recursive: true })
  writeFileSync(join(sibling, 'private.md'), 'other job private record')
  const inbox = join(story, '..', '.story-inbox', 'ideas')
  mkdirSync(inbox, { recursive: true })
  writeFileSync(join(inbox, 'private.yaml'), 'author only')
  const credential = join(config.appVolume, 'controller-secret')
  writeFileSync(credential, 'controller credential')
  const name = 'noveltea-job-' + ID
  const inspect = (format: string) => JSON.parse(execFileSync('docker', [
    'inspect', name, '--format', format,
  ], { encoding: 'utf8' })) as Record<string, unknown> | Array<Record<string, unknown>>
  const controller = new SandboxController(config)
  try {
    await controller.acquire(ID)
    const mounts = inspect('{{json .Mounts}}') as Array<Record<string, unknown>>
    assert.equal(mounts.length, 1, 'No extra bind, Docker volume, or host filesystem mount')
    assert.equal(mounts[0]?.Type, 'bind')
    assert.equal(mounts[0]?.Source, story)
    assert.equal(mounts[0]?.Destination, '/story')
    const host = inspect('{{json .HostConfig}}') as Record<string, unknown>
    assert.equal(host.NetworkMode, 'none')
    assert.equal(host.ReadonlyRootfs, true)
    assert.equal(host.Memory, 512 * 1024 * 1024)
    assert.equal(host.MemorySwap, 512 * 1024 * 1024)
    assert.equal(host.PidsLimit, 128)
    assert.equal(host.NanoCpus, 1_000_000_000)
    assert.deepEqual(host.CapDrop, ['ALL'])
    assert.ok((host.SecurityOpt as string[]).includes('no-new-privileges'))
    const actualLimits: string[] = []
    assert.equal(await controller.execute(ID,
      ['sh', '-c', 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/pids.max /sys/fs/cgroup/cpu.max'],
      (_stream, data) => actualLimits.push(data)), 0)
    const [memory, swap, pids, cpu] = actualLimits.join('').trim().split('\n')
    assert.equal(memory, String(512 * 1024 * 1024), 'Actual memory cgroup limit')
    assert.equal(swap, '0', 'Actual swap allowance must be disabled')
    assert.equal(pids, '128', 'Actual process cgroup limit')
    assert.match(cpu ?? '', /^\d+ \d+$/, 'Actual CPU quota exists')
    const [quota, period] = cpu!.split(' ').map(Number)
    assert.equal(quota, period, 'Actual CPU quota is one CPU')
    // A regression that only checks for absent delayed writes could pass if
    // the sandbox never had write access at all. Prove the authorized bind
    // is writable before checking that background descendants are stopped.
    assert.equal(await controller.execute(ID,
      ['sh', '-c', 'printf allowed > /story/events/allowed.md'], () => {}), 0)
    assert.equal(readFileSync(join(story, 'events', 'allowed.md'), 'utf8'), 'allowed')
    mkdirSync(join(story, 'future-record-type'))
    writeFileSync(join(story, 'future-record-type', 'new.md'), 'new content type')
    const evidence: string[] = []
    assert.equal(await controller.execute(ID, ['sh', '-c',
      'test "$(cat /story/future-record-type/new.md)" = "new content type" && ' +
      'test ! -e /run/secrets && test ! -e /var/run/docker.sock && ' +
      'test ! -e /story/.git && test ! -e /story/.story-inbox && ' +
      'test ! -e /story/../.git && test ! -e /story/../.story-inbox && ' +
      '! touch /etc/forbidden 2>/dev/null && ' +
      'for path in "$@"; do if test -e "$path" || test -S "$path"; then echo "exposed:$path"; exit 41; fi; done; echo isolated',
      'nt-probe', join(sibling, 'private.md'), join(inbox, 'private.yaml'), credential,
      config.socket, config.stateVolume, config.cacheVolume, '/var/run/docker.sock',
      '/story/../other-job/story/private.md'], (_stream, data) => evidence.push(data)), 0, evidence.join(''))
    assert.equal(evidence.join('').trim(), 'isolated')
    const deniedWrites: string[] = []
    assert.equal(await controller.execute(ID, ['sh', '-c',
      'for path in "$@"; do if printf breach > "$path" 2>/dev/null; then echo "write-exposed:$path"; exit 42; fi; done; echo denied',
      'nt-write-probe', join(sibling, 'private.md'), join(inbox, 'private.yaml'), credential,
      '/story/../.git', '/story/../other-job/story/private.md'],
      (stream, data) => { if (stream === 'stdout') deniedWrites.push(data) }), 0, deniedWrites.join(''))
    assert.equal(deniedWrites.join('').trim(), 'denied')
    assert.equal(readFileSync(join(sibling, 'private.md'), 'utf8'), 'other job private record')
    assert.equal(readFileSync(join(inbox, 'private.yaml'), 'utf8'), 'author only')
    assert.equal(readFileSync(credential, 'utf8'), 'controller credential')

    const status = await controller.execute(ID,
      ['sh', '-c', '(sleep 2; printf late >> /story/events/late.md) >/dev/null 2>&1 &'],
      () => {})
    assert.equal(status, 0)
    await new Promise<void>(resolve => setTimeout(resolve, 2400))
    assert.equal(readFileSync(join(story, 'events', 'late.md'), 'utf8'), '')
    assert.equal((await controller.inspect(ID)).status, 'running')
    execFileSync('docker', ['kill', name])
    assert.equal((await controller.inspect(ID)).status, 'stopped')
    assert.equal((await controller.acquire(ID)).status, 'running', 'Restart stopped sandbox')
    assert.equal(await controller.execute(ID, ['true'], () => {}), 0)
    execFileSync('docker', ['rm', '-f', name])
    await assert.rejects(controller.inspect(ID), /has not been acquired/)
    await assert.rejects(controller.execute(ID, ['true'], () => {}), /has not been acquired/)
    assert.equal((await controller.acquire(ID)).status, 'running', 'Recreate lost sandbox')
    assert.equal(await controller.execute(ID, ['sh', '-c', 'test -f /story/events/allowed.md'], () => {}), 0)
    assert.equal((await controller.dispose(ID)).status, 'disposed')
    assert.equal((await controller.dispose(ID)).status, 'absent')
    assert.equal((await controller.acquire(ID)).status, 'running', 'Reacquire disposed sandbox')
  } finally { (await controller.dispose(ID)) }
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
    assert.equal((await send(true, { jobId: ID, mount: '/etc' })).status, 400)
    assert.equal((await send(true, { jobId: ID, ownerId: 'other-user', cpu: 64, memoryMiB: 65536 })).status, 400)
    assert.equal((await send(true, { jobId: ID })).status, 201)
    assert.equal(calls.filter(v => v[0] === 'create').length, 1)
    assert.ok(!calls.some(v => v.includes('/etc') || v.includes('65536')))
  } finally { server.close(); await once(server, 'close') }
})
