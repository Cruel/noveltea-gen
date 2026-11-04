import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './access.server'
import { validatedExplorer, type ExplorerIndex } from './story-explorer.server'
import { parseGenerationContract } from '../../../src/generation'
import { readRecoveryFork } from '../../../src/recovery-fork-state'
import { authorizedStoryJob } from './fixture-jobs.server'
import { isFocusedScope, resolveFocusedScope } from '../../../src/focused-scope'
import type { CompletionContract } from '../../../src/architecture'
import { availableUserPiModels, assertUserPiSelection, validPiSelection, type PiSelection } from './pi-credentials.server'
import { readDefaultModel } from './settings.server'

type Limits = { steps?: number; modelCalls?: number; costUsd?: number }
export type GenerationDraft = {
  version: 1; headSha: string; task: string; contract: CompletionContract
  limits: Limits; model: PiSelection | null
}
class ConfigurationError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const allowedTypes = new Set(['arc', 'milestone', 'event', 'character', 'world-entity',
  'relationship', 'fact', 'revelation', 'choice-point', 'puzzle', 'authored-content'])
const reply = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } })

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every(key => allowed.includes(key))

/** Draft model profile is validated against the owner's currently connected Pi catalog at save time. */
export function validateGenerationDraft(value: unknown, index: ExplorerIndex,
  canonicalRecords: unknown): GenerationDraft {
  if (!object(value) || !keys(value, ['version', 'headSha', 'task', 'contract', 'limits', 'model']) ||
      value.version !== 1 || value.headSha !== index.headSha ||
      typeof value.task !== 'string' || !value.task.trim() || value.task.length > 4000 ||
      (value.model !== null && !validPiSelection(value.model)) || !object(value.limits) ||
      !keys(value.limits, ['steps', 'modelCalls', 'costUsd'])) {
    throw new ConfigurationError(422, 'Invalid or stale generation configuration. Refresh the pinned Story before saving.')
  }
  const limits: Limits = {}
  for (const key of ['steps', 'modelCalls', 'costUsd'] as const) {
    const n = value.limits[key]
    if (n === undefined) continue
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1_000_000 ||
        (key !== 'costUsd' && !Number.isSafeInteger(n))) {
      throw new ConfigurationError(422, 'Budget limits must be bounded, nonnegative numbers.')
    }
    limits[key] = n
  }
  // Check duplicates before the authoritative parser normalizes and deduplicates IDs.
  const originalScope = object(value.contract) && object(value.contract.scope) ? value.contract.scope : null
  for (const key of ['targets', 'branches', 'supportingTargets'] as const) {
    const list = originalScope?.[key]
    if (list !== undefined && (!Array.isArray(list) ||
        list.length !== new Set(list).size)) {
      throw new ConfigurationError(422, 'Duplicate or invalid scope selectors are not authorized.')
    }
  }
  let contract: CompletionContract
  try { contract = parseGenerationContract(value.contract) }
  catch (error) {
    throw new ConfigurationError(422, error instanceof Error ? error.message : 'Invalid generation contract.')
  }
  if (!object(value.contract) || !keys(value.contract, ['scope', 'constraints', 'envelope']) ||
      !object(value.contract.scope) ||
      !keys(value.contract.scope, ['kind', 'depth', 'preset', 'targets', 'branches', 'supportingTargets']) ||
      !object(value.contract.envelope) ||
      !keys(value.contract.envelope, ['presentation', 'hardLimits', 'preferences'])) {
    throw new ConfigurationError(422, 'Unknown contract fields are not authorized.')
  }
  const scope = contract.scope
  const catalog = new Map(index.records.filter(record =>
    record.status !== 'superseded' && allowedTypes.has(record.type)).map(record => [record.id, record]))
  if (scope.kind === 'partial') {
    const chosen = [...scope.targets, ...(scope.supportingTargets ?? [])]
    if (!scope.targets.length || chosen.length > 128 ||
        chosen.some(id => !catalog.has(id)) ||
        chosen.some(id => catalog.get(id)?.type !== id.split('.')[0])) {
      throw new ConfigurationError(422, 'Partial scope targets must be active canonical records in the pinned Story.')
    }
    // The authoritative focused-scope resolver checks supporting-target
    // relationships. Context inclusion does not become write authorization.
    if (isFocusedScope(contract) || (scope.supportingTargets?.length ?? 0) > 0) {
      try {
        resolveFocusedScope(canonicalRecords as Parameters<typeof resolveFocusedScope>[0], contract)
      } catch (error) {
        throw new ConfigurationError(422, error instanceof Error ? error.message : 'Invalid focused Story scope.')
      }
    }
  }
  if (scope.branches.length > 128 || scope.branches.some(branch =>
    branch.length > 100 || !/^[a-z][a-z0-9-]*$/.test(branch)) ||
      scope.targets.length !== new Set(scope.targets).size ||
      scope.branches.length !== new Set(scope.branches).size ||
      (scope.supportingTargets?.length ?? 0) !== new Set(scope.supportingTargets ?? []).size) {
    throw new ConfigurationError(422, 'Scope contains duplicate or invalid targets or branch names.')
  }
  if (JSON.stringify(contract).length > 32_768 ||
      contract.constraints.some(x => x.length > 1000) ||
      contract.envelope.presentation.length > 2000 ||
      [...contract.envelope.hardLimits, ...contract.envelope.preferences].some(x => x.length > 1000)) {
    throw new ConfigurationError(422, 'Generation contract exceeds the allowed size.')
  }
  return { version: 1, headSha: index.headSha, task: value.task.trim(), contract, limits,
    model: value.model as PiSelection | null }
}

