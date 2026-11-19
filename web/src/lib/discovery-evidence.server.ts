import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Discovery happens before a Story job exists. Store its immutable response
 * evidence in private controller state, not the Git worktree or public logs.
 * Exact prompts, model replies, Pi session files and validation errors can
 * contain private author material and must never appear in API projections. */
export async function createDiscoveryEvidence(options: {
  owner: string
  repositoryId: string
  workspace: string
  revision: number
  stage: 'initial' | 'corrective' | 'opening-questions' | 'semantic-review'
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
    async response(raw: string, piSessionFile?: string) {
      await write('response.json', {
        version: 1, raw, sha256: createHash('sha256').update(raw).digest('hex'),
        ...(piSessionFile ? { piSessionFile } : {}),
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
