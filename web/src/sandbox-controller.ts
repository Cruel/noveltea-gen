/**
 * Host-side rootless Docker sandbox controller (#51).
 *
 * Run on the HOST against the same rootless daemon as Compose. Never mount a
 * Docker socket in Studio, the graph worker, or a job sandbox. Requests carry
 * only an opaque registered job UUID; all filesystem roots are derived here.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, lstatSync, realpathSync, readdirSync, readFileSync, chmodSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { readTrustedControllerJob, type TrustedCatalogOptions, type TrustedControllerJobRow } from './db/trusted-catalog'
import { parseJobLimits } from '../../src/job-limits'
import { trustedHead } from '../../src/revision'
import { readChatApprovedFoundation } from '../../src/chat-approved-foundation'
import type { JobStartResult } from '../../src/job'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{40}$/i
import { SANDBOX_COMMAND_BYTES, SANDBOX_FILE_REQUEST_BYTES, SANDBOX_RECORD_BYTES,
  SANDBOX_COMMAND_OUTPUT_BYTES } from '../../src/sandbox-limits'
const LIMIT_BODY = SANDBOX_COMMAND_BYTES
const LIMIT_OUTPUT = SANDBOX_COMMAND_OUTPUT_BYTES

export class SandboxError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export interface ControllerConfig {
  socket: string
  token: string
  appVolume: string
  stateVolume: string
  cacheVolume: string
  /** Compose-only trusted volume name; mount exactly the validated Story
   * subpath rather than a bind beneath the rootless daemon's data directory. */
  sandboxCacheVolume?: string
  image: string
  /** The paths Studio/graph see for Compose-managed volumes, never HTTP inputs. */
  containerState: string
  containerCache: string
  /** Trusted environment only; HTTP and agent commands never set these. */
  maximums?: { cpu: number; memoryMiB: number; pids: number }
  /** A separate read-only Kysely catalog, never the Studio application store. */
  catalog?: TrustedCatalogOptions
}

export type CommandResult = { stdout: string; stderr: string; status: number }
export type CommandRunner = (args: string[]) => CommandResult

function shellFreeDocker(args: string[]): CommandResult {
  try {
    const result = execFileSync('docker', args, {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { stdout: result, stderr: '', status: 0 }
  } catch (error) {
    const e = error as Error & { status?: number }
    // Docker errors may contain host paths. Never expose them over the API.
    return { stdout: '', stderr: '', status: e.status || 1 }
  }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function within(base: string, child: string): boolean {
  const delta = resolve(child).slice(resolve(base).length)
  return resolve(child) === resolve(base) || (delta.startsWith(sep) && !delta.startsWith(sep + '..'))
}
function requirePlainDirectory(path: string): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path)
    throw new SandboxError(409, 'Job storage contains a redirected or unsupported directory.')
}
function safeSegment(segment: string): boolean {
  return segment.length > 0 && segment !== '.' && segment !== '..' &&
    !segment.includes('\\') && !segment.includes('\0') &&
    !segment.includes(',') && !segment.includes('=') &&
    !['.git', '.story-inbox'].includes(segment) && !segment.startsWith('.')
}
function canonicalStoryPath(directory: string): boolean {
  return directory === '' || (directory.split('/').every(safeSegment) &&
    !directory.endsWith('/') && !directory.startsWith('/'))
}

/**
 * Inspect each ancestor (including the volume root) before trusting a host path.
 * The Docker mount source is never copied out of the manifest or request.
 */
function checkAncestry(volumeRoot: string, target: string) {
  if (!within(volumeRoot, target)) throw new SandboxError(409, 'Job path leaves its configured volume.')
  const rel = target.slice(volumeRoot.length).split(sep).filter(Boolean)
  let parent = volumeRoot
  requirePlainDirectory(parent)
  for (const part of rel) {
    parent = join(parent, part)
    requirePlainDirectory(parent)
  }
}

/** Reject symlinks, special files and hidden inbox/Git paths even below records. */
function checkRecordTree(root: string) {
  let entries = 0
  const inspect = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++entries > 10000) throw new SandboxError(422, 'Story sandbox projection exceeds the bounded file count.')
      if (!safeSegment(entry.name)) {
        throw new SandboxError(422, 'Story contains a hidden or restricted file in its sandbox projection.')
      }
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        throw new SandboxError(422, 'Story contains an unsupported or redirected filesystem entry.')
      }
      if (entry.isDirectory()) inspect(join(dir, entry.name))
    }
  }
  inspect(root)
}