async function boundedBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) throw new ConfigurationError(400, 'Missing configuration.')
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > 64 * 1024) throw new ConfigurationError(413, 'Configuration is too large.')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown }
  catch { throw new ConfigurationError(400, 'Configuration must be UTF-8 JSON.') }
}

export async function generationConfigurationRequest(auth: StudioAuth, store: StudioDatabase,
  request: Request, id: string, baseURL: string): Promise<Response> {
  if (!['GET', 'PUT'].includes(request.method)) return reply({ error: 'Method not allowed.' }, 405)
  if (request.method === 'PUT' && request.headers.get('origin') !== baseURL)
    return reply({ error: 'Cross-origin write refused.' }, 403)
  try {
    assertStudioSchemaCurrent(store)
    const user = await requireUser(auth, request.headers)
    if (!user) throw new ConfigurationError(401, 'Sign in required.')
    if (!uuid.test(id)) throw new ConfigurationError(400, 'Invalid job ID.')
    const row = store.sqlite.prepare(`SELECT status, generation_request_json AS requestJson,
      generation_config_json AS configJson FROM studio_sessions WHERE id=? AND owner_user_id=?`)
      .get(id, user.id) as { status: string; requestJson: string | null; configJson: string | null } | undefined
    if (!row) throw new ConfigurationError(404, 'Job is not connected to this account.')
    const { index, result } = await validatedExplorer(auth, store, request, id)
    const records = result.report?.records
    if (!Array.isArray(records)) throw new ConfigurationError(409, 'Pinned canonical Story catalog is unavailable.')
    if (request.method === 'GET') {
      // Execution advances Git HEAD, but the saved draft remains historically
      // pinned to the original revision. Validate against today's catalog only
      // while editable; after start return the immutable historical selection.
      const persisted = row.configJson ? JSON.parse(row.configJson) as GenerationDraft : null
      const saved = persisted && !row.requestJson
        ? validateGenerationDraft(persisted, index, records) : persisted
      if (saved && row.requestJson && (saved.version !== 1 ||
          (saved.model !== null && !validPiSelection(saved.model)) ||
          typeof saved.headSha !== 'string' || typeof saved.task !== 'string')) {
        throw new ConfigurationError(409, 'Pinned generation configuration is corrupt.')
      }
      const models = await availableUserPiModels(store, user.id)
      return reply({ index, saved, editable: row.status === 'paused' && !row.requestJson,
        defaultModel: readDefaultModel(store, user.id),
        models, modelAvailability: models.length ? 'Connected user models available.' :
          'Connect your Pi API key or ChatGPT account to select a model.' })
    }
    if (row.status !== 'paused' || row.requestJson)
      throw new ConfigurationError(409, 'Generation configuration cannot change after the job has started.')
    const draft = validateGenerationDraft(await boundedBody(request), index, records)
    const fork = readRecoveryFork(await authorizedStoryJob(store, user.id, id))
    if (fork && JSON.stringify(draft.contract) !== JSON.stringify(fork.contract)) {
      throw new ConfigurationError(409, 'Forks retain the selected approved completion contract. Change the task, model or budget, or authorize a separate plan revision after starting.')
    }
    if (draft.model) {
      try { await assertUserPiSelection(store, user.id, draft.model) }
      catch { throw new ConfigurationError(422, 'The selected user Pi model is unavailable. Reconnect the provider.') }
    }
    const updated = store.sqlite.prepare(`UPDATE studio_sessions
      SET generation_config_json=?, updated_at=? WHERE id=? AND owner_user_id=?
      AND status='paused' AND generation_request_json IS NULL`)
      .run(JSON.stringify(draft), new Date().toISOString(), id, user.id)
    if (updated.changes !== 1) throw new ConfigurationError(409, 'Job was started concurrently; configuration was not saved.')
    return reply({ saved: draft, modelAvailability: 'Generation draft pinned to current user model selection.' })
  } catch (error) {
    if (error instanceof ConfigurationError) return reply({ error: error.message }, error.status)
    if (error instanceof Error && 'status' in error && typeof error.status === 'number' &&
        error.status >= 400 && error.status < 500) return reply({ error: error.message }, error.status)
    console.error('[Studio generation configuration] Cannot verify pinned scope',
      error instanceof Error ? error.stack : String(error))
    return reply({ error: 'Generation settings cannot be verified against the pinned Story. Inspect its durable state.' }, 409)
  }
}
