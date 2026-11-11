import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { ModelRuntime, type CreateModelRuntimeOptions } from '@earendil-works/pi-coding-agent'
import type { StudioStore as StudioDatabase } from '../persistence/store'

type Credentials = NonNullable<CreateModelRuntimeOptions['credentials']>
type Credential = NonNullable<Awaited<ReturnType<Credentials['read']>>>
export type AvailablePiModel = { provider: string; id: string; reasoning: boolean }
export type PiSelection = { provider: string; id: string; thinking?: 'low' | 'medium' | 'high' }
const providerId = /^[a-z][a-z0-9-]{0,63}$/
/** Cache only the owner-bound in-memory Pi catalog/runtime, never an authorization
 * decision. Every availability check still re-reads credentials from the DB,
 * and mutation invalidates this entry before a later request can reuse it. */
type RuntimeEntry = { fingerprint: string; pending: Promise<ModelRuntime> }
const runtimeCache = new WeakMap<StudioDatabase, Map<string, RuntimeEntry>>()
const MAX_OWNER_RUNTIMES = 16
function invalidateRuntime(store: StudioDatabase, owner: string) {
  runtimeCache.get(store)?.delete(owner)
}

function encryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const encoded = env.NT_PI_CREDENTIAL_KEY
  const key = encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0)
  if (!encoded || key.length !== 32 || key.toString('base64') !== encoded) {
    throw new Error('NT_PI_CREDENTIAL_KEY must be an independent base64-encoded 32-byte key')
  }
  return key
}

function seal(owner: string, provider: string, value: Credential, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(owner + '\0' + provider))
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), body].map(x => x.toString('base64')).join('.')
}
function unseal(owner: string, provider: string, value: string, key: Buffer): Credential {
  const parts = value.split('.')
  if (parts.length !== 3) throw new Error('Invalid Pi credential ciphertext')
  const [iv, tag, body] = parts.map(x => Buffer.from(x!, 'base64'))
  if (iv!.length !== 12 || tag!.length !== 16) throw new Error('Invalid Pi credential ciphertext')
  const decipher = createDecipheriv('aes-256-gcm', key, iv!)
  decipher.setAAD(Buffer.from(owner + '\0' + provider))
  decipher.setAuthTag(tag!)
  const credential = JSON.parse(Buffer.concat([decipher.update(body!), decipher.final()]).toString('utf8')) as Credential
  if (credential.type === 'api_key' && typeof credential.key === 'string' && credential.key.length > 0) return credential
  if (credential.type === 'oauth' && typeof credential.access === 'string' &&
      typeof credential.refresh === 'string' && typeof credential.expires === 'number') return credential
  throw new Error('Invalid persisted Pi credential')
}

/** DB-backed Pi store: no Pi files, host env credential lookup, or cross-user paths.
 * Optimistic revision protects rotating OAuth refresh tokens from lost updates
 * across worker processes. A racing refresh fails closed rather than replaying
 * a possibly one-shot refresh grant. */
export function userPiCredentials(store: StudioDatabase, owner: string,
  env: NodeJS.ProcessEnv = process.env): Credentials {
  const key = encryptionKey(env)
  const readRow = (provider: string) => store.persistence.piCredentials.read(owner, provider)
  const read: Credentials['read'] = async provider => {
    if (!providerId.test(provider)) return undefined
    const row = await readRow(provider)
    return row ? unseal(owner, provider, row.ciphertext, key) : undefined
  }
  return {
    read,
    async list() {
      const rows = await store.persistence.piCredentials.list(owner)
      return rows.map(row => ({ providerId: row.provider, type: unseal(owner, row.provider, row.ciphertext, key).type }))
    },
    async modify(provider, fn, options) {
      options?.signal?.throwIfAborted()
      if (!providerId.test(provider)) throw new Error('Invalid Pi provider')
      const current = await readRow(provider)
      const next = await fn(current ? unseal(owner, provider, current.ciphertext, key) : undefined)
      options?.signal?.throwIfAborted()
      if (next === undefined) return current ? unseal(owner, provider, current.ciphertext, key) : undefined
      if (JSON.stringify(next).length > 16_384) throw new Error('Pi credential exceeds size limit')
      const encrypted = seal(owner, provider, next, key)
      const changed = await store.persistence.piCredentials.compareAndSwap(
        owner, provider, encrypted, current?.revision ?? null)
      if (!changed) throw new Error('Pi credentials changed concurrently; reconnect before retrying')
      invalidateRuntime(store, owner)
      return next
    },
    async delete(provider, options) {
      options?.signal?.throwIfAborted()
      if (!providerId.test(provider)) throw new Error('Invalid Pi provider')
      await store.persistence.piCredentials.delete(owner, provider)
      invalidateRuntime(store, owner)
    },
  }
}