type Resources = { cpu: number; memoryMiB: number; pids: number }
type TrustedJob = { id: string; storyRoot: string; volumeSubpath: string; identity: string; imageId: string
  resources: Resources; resourceHash: string }
const defaults: Resources = { cpu: 1, memoryMiB: 512, pids: 128 }
const defaultMaximums: Resources = { cpu: 4, memoryMiB: 2048, pids: 512 }

/** Only a user-owned, pinned Studio draft supplies preferences. Enforce the
 * host operator's upper bound independently, including on reconnection. */
async function trustedResources(row: JobRow, config: ControllerConfig,
  revisionEvidence: boolean, verifyPinnedRevision: (pin: string) => Promise<boolean>): Promise<Resources> {
  let requested: ReturnType<typeof parseJobLimits> = {}
  if (row.configJson !== null) {
    try {
      const draft = JSON.parse(row.configJson) as Record<string, unknown>
      if (!draft || draft.version !== 1 || typeof draft.headSha !== 'string' ||
          !SHA.test(draft.headSha)) throw new Error('Invalid pinned generation config')
      // A pinned generation configuration records the *initial* authorized
      // checkpoint, not the moving HEAD after every specialist commit. Verify
      // both the original checkpoint and its descendant's Git/receipt chain.
      if ((draft.headSha !== row.pin || revisionEvidence) &&
          !await verifyPinnedRevision(draft.headSha))
        throw new Error('Generation configuration is not pinned to a verified Story revision')
      requested = parseJobLimits(draft.limits)
    } catch { throw new SandboxError(409, 'Trusted job resource configuration is invalid or unpinned.') }
  }
  const maxima = config.maximums ?? defaultMaximums
  return {
    cpu: Math.min(requested.cpu ?? defaults.cpu, maxima.cpu),
    memoryMiB: Math.min(requested.memoryMiB ?? defaults.memoryMiB, maxima.memoryMiB),
    pids: Math.min(requested.pids ?? defaults.pids, maxima.pids),
  }
}
/** The draft's immutable starting revision is either its original source,
 * its currently verified HEAD, or the single author-approved Foundation commit.
 * No arbitrary ancestor, forged metadata or moving unverified HEAD is authority. */
export async function verifyPinnedGenerationRevision(job: JobStartResult, pin: string,
  sourcePin: string): Promise<boolean> {
  if (!SHA.test(pin) || sourcePin !== job.baseSha) return false
  const head = await trustedHead(job)
  const actualBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
    cwd: job.worktreeRoot, encoding: 'utf8', timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'], env: cleanGitEnv(),
  }).trim()
  if (actualBranch !== job.branch) return false
  if (pin !== sourcePin && pin !== head) {
    const approval = await readChatApprovedFoundation(job)
    if (approval?.scope !== 'whole-story' || approval.firstTurnId !== job.jobId) return false
    const path = join(job.stateDir, 'foundation.json')
    if (!existsSync(path)) return false
    const foundation = JSON.parse(readFileSync(path, 'utf8')) as {
      stage?: string; commitSha?: string; authoredSha256?: string
    }
    if (foundation.stage !== 'committed' || foundation.commitSha !== pin ||
        foundation.authoredSha256 !== approval.authoredSha256) return false
    const message = execFileSync('git', ['log', '-1', '--format=%B', pin], {
      cwd: job.worktreeRoot, encoding: 'utf8', timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'], env: cleanGitEnv(),
    })
    if (!message.split(/\r?\n/).includes('NovelTea-Job: ' + job.jobId) ||
        !message.split(/\r?\n/).includes('NovelTea-Work-Item: foundation')) return false
    const parent = execFileSync('git', ['rev-parse', pin + '^'], {
      cwd: job.worktreeRoot, encoding: 'utf8', timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'], env: cleanGitEnv(),
    }).trim()
    if (parent !== sourcePin) return false
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', pin, head], {
      cwd: job.worktreeRoot, env: cleanGitEnv(),
      stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000,
    })
    return true
  } catch { return false }
}
function cleanGitEnv() {
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX'])
    delete env[key]
  return env
}

type JobRow = TrustedControllerJobRow
type Manifest = {
  version: number; jobId: string; gitRoot: string; gitCommonDir: string;
  storyRoot: string; storyRelativePath: string; baseSha: string; branch: string;
  stateDir: string; cacheRoot: string; worktreeRoot: string; worktreeStoryRoot: string;
  threadId?: string; validatorVersion?: string;
}

