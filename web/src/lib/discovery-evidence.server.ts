import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { inspectCompletedProtocolResponse } from '../../../src/response-contract-recovery'
import { accumulatePiUsage, emptyPiUsage } from '../../../src/job-pi-policy'

/** Discovery happens before a Story job exists. Store its immutable response
 * evidence in private controller state, not the Git worktree or public logs.
 * Exact prompts, model replies, Pi session files and validation errors can
 * contain private author material and must never appear in API projections. */
export async function createDiscoveryEvidence(options: {
  owner: string
  repositoryId: string
  workspace: string
  revision: number
  stage: 'initial' | 'corrective' | 'opening-questions' | 'semantic-review' | 'semantic-replacement' | 'semantic-diagnostic' | 'provenance-diagnostic'
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
  return discoveryEvidence(dir)
}

/** Open only a path admitted by the Studio operation claim. */
export function discoveryEvidence(dir: string) {
  const piDirectory = join(dir, 'pi')
  const write = async (name: string, payload: object) =>
    writeFile(join(dir, name), JSON.stringify(payload, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 })
  return {
    dir,
    piDirectory,
    async requestReceiptDigest() { return hash(await readFile(join(dir, 'request.json'))) },
    async response(raw: string, piSessionFile?: string, reference?: DiscoveryPiReference) {
      await write('response.json', {
        version: 1, raw, sha256: createHash('sha256').update(raw).digest('hex'),
        ...(piSessionFile ? { piSessionFile } : {}),
        ...(reference ? { reference } : {}),
        savedAt: new Date().toISOString(),
      })
      return hash(await readFile(join(dir, 'response.json')))
    },
    async validation(status: 'accepted' | 'rejected', error?: unknown) {
      const verdict = { version: 1, status,
        ...(error ? { name: error instanceof Error ? error.name : 'unknown',
          message: error instanceof Error ? error.message : String(error) } : {}) }
      try {
        await write('validation.json', { ...verdict, checkedAt: new Date().toISOString() })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const { checkedAt: _time, ...prior } = JSON.parse(await readFile(join(dir, 'validation.json'), 'utf8'))
        if (JSON.stringify(prior) !== JSON.stringify(verdict))
          throw Error('Discovery validation receipt changed on reconciliation.')
      }
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

export type DiscoveryAttempt = Readonly<{
  dir: string
  requestDigest: string
  status: 'started' | 'not-started'
  role: DiscoveryPiReference['role']
  responseDigest?: string
  sourceDigest?: string
  requestReceiptDigest?: string
  fixture?: boolean
  correctionPause?: { reference: DiscoveryPiReference; activeSeconds: number }
  activeSeconds?: number
}>

/** Verify an immutable response receipt and the original transcript prefix.
 * Earlier replies remain verifiable after the same conversation appends
 * corrective turns. No model prompt is permitted on a missing receipt. */
export async function readDiscoveryResponse(attempt: DiscoveryAttempt, sourceDigest: string,
  role?: DiscoveryPiReference['role'], requirePi = false) {
  if (attempt.status !== 'started') throw Error('Discovery attempt never started.')
  const file = join(attempt.dir, 'response.json')
  const contract = attempt.role === 'writer' ? 'discovery.writer-response.v1' : 'discovery.review-response.v1'
  const protocol = join(attempt.dir, 'protocol')
  // The protocol verifier can settle before the Discovery wrapper writes its
  // response receipt. Adopt only that exact accepted invocation, never a new
  // prompt or an unsealed/uncertain format attempt.
  if (!attempt.responseDigest && requirePi && !await lstat(file).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })) {
    const accepted = JSON.parse(await readFile(protocol + '.initial.json', 'utf8'))
    if (accepted.status !== 'accepted') throw Error('Original Discovery protocol is not settled.')
    const raw = await inspectCompletedProtocolResponse({
      receiptFile: protocol, sourceDigest: attempt.requestDigest, contract,
      sessionRoots: [dirname(attempt.dir)], validate: () => [], parse: text => text,
    })
    const manager = SessionManager.open(accepted.sessionFile, dirname(accepted.sessionFile), '/')
    const reference = await sealDiscoveryPiReference(manager, sourceDigest, attempt.role)
    if (reference.id !== accepted.sessionId || reference.file !== accepted.sessionFile)
      throw Error('Recovered Discovery protocol session changed.')
    await discoveryEvidence(attempt.dir).response(raw, reference.file, reference)
  }
  if (await realpath(file) !== file || !(await lstat(file)).isFile())
    throw Error('Unsafe original Discovery receipt.')
  const contents = await readFile(file)
  if (attempt.responseDigest && hash(contents) !== attempt.responseDigest)
    throw Error('Discovery response differs from the Studio settlement.')
  const receipt = JSON.parse(contents.toString('utf8'))
  if (receipt.version !== 1 || typeof receipt.raw !== 'string' ||
      receipt.sha256 !== hash(Buffer.from(receipt.raw)))
    throw Error('Discovery response receipt changed.')
  const ref = receipt.reference as DiscoveryPiReference | undefined
  if (requirePi && !ref) throw Error('Discovery response has no original Pi transcript.')
  if (ref) {
    if (ref.sourceDigest !== sourceDigest || ref.role !== attempt.role || role && ref.role !== role ||
        receipt.piSessionFile !== ref.file)
      throw Error('Discovery response belongs to another source or role.')
    const { bytes, header } = await exactTranscript(ref.file)
    if (header.type !== 'session' || header.id !== ref.id || header.cwd !== '/' ||
        !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 || bytes.length < ref.bytes ||
        hash(bytes.subarray(0, ref.bytes)) !== ref.digest)
      throw Error('Discovery response transcript prefix changed.')
    const original = await inspectCompletedProtocolResponse({
      receiptFile: protocol, sourceDigest: attempt.requestDigest, contract,
      sessionRoots: [dirname(attempt.dir)],
      sealedPrefix: { transcriptBytes: ref.bytes, transcriptSha256: ref.digest },
      validate: () => [], parse: text => text,
    })
    if (original !== receipt.raw)
      throw Error('Discovery response differs from its original Pi output.')
  }
  return { text: receipt.raw as string, reference: ref, piSessionFile: ref?.file, responseDigest: hash(contents), savedAt: receipt.savedAt as string }
}

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
/** Meter the same authenticated Pi transcript prefixes used by recovery.
 * Several attempts may append to one original session; stable Pi message IDs
 * deduplicate cumulative transcript prefixes across the entire first Turn. */
export async function meterDiscoveryAttempts(attempts: readonly DiscoveryAttempt[],
  current?: { reference: DiscoveryPiReference; startedAt: number }) {
  const summary = emptyPiUsage()
  const seen = new Set<string>()
  const directories = new Set<string>()
  for (const attempt of attempts) {
    if (directories.has(attempt.dir)) throw Error('Duplicate Discovery attempt identity.')
    directories.add(attempt.dir)
    if (attempt.status === 'not-started') continue
    if (!attempt.responseDigest || !attempt.sourceDigest)
      throw Error('Discovery usage has an unsettled original attempt.')
    const response = await readDiscoveryResponse(attempt, attempt.sourceDigest, attempt.role, !attempt.fixture)
    const requestBytes = await readFile(join(attempt.dir, 'request.json'))
    if (hash(requestBytes) !== attempt.requestReceiptDigest)
      throw Error('Discovery request metering evidence changed.')
    const request = JSON.parse(requestBytes.toString('utf8'))
    const started = Date.parse(request.startedAt)
    let finished = Date.parse(response.savedAt)
    summary.steps++
    if (response.reference) {
      const { bytes } = await exactTranscript(response.reference.file)
      const prefix = bytes.subarray(0, response.reference.bytes).toString('utf8')
      // Pi's original append timestamp predates any delayed HTTP reconciliation.
      const entries = prefix.trimEnd().split('\n').map(line => JSON.parse(line))
      const completion = entries.filter(entry => entry.type === 'message' &&
        entry.message?.role === 'assistant').at(-1)
      finished = Date.parse(completion?.timestamp)
      accumulatePiUsage(prefix, response.reference.file, seen, summary)
    } else {
      // Controlled deterministic transport has no provider usage receipt.
      // Do not claim it was a priced or token-metered call.
      summary.modelCalls++
      summary.unpricedCalls++
      summary.unknownTokenCalls++
    }
    const elapsed = attempt.activeSeconds ?? (finished - started) / 1000
    if (!Number.isFinite(elapsed) || elapsed < 0)
      throw Error('Discovery usage timestamps are invalid.')
    summary.activeSeconds += elapsed
  }
  if (current) {
    const { bytes } = await exactTranscript(current.reference.file)
    if (bytes.length !== current.reference.bytes || hash(bytes) !== current.reference.digest)
      throw Error('Current Discovery correction transcript changed.')
    accumulatePiUsage(bytes.toString('utf8'), current.reference.file, seen, summary)
    summary.activeSeconds += Math.max(0, (Date.now() - current.startedAt) / 1000)
  }
  return summary
}

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
