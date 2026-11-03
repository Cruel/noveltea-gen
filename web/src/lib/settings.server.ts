import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './session.server'
import { availableUserPiModels, validPiSelection, type PiSelection } from './pi-credentials.server'
import { listGitConnections } from './git-connections.server'
import { JsonInputError, readJsonInput } from './json-input.server'

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
export function readDefaultModel(store: StudioDatabase, user: string): PiSelection | null {
  const row = store.sqlite.prepare('SELECT default_model_json AS model FROM user_preferences WHERE owner_user_id=?')
    .get(user) as { model: string | null } | undefined
  if (!row?.model) return null
  const model = JSON.parse(row.model) as unknown
  if (!validPiSelection(model)) throw new Error('Invalid stored default model')
  return model
}
export async function settingsRequest(auth: StudioAuth, store: StudioDatabase, request: Request, baseURL: string) {
  try {
    assertStudioSchemaCurrent(store)
    const actor = await requireUser(auth, request.headers)
    if (!actor) return json({ error: 'Sign in required.' }, 401)
    if (request.method === 'GET') {
      const accounts = await auth.api.listUserAccounts({ headers: request.headers })
      return json({
        defaultModel: readDefaultModel(store, actor.id),
        loginMethods: accounts.filter(row => row.providerId === 'github' || row.providerId === 'gitlab')
          .map(row => ({ id: row.id, provider: row.providerId, accountId: row.accountId })),
        gitConnections: listGitConnections(store, actor.id),
        repositories: store.sqlite.prepare(`SELECT id,provider,name,connection_id AS connectionId
          FROM repositories WHERE owner_user_id=? ORDER BY provider,name`).all(actor.id),
      })
    }
    if (request.method !== 'PUT' && request.method !== 'DELETE')
      return json({ error: 'Method not allowed.' }, 405)
    if (request.headers.get('origin') !== baseURL) return json({ error: 'Cross-origin request refused.' }, 403)
    const input = await readJsonInput(request) as Record<string, unknown> | null
    if (!input || typeof input !== 'object' || Array.isArray(input)) return json({ error: 'Invalid settings.' }, 422)
    if (request.method === 'PUT') {
      const model = input.defaultModel
      if (model !== null && !validPiSelection(model)) return json({ error: 'Invalid default model.' }, 422)
      if (model !== null) {
        const available = await availableUserPiModels(store, actor.id)
        if (!available.some(item => item.provider === model.provider && item.id === model.id &&
          (!model.thinking || item.reasoning))) {
          return json({ error: 'Connect this Pi model before setting it as the default.' }, 422)
        }
      }
      store.sqlite.prepare(`INSERT INTO user_preferences(owner_user_id,default_model_json,updated_at)
        VALUES (?,?,?) ON CONFLICT(owner_user_id) DO UPDATE SET
        default_model_json=excluded.default_model_json,updated_at=excluded.updated_at`)
        .run(actor.id, model ? JSON.stringify(model) : null, new Date().toISOString())
      return json({ defaultModel: model })
    }
    if ((input.provider !== 'github' && input.provider !== 'gitlab') ||
      typeof input.accountRecordId !== 'string') return json({ error: 'Invalid login method.' }, 422)
    const accounts = (await auth.api.listUserAccounts({ headers: request.headers }))
      .filter(row => row.providerId === 'github' || row.providerId === 'gitlab')
    if (accounts.length < 2) return json({ error: 'Connect another login method before removing the last one.' }, 409)
    if (!accounts.some(row => row.providerId === input.provider && row.id === input.accountRecordId))
      return json({ error: 'Login method does not belong to this user.' }, 404)
    const dependent = store.sqlite.prepare(`SELECT 1 FROM repositories
      WHERE owner_user_id=? AND provider=? AND connection_id IS NULL LIMIT 1`)
      .get(actor.id, input.provider)
    if (dependent) return json({ error: 'Rebind legacy repositories to a Git connection before removing this login method.' }, 409)
    await auth.api.unlinkAccount({ headers: request.headers, body: {
      accountId: input.accountRecordId,
    } })
    return json({ unlinked: true })
  } catch (error) {
    if (error instanceof JsonInputError) return json({ error: error.message }, error.statusCode)
    console.error('[Studio Settings] Request failed', { kind: error instanceof Error ? error.constructor.name : 'unknown' })
    return json({ error: 'Settings could not be updated. Refresh and retry.' }, 409)
  }
}