/**
 * Only the read-only trusted catalog + the independently checked job manifest
 * can authorize a mount. A UUID by itself does not authorize any host path.
 */
export async function resolveTrustedJob(config: ControllerConfig, jobId: string, imageId: string): Promise<TrustedJob> {
  if (!UUID.test(jobId)) throw new SandboxError(400, 'Invalid job identity.')
  const dbPath = join(config.appVolume, 'studio.sqlite')
  let row: JobRow | null
  try { row = await readTrustedControllerJob(config.catalog ?? { backend: 'sqlite', path: dbPath }, jobId) }
  catch { throw new SandboxError(503, 'Studio catalog is unavailable or its schema is incomplete.') }
  if (!row) throw new SandboxError(404, 'Registered job was not found.')
  if (!SHA.test(row.pin) || !canonicalStoryPath(row.directory)) {
    throw new SandboxError(409, 'Registered job source identity is invalid.')
  }
  // A legacy registered Story may be a non-hidden workspace subtree. Do not
  // broaden its old per-record mounts to the whole subtree after deployment.
  if (row.directory !== 'story' && !row.directory.endsWith('/story')) {
    throw new SandboxError(409, 'Hosted Story must use a dedicated story/ content directory; migrate the legacy layout.')
  }

  const scoped = join(hash(row.ownerId), hash(row.provider + ':' + row.providerId))
  const gitRoot = join(config.containerCache, scoped, 'base')
  const stateHash = hash(JSON.stringify([gitRoot, row.directory, jobId]))
  const repoRoot = join(config.containerCache, scoped)
  const jobState = join(config.containerState, 'jobs', stateHash)
  const worktree = join(repoRoot, 'worktrees', stateHash)
  const manifestPath = join(config.stateVolume, 'jobs', stateHash, 'job.json')
  let saved: Manifest
  try { saved = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest }
  catch { throw new SandboxError(409, 'Registered job manifest is missing or corrupt.') }
  if (!saved || typeof saved.baseSha !== 'string' || saved.version !== 1 || saved.jobId !== jobId ||
      saved.gitRoot !== gitRoot || saved.gitCommonDir !== join(gitRoot, '.git') ||
      saved.storyRoot !== join(gitRoot, row.directory) ||
      saved.storyRelativePath !== row.directory ||
      saved.baseSha.toLowerCase() !== row.pin.toLowerCase() ||
      saved.branch !== 'noveltea-gen/' + stateHash ||
      saved.stateDir !== jobState || saved.cacheRoot !== repoRoot ||
      saved.worktreeRoot !== worktree ||
      saved.worktreeStoryRoot !== join(worktree, row.directory)) {
    throw new SandboxError(409, 'Registered job manifest does not match its trusted identity.')
  }
  const hostRoot = join(config.cacheVolume, scoped, 'worktrees', stateHash)
  const hostStory = join(hostRoot, row.directory)
  try {
    checkAncestry(config.cacheVolume, hostStory)
    // Cross-check both sides of Git's linked-worktree registry. A prefix
    // comparison is insufficient: an attacker could redirect to a different
    // worktree/branch while preserving the apparent repository path.
    const dotgit = join(hostRoot, '.git')
    if (!lstatSync(dotgit).isFile() || lstatSync(dotgit).isSymbolicLink()) {
      throw new Error('Git pointer is not a regular file')
    }
    const prefix = gitRoot + '/.git/worktrees/'
    const pointer = readFileSync(dotgit, 'utf8').trim()
    if (!pointer.startsWith('gitdir: ' + prefix)) throw new Error('Git pointer has another repository')
    const suffix = pointer.slice(('gitdir: ' + prefix).length)
    if (!/^[A-Za-z0-9._-]+$/.test(suffix) || suffix === '.' || suffix === '..') {
      throw new Error('Git worktree pointer has an invalid name')
    }
    const registry = join(config.cacheVolume, scoped, 'base', '.git', 'worktrees', suffix)
    checkAncestry(config.cacheVolume, registry)
    if (readFileSync(join(registry, 'gitdir'), 'utf8').trim() !== join(worktree, '.git')) {
      throw new Error('Git registry references a different worktree')
    }
    if (readFileSync(join(registry, 'HEAD'), 'utf8').trim() !== 'ref: refs/heads/' + saved.branch) {
      throw new Error('Git registry references a different branch')
    }
  } catch (error) {
    if (error instanceof SandboxError) throw error
    throw new SandboxError(409, 'Saved job worktree is missing or has an unsafe filesystem identity.')
  }
  const hostState = join(config.stateVolume, 'jobs', stateHash)
  const revisionEvidence = existsSync(join(hostState, 'foundation.json')) ||
    existsSync(join(hostState, 'revisions', 'verified-head.json'))
  const resources = await trustedResources(row, config, revisionEvidence, async (pin) => {
    if (!saved.threadId || !saved.validatorVersion)
      throw new SandboxError(409, 'Trusted job manifest has incomplete revision identity.')
    // Read-only reconstruction from the checked manifest, owner catalog, linked
    // Git registry, and host paths. Revision receipts must match actual Git HEAD.
    const identity: JobStartResult = {
      jobId, gitRoot: join(config.cacheVolume, scoped, 'base'),
      storyRoot: join(config.cacheVolume, scoped, 'base', row.directory),
      storyRelativePath: row.directory, baseSha: saved.baseSha, branch: saved.branch,
      stateDir: hostState, cacheRoot: join(config.cacheVolume, scoped),
      worktreeRoot: hostRoot, worktreeStoryRoot: hostStory,
      threadId: saved.threadId, validatorVersion: saved.validatorVersion,
      status: 'ready', headSha: '',
    }
    return verifyPinnedGenerationRevision(identity, pin, row.pin)
  })
  return { id: jobId, storyRoot: hostStory,
    volumeSubpath: hostStory.slice(config.cacheVolume.length + 1).split(sep).join('/'),
    identity: stateHash, imageId, resources, resourceHash: hash(JSON.stringify(resources)) }
}

