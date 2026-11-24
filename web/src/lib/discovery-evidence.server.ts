import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Discovery happens before a Story job exists. Store its immutable response
 * evidence in private controller state, not the Git worktree or public logs.
 * Exact prompts, model replies, Pi session files and validation errors can
 * contain private author material and must never appear in API projections. */
export async function createDiscoveryEvidence(options: {
  owner: string
  repositoryId: string
  workspace: string
  revision: number
  stage: 'initial' | 'corrective' | 'opening-questions' | 'semantic-review' | 'semantic-diagnostic'
  model: { provider: string; id: string }
  skillId: string
  instructions: string
}, env: NodeJS.ProcessEnv = process.env) {
  const state = resolve(env.NT_DISCOVERY_EVIDENCE_DIR ?? env.NT_STATE_DIR ??
    join(env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'noveltea-gen'))
  const key = createHash('sha256').update(options.owner + '\0' +
    options.repositoryId + '\0' + options.workspace).digest('hex')
  const parent = join(state, 'discovery-sessions', key)
  // The scope and attempt directories are private even if the state root is shared.
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const dir = join(parent, options.revision + '-' + options.stage + '-' + randomUUID())
  await mkdir(dir, { mode: 0o700 })
  const piDirectory = join(dir, 'pi')
  await mkdir(piDirectory, { mode: 0o700 })
  const write = async (name: string, payload: object) =>
    writeFile(join(dir, name), JSON.stringify(payload, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 })
  await write('request.json', {
    version: 1, stage: options.stage, revision: options.revision,
    model: options.model, skillId: options.skillId,
    instructions: options.instructions,
    startedAt: new Date().toISOString(),
  })
  return {
    dir,
    piDirectory,
    async response(raw: string, piSessionFile?: string, reference?: DiscoveryPiReference) {
      await write('response.json', {
        version: 1, raw, sha256: createHash('sha256').update(raw).digest('hex'),
        ...(piSessionFile ? { piSessionFile } : {}),
        ...(reference ? { reference } : {}),
        savedAt: new Date().toISOString(),
      })
    },
    async validation(status: 'accepted' | 'rejected', error?: unknown) {
      await write('validation.json', {
        version: 1, status,
        ...(error ? { name: error instanceof Error ? error.name : 'unknown',
          message: error instanceof Error ? error.message : String(error) } : {}),
        checkedAt: new Date().toISOString(),
      })
    },
    async inferenceError(error: unknown) {
      await write('inference-error.json', {
        version: 1,
        name: error instanceof Error ? error.name : 'unknown',
        message: error instanceof Error ? error.message : String(error),
        occurredAt: new Date().toISOString(),
      })
    },
  }
}

export type DiscoveryEvidence = Awaited<ReturnType<typeof createDiscoveryEvidence>>

/** Source-bound, private reference to the exact settled Pi conversation.
 * Discovery has no Generation Job or writable Story worktree. */
export type DiscoveryPiReference = Readonly<{
  sourceDigest: string
  role: 'writer' | 'reviewer' | 'diagnostic'
  id: string
  file: string
  bytes: number
  digest: string
}>

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

async function exactTranscript(file: string) {
  if (!isAbsolute(file) || !file.endsWith('.jsonl') || await realpath(file) !== file)
    throw Error('Discovery Pi transcript path changed.')
  const stat = await lstat(file)
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
    throw Error('Discovery Pi transcript is not a bounded regular file.')
  const bytes = await readFile(file)
  if (!bytes.length || bytes.at(-1) !== 10) throw Error('Incomplete Discovery Pi transcript.')
  const records = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  return { bytes, header: records[0] }
}

export async function sealDiscoveryPiReference(manager: SessionManager, sourceDigest: string,
  role: DiscoveryPiReference['role']): Promise<DiscoveryPiReference> {
  const file = manager.getSessionFile()
  if (!file || !/^[a-f0-9]{64}$/.test(sourceDigest))
    throw Error('Discovery invocation has no durable source-bound Pi session.')
  const { bytes, header } = await exactTranscript(file)
  if (header.type !== 'session' || header.id !== manager.getSessionId() || header.cwd !== '/')
    throw Error('Discovery Pi transcript header changed.')
  return { sourceDigest, role, id: header.id, file, bytes: bytes.length, digest: hash(bytes) }
}

/** Pi's ordinary open() can allocate a new session for a missing input.
 * Require exact source, role and settled transcript bytes BEFORE opening. */
export async function reopenDiscoveryPiReference(ref: DiscoveryPiReference,
  sourceDigest: string, role: DiscoveryPiReference['role']): Promise<SessionManager> {
  if (ref.sourceDigest !== sourceDigest || ref.role !== role)
    throw Error('Discovery Pi reference belongs to another assignment or role.')
  const { bytes, header } = await exactTranscript(ref.file)
  if (header.type !== 'session' || header.id !== ref.id || header.cwd !== '/' ||
      bytes.length !== ref.bytes || hash(bytes) !== ref.digest)
    throw Error('Discovery Pi transcript changed after settlement.')
  const manager = SessionManager.open(ref.file, dirname(ref.file), '/')
  if (manager.getSessionId() !== ref.id || manager.getSessionFile() !== ref.file)
    throw Error('Discovery Pi session identity changed.')
  return manager
}