/** Never read ~/.pi/auth.json, ~/.pi/models.json or their model caches. */
async function buildUserPiRuntime(store: StudioDatabase, owner: string,
  env: NodeJS.ProcessEnv) {
  const runtime = await ModelRuntime.create({
    credentials: userPiCredentials(store, owner, env),
    modelsPath: null,
    allowModelNetwork: false,
  })
  // Built-in Pi providers otherwise accept ambient host API keys (and, for
  // some providers, machine-local auth files). A per-user CredentialStore
  // alone is not sufficient isolation. Replace their auth resolvers with
  // variants that require an explicit user's stored API-key credential and
  // cannot read the host environment or filesystem.
  for (const provider of runtime.getProviders()) {
    const original = provider.auth.apiKey
    if (!original) continue
    runtime.registerNativeProvider({ ...provider, auth: { ...provider.auth,
      apiKey: {
        ...original,
        check: async ({ credential }) => credential?.type === 'api_key' && credential.key
          ? { type: 'api_key', source: 'user Pi credential' } : undefined,
        resolve: async ({ credential, signal }) => credential?.type === 'api_key' && credential.key
          ? original.resolve({ credential, signal,
            ctx: { env: async () => undefined, fileExists: async () => false } }) : undefined,
      },
    } })
  }
  await runtime.refresh({ allowNetwork: false })
  return runtime
}

/** Runtime initialization rebuilds and checks every built-in Pi provider and
 * is expensive. Share a bounded, per-owner instance while credentials remain
 * unchanged; a different StudioStore or explicit environment never inherits
 * another owner's runtime or model selections. */
export async function createUserPiRuntime(store: StudioDatabase, owner: string,
  env: NodeJS.ProcessEnv = process.env): Promise<ModelRuntime> {
  if (env !== process.env) return buildUserPiRuntime(store, owner, env)
  let entries = runtimeCache.get(store)
  if (!entries) {
    entries = new Map()
    runtimeCache.set(store, entries)
  }
  // The registry may have changed in another server process. Bound the cache
  // to the current encrypted vault contents and encryption-key identity,
  // not only in-process writes, so revocation/rotation cannot reuse stale SDK
  // auth or subscription state across workers.
  const vault = await store.persistence.piCredentials.list(owner)
  const fingerprint = createHash('sha256').update(JSON.stringify([
    env.NT_PI_CREDENTIAL_KEY ?? null,
    ...vault.map(row => [row.provider, row.ciphertext]).sort((a, b) =>
      String(a[0]).localeCompare(String(b[0]))),
  ])).digest('hex')
  const existing = entries.get(owner)
  if (existing?.fingerprint === fingerprint) {
    entries.delete(owner)
    entries.set(owner, existing)
    return existing.pending
  }
  const pending = buildUserPiRuntime(store, owner, env)
  const entry: RuntimeEntry = { fingerprint, pending }
  entries.set(owner, entry)
  if (entries.size > MAX_OWNER_RUNTIMES) {
    const oldest = entries.keys().next().value
    if (oldest !== undefined) entries.delete(oldest)
  }
  try { return await pending }
  catch (error) {
    if (entries.get(owner) === entry) entries.delete(owner)
    throw error
  }
}

export async function availableUserPiModels(store: StudioDatabase, owner: string,
  env: NodeJS.ProcessEnv = process.env): Promise<AvailablePiModel[]> {
  // Scope configuration remains inspectable before operator Pi key setup.
  if (!env.NT_PI_CREDENTIAL_KEY) return []
  const credentials = userPiCredentials(store, owner, env)
  const connected = await credentials.list()
  if (!connected.length) return []
  const runtime = await createUserPiRuntime(store, owner, env)
  const models: AvailablePiModel[] = []
  for (const item of connected) {
    if (!runtime.getProvider(item.providerId)) continue
    // Only explicitly stored user credentials qualify; runtime's ambient
    // provider capabilities must never become an available user model.
    try {
      // Credentials are owner-scoped and re-read for each availability check,
      // but a large provider catalog must not trigger one database read per
      // *model*. This is a single authorization snapshot of this provider.
      if (!(await credentials.read(item.providerId))) continue
      for (const model of await runtime.getAvailable(item.providerId)) {
        models.push({ provider: item.providerId, id: model.id, reasoning: !!model.reasoning })
      }
    } catch {
      // Expired/revoked OAuth, broken credential, unavailable provider:
      // do not silently substitute another model or host auth.
    }
  }
  return models.sort((a, b) => (a.provider + '/' + a.id).localeCompare(b.provider + '/' + b.id))
}

export function validPiSelection(value: unknown): value is PiSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).every(key => ['provider', 'id', 'thinking'].includes(key)) &&
    typeof v.provider === 'string' && providerId.test(v.provider) &&
    typeof v.id === 'string' && v.id.length > 0 && v.id.length <= 200 &&
    (v.thinking === undefined || ['low', 'medium', 'high'].includes(String(v.thinking)))
}
export async function assertUserPiSelection(store: StudioDatabase, owner: string,
  selected: PiSelection): Promise<void> {
  const models = await availableUserPiModels(store, owner)
  if (!models.some(model => model.provider === selected.provider && model.id === selected.id &&
      (!selected.thinking || model.reasoning))) {
    throw new Error('Selected Pi model or credentials are unavailable. Reconnect the provider before continuing.')
  }
}