function dockerRequired(run: CommandRunner, args: string[]): string {
  const result = run(args)
  if (result.status !== 0) throw new SandboxError(503, 'Rootless Docker operation failed; inspect host controller logs.')
  return result.stdout.trim()
}

function volumePath(run: CommandRunner, name: string, hostVisible = true): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new Error('Invalid configured Docker volume name.')
  const content = dockerRequired(run, ['volume', 'inspect', name, '--format', '{{.Mountpoint}}'])
  if (!isAbsolute(content)) throw new Error('Docker volume has no absolute host mountpoint.')
  // Docker reports daemon-host mountpoints, which are not visible inside
  // the dedicated controller sidecar. Only the host controller may lstat
  // those paths; the sidecar checks its own volume mounts independently.
  if (hostVisible) {
    requirePlainDirectory(content)
    return realpathSync(content)
  }
  return content
}

export function loadControllerConfig(env: NodeJS.ProcessEnv = process.env, run: CommandRunner = shellFreeDocker): ControllerConfig {
  const info = dockerRequired(run, ['info', '--format', '{{json .SecurityOptions}}'])
  let flags: string[]
  try { flags = JSON.parse(info) as string[] } catch { throw new Error('Unable to check Docker rootless status.') }
  if (!Array.isArray(flags) || !flags.some(v => /(^|=)rootless$/.test(v))) {
    throw new Error('Refusing to start: sandbox controller requires a host-managed ROOTLESS Docker daemon.')
  }
  const cgroups = dockerRequired(run, ['info', '--format', '{{.CgroupVersion}}/{{.CgroupDriver}}'])
  if (cgroups !== '2/systemd') {
    throw new Error('Refusing to start: rootless Docker needs cgroup v2 and systemd to enforce resource budgets.')
  }
  const socket = env.NT_SANDBOX_SOCKET
  const tokenFile = env.NT_SANDBOX_TOKEN_FILE
  if (!socket || !isAbsolute(socket) || !tokenFile || !isAbsolute(tokenFile))
    throw new Error('NT_SANDBOX_SOCKET and NT_SANDBOX_TOKEN_FILE must be absolute host paths.')
  const tokenInfo = lstatSync(tokenFile)
  if (!tokenInfo.isFile() || tokenInfo.isSymbolicLink() || (tokenInfo.mode & 0o077) !== 0) {
    throw new Error('Controller token must be a regular host file accessible only to its owner (0600).')
  }
  const token = readFileSync(tokenFile, 'utf8').trim()
  if (token.length < 48) throw new Error('Sandbox controller token must be at least 48 characters.')
  const inCompose = env.NT_CONTROLLER_IN_COMPOSE === '1'
  // The controller sidecar reads identical named volumes through its own
  // read-only mounts, while the rootless daemon needs HOST mountpoints for
  // sandbox creation. Never accept a host mountpoint from an HTTP request.
  const hostApp = volumePath(run, env.NT_SANDBOX_APP_VOLUME || 'noveltea-app', !inCompose)
  const hostState = volumePath(run, env.NT_SANDBOX_STATE_VOLUME || 'noveltea-state', !inCompose)
  const hostCache = volumePath(run, env.NT_SANDBOX_CACHE_VOLUME || 'noveltea-cache', !inCompose)
  if (inCompose) {
    for (const mount of ['/var/lib/noveltea/app', '/var/lib/noveltea/state', '/var/lib/noveltea/cache'])
      requirePlainDirectory(mount)
  }
  const maximum = (key: string, fallback: number, lower: number, upper: number, integer: boolean) => {
    const raw = env[key]
    if (raw === undefined || raw === '') return fallback
    const value = Number(raw)
    if (!Number.isFinite(value) || value < lower || value > upper ||
        (integer && !Number.isSafeInteger(value)))
      throw new Error('Invalid operator sandbox maximum: ' + key)
    return value
  }
  const backend = env.NT_STUDIO_DB_BACKEND ?? 'sqlite'
  if (backend !== 'sqlite' && backend !== 'postgres')
    throw new Error('Unsupported NT_STUDIO_DB_BACKEND for sandbox controller')
  let catalog: TrustedCatalogOptions | undefined
  if (backend === 'postgres') {
    const port = Number(env.PGPORT ?? '5432')
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
      throw new Error('Invalid PostgreSQL trusted catalog port')
    catalog = { backend: 'postgres', connection: {
      host: env.PGHOST ?? '', port, database: env.PGDATABASE ?? '',
      user: env.PGUSER ?? '', password: env.PGPASSWORD ?? '',
    } }
    if (catalog.connection.user !== 'noveltea_controller' || !catalog.connection.host ||
        !catalog.connection.database || !catalog.connection.password)
      throw new Error('Controller requires the restricted PostgreSQL catalog role and credentials')
  }
  return {
    socket, token,
    ...(catalog ? { catalog } : {}),
    appVolume: inCompose ? '/var/lib/noveltea/app' : hostApp,
    stateVolume: inCompose ? '/var/lib/noveltea/state' : hostState,
    cacheVolume: inCompose ? '/var/lib/noveltea/cache' : hostCache,
    ...(inCompose ? { sandboxCacheVolume: env.NT_SANDBOX_CACHE_VOLUME || 'noveltea-cache' } : {}),
    image: env.NT_SANDBOX_IMAGE || 'noveltea-sandbox:local',
    containerState: '/var/lib/noveltea/state',
    containerCache: '/var/lib/noveltea/cache',
    maximums: {
      cpu: maximum('NT_SANDBOX_MAX_CPUS', defaultMaximums.cpu, 0.1, 64, false),
      memoryMiB: maximum('NT_SANDBOX_MAX_MEMORY_MIB', defaultMaximums.memoryMiB, 64, 65_536, true),
      pids: maximum('NT_SANDBOX_MAX_PIDS', defaultMaximums.pids, 16, 4096, true),
    },
  }
}

function containerName(id: string) { return 'noveltea-job-' + id.toLowerCase() }
function labels(run: CommandRunner, name: string): Record<string, string> | null {
  const inspected = run(['container', 'inspect', name, '--format', '{{json .Config.Labels}}'])
  if (inspected.status !== 0) return null
  try { return JSON.parse(inspected.stdout) as Record<string, string> }
  catch { throw new SandboxError(409, 'Existing sandbox cannot be inspected safely.') }
}

/** Small transport, no Docker commands are constructed using untrusted flags. */
export class SandboxController {
  private readonly locked = new Set<string>()
  constructor(
    readonly config: ControllerConfig,
    readonly run: CommandRunner = shellFreeDocker,
    private readonly spawnExec: typeof spawn = spawn,
  ) {}

  private imageId(): string {
    const id = dockerRequired(this.run, ['image', 'inspect', this.config.image, '--format', '{{.Id}}'])
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new SandboxError(503, 'Sandbox image is not locally available and pinned.')
    return id
  }

  private async trusted(id: string, requireCurrentImage = true) {
    // Disposal must work even when an image tag has moved or been deleted.
    // Worktree, catalog, and registered Git identity remain mandatory.
    return resolveTrustedJob(this.config, id, requireCurrentImage ? this.imageId() : '')
  }

  private verifyRunning(job: TrustedJob, requireCurrentImage = true, requireCurrentLayout = true): boolean {
    const existing = labels(this.run, containerName(job.id))
    if (!existing) return false
    if (existing['dev.noveltea.job'] !== job.id.toLowerCase() ||
        existing['dev.noveltea.identity'] !== job.identity ||
        (requireCurrentLayout && existing['dev.noveltea.layout'] !== 'story-content-v2') ||
        !/^sha256:[a-f0-9]{64}$/.test(existing['dev.noveltea.image'] ?? '') ||
        (requireCurrentImage && existing['dev.noveltea.image'] !== job.imageId) ||
        (requireCurrentImage && existing['dev.noveltea.resources'] !== job.resourceHash)) {
      throw new SandboxError(409, 'Sandbox container name is occupied by another identity; inspect it manually.')
    }
    return true
  }

  async acquire(id: string) {
    if (this.locked.has(id)) throw new SandboxError(409, 'Sandbox acquisition is already in progress.')
    // Lock before the asynchronous authorization query. Otherwise concurrent
    // acquire/execute/dispose could race while the catalog is being read.
    this.locked.add(id)
    try {
      const job = await this.trusted(id)
      const exists = this.verifyRunning(job)
      // The selected canonical Story content directory is the sole bind mount.
      // Author-only inbox and Git metadata must live outside this directory.
      // Validate the complete tree before every acquisition, including restarts.
      checkAncestry(this.config.cacheVolume, job.storyRoot)
      checkRecordTree(job.storyRoot)
      const mounts = ['--mount', this.config.sandboxCacheVolume
        ? `type=volume,source=${this.config.sandboxCacheVolume},target=/story,volume-subpath=${job.volumeSubpath}`
        : `type=bind,source=${job.storyRoot},target=/story,bind-propagation=rprivate`]
      if (!exists) {
        dockerRequired(this.run, [
          'create', '--name', containerName(id),
          '--label', 'dev.noveltea.job=' + id.toLowerCase(),
          '--label', 'dev.noveltea.identity=' + job.identity,
          '--label', 'dev.noveltea.layout=story-content-v2',
          '--label', 'dev.noveltea.image=' + job.imageId,
          '--label', 'dev.noveltea.resources=' + job.resourceHash,
          '--network', 'none', '--read-only', '--cap-drop', 'ALL',
          '--security-opt', 'no-new-privileges', '--pids-limit', String(job.resources.pids),
          '--memory', job.resources.memoryMiB + 'm', '--memory-swap', job.resources.memoryMiB + 'm',
          '--cpus', String(job.resources.cpu),
          '--user', '0:0', // root IN rootless userns, mapped to unprivileged host UID
          '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=32m',
          '--log-driver', 'none', ...mounts,
          job.imageId, 'sleep', 'infinity',
        ])
      }
      const running = dockerRequired(this.run, ['inspect', containerName(id), '--format', '{{.State.Running}}'])
      if (running !== 'true') dockerRequired(this.run, ['start', containerName(id)])
      return { jobId: id, status: 'running' as const }
    } finally { this.locked.delete(id) }
  }

  async inspect(id: string) {
    const job = await this.trusted(id)
    if (!this.verifyRunning(job)) throw new SandboxError(404, 'Job sandbox has not been acquired.')
    const running = dockerRequired(this.run, ['inspect', containerName(id), '--format', '{{.State.Running}}'])
    return { jobId: id, status: running === 'true' ? 'running' : 'stopped' }
  }

  async dispose(id: string) {
    if (this.locked.has(id)) throw new SandboxError(409, 'Job sandbox is executing or being acquired.')
    this.locked.add(id)
    try {
      const job = await this.trusted(id, false)
      // A retired per-directory sandbox can be removed but never reused.
      if (!this.verifyRunning(job, false, false)) return { jobId: id, status: 'absent' }
      dockerRequired(this.run, ['rm', '-f', containerName(id)])
      return { jobId: id, status: 'disposed' }
    } finally { this.locked.delete(id) }
  }

  /**
   * Execute in the registered container, but never treat docker exec's exit as
   * a writer boundary. Descendants can outlive their foreground parent. Stop
   * the entire container (SIGKILL after zero grace) and start its clean init
   * process before returning ANY exit status to the trusted worker.
   */
  async execute(id: string, argv: string[], onData: (stream: 'stdout' | 'stderr', data: string) => void, stdin?: Buffer) {
    if (this.locked.has(id)) throw new SandboxError(409, 'Job sandbox already has an active operation.')
    this.locked.add(id)
    try {
      const job = await this.trusted(id)
      if (!this.verifyRunning(job)) throw new SandboxError(404, 'Job sandbox has not been acquired.')
      if (!Array.isArray(argv) || argv.length === 0 || argv.length > 64 ||
          argv.some(a => typeof a !== 'string' || a.length > 4096 || a.includes('\0'))) {
        throw new SandboxError(400, 'Invalid sandbox command arguments.')
      }
      if (Buffer.byteLength(JSON.stringify({ argv })) > SANDBOX_COMMAND_BYTES ||
          (stdin && stdin.byteLength > SANDBOX_RECORD_BYTES))
        throw new SandboxError(413, 'Sandbox command input exceeds its bounded limit.')
      // Spawn with argv, never through a host shell. All child processes are
      // confined to the container's PID namespace and rootless cgroup.
      return await new Promise<number>((resolvePromise, reject) => {
        const name = containerName(id)
        const child = this.spawnExec('docker', ['exec', ...(stdin ? ['-i'] : []), '--workdir', '/story', name, ...argv], {
          stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        })
        const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
        let bytes = 0
        let finished = false
        const finish = () => { finished = true; clearTimeout(timer) }
        const abortContainer = (reason: SandboxError) => {
          if (finished) return
          finish()
          child.kill('SIGKILL')
          // The Docker client dying alone is insufficient: an exec process
          // can survive inside the still-running container.
          const removed = this.run(['rm', '-f', name])
          reject(removed.status === 0 ? reason :
            new SandboxError(503, 'Sandbox could not be stopped safely; operator intervention required.'))
        }
        const timer = setTimeout(() => {
          abortContainer(new SandboxError(504, 'Sandbox command exceeded the execution timeout. Inspect job before retrying.'))
        }, 30_000)
        const chunk = (stream: 'stdout' | 'stderr', buf: Buffer) => {
          if (finished) return
          bytes += buf.byteLength
          if (bytes > LIMIT_OUTPUT) {
            abortContainer(new SandboxError(413, 'Sandbox command exceeded the output limit.'))
            return
          }
          try {
            const text = decoders[stream].write(buf)
            if (text) onData(stream, text)
          } catch {
            abortContainer(new SandboxError(500, 'Sandbox output delivery failed.'))
          }
        }
        child.stdout.on('data', (b: Buffer) => chunk('stdout', b))
        child.stderr.on('data', (b: Buffer) => chunk('stderr', b))
        child.on('error', () => abortContainer(new SandboxError(503, 'Sandbox Docker execution failed.')))
        if (stdin) {
          if (!child.stdin) {
            abortContainer(new SandboxError(503, 'Sandbox stdin was not available.'))
            return
          }
          child.stdin.on('error', () => abortContainer(new SandboxError(503, 'Sandbox input delivery failed.')))
          child.stdin.end(stdin)
        }
        child.on('close', code => {
          if (finished) return
          try {
            for (const stream of ['stdout', 'stderr'] as const) {
              const rest = decoders[stream].end()
              if (rest) onData(stream, rest)
            }
          } catch {
            abortContainer(new SandboxError(500, 'Sandbox output delivery failed.'))
            return
          }
          // A foreground exit cannot establish quiescence. Stopping the
          // entire PID namespace kills detached children, even setsid
          // descendants; only a successful stop is a safe writer boundary.
          if (this.run(['stop', '--time', '0', name]).status !== 0) {
            abortContainer(new SandboxError(503, 'Sandbox did not reach a stopped writer boundary.'))
            return
          }
          if (this.run(['start', name]).status !== 0) {
            abortContainer(new SandboxError(503, 'Sandbox could not restart after its writer boundary.'))
            return
          }
          finish()
          resolvePromise(code ?? 1)
        })
      })
    } finally {
      this.locked.delete(id)
    }
  }
}

function send(res: ServerResponse, status: number, data: object) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

async function body(req: IncomingMessage, maxBytes = LIMIT_BODY): Promise<unknown> {
  let count = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buf = Buffer.from(chunk as Buffer)
    if ((count += buf.length) > maxBytes) throw new SandboxError(413, 'Request too large.')
    chunks.push(buf)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new SandboxError(400, 'Invalid JSON request.') }
}

export function createControllerServer(controller: SandboxController) {
  const token = Buffer.from(controller.config.token)
  return createServer(async (req, res) => {
    const candidate = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
    const supplied = Buffer.from(candidate)
    if (supplied.length !== token.length || !timingSafeEqual(token, supplied)) {
      return send(res, 401, { error: 'Unauthorized' })
    }
    try {
      const url = new URL(req.url || '', 'http://controller.local')
      // Authenticated liveness is independent of any saved author job.
      if (req.method === 'GET' && url.pathname === '/health')
        return send(res, 200, { status: 'ok' })
      if (req.method === 'POST' && url.pathname === '/v1/sandboxes') {
        const payload = await body(req) as { jobId?: unknown } | null
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
            Object.keys(payload).some(key => key !== 'jobId') || typeof payload.jobId !== 'string')
          throw new SandboxError(400, 'Only a registered job UUID is accepted.')
        return send(res, 201, await controller.acquire(payload.jobId))
      }
      const match = /^\/v1\/sandboxes\/([a-f0-9-]+)(?:\/(exec))?$/i.exec(url.pathname)
      if (!match || !UUID.test(match[1]!)) return send(res, 404, { error: 'Not found' })
      const id = match[1]!
      if (req.method === 'GET' && !match[2]) return send(res, 200, await controller.inspect(id))
      if (req.method === 'DELETE' && !match[2]) return send(res, 200, await controller.dispose(id))
      if (req.method === 'POST' && match[2] === 'exec') {
        const payload = await body(req, SANDBOX_FILE_REQUEST_BYTES) as { argv?: unknown; stdinBase64?: unknown } | null
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
            Object.keys(payload).some(key => key !== 'argv' && key !== 'stdinBase64') || !Array.isArray(payload.argv))
          throw new SandboxError(400, 'Only sandbox command argv is accepted.')
        // Validate before writing any streaming headers.
        if (!payload.argv.length || payload.argv.length > 64 ||
            payload.argv.some(v => typeof v !== 'string' || v.length > 4096 || v.includes('\0'))) {
          throw new SandboxError(400, 'Invalid sandbox command argv.')
        }
        if (Buffer.byteLength(JSON.stringify({ argv: payload.argv })) > SANDBOX_COMMAND_BYTES)
          throw new SandboxError(413, 'Command arguments too large.')
        let stdin: Buffer | undefined
        if (payload.stdinBase64 !== undefined) {
          const encoded = payload.stdinBase64
          if (typeof encoded !== 'string' || encoded.length > Math.ceil(SANDBOX_RECORD_BYTES / 3) * 4)
            throw new SandboxError(413, 'File input exceeds the record limit.')
          stdin = Buffer.from(encoded, 'base64')
          if (stdin.toString('base64') !== encoded)
            throw new SandboxError(400, 'Invalid canonical base64 input.')
          if (stdin.byteLength > SANDBOX_RECORD_BYTES)
            throw new SandboxError(413, 'File input exceeds the record limit.')
        }
        if ((await controller.inspect(id)).status !== 'running') throw new SandboxError(404, 'Sandbox is not running.')
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' })
        try {
          const code = await controller.execute(id, payload.argv as string[], (stream, data) =>
            res.write(JSON.stringify({ stream, data }) + '\n'), stdin)
          res.end(JSON.stringify({ exitCode: code }) + '\n')
        } catch (error) {
          res.end(JSON.stringify({ status: error instanceof SandboxError ? error.status : 503, error: error instanceof SandboxError ? error.message : 'Sandbox execution failed.' }) + '\n')
        }
        return
      }
      return send(res, 405, { error: 'Method not allowed' })
    } catch (error) {
      const status = error instanceof SandboxError ? error.status : 500
      return send(res, status, { error: error instanceof SandboxError ? error.message : 'Sandbox controller operation failed.' })
    }
  })
}

export async function serveController(config: ControllerConfig) {
  // Refuse stale/existing socket without guessing whether another controller
  // still owns it. Operators reconcile and explicitly remove stale sockets.
  if (existsSync(config.socket)) throw new Error('Controller socket already exists; inspect the previous process before removing it.')
  const dir = dirname(config.socket)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const permission = await stat(dir)
  if ((permission.mode & 0o022) !== 0) throw new Error('Controller socket parent directory must not be group/world writable.')
  const server = createControllerServer(new SandboxController(config))
  await new Promise<void>((yes, no) => {
    server.once('error', no)
    server.listen(config.socket, () => { server.off('error', no); yes() })
  })
  chmodSync(config.socket, 0o600)
  return server
}
