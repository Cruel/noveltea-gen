import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './session.server'
import { availableUserPiModels, validPiSelection, type PiSelection } from './pi-credentials.server'
import { listGitConnections } from './git-connections.server'
import { JsonInputError, readJsonInput } from './json-input.server'
import type { SettingsPreferences } from '../persistence/contracts'

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
export async function readDefaultModel(preferences: SettingsPreferences, user: string): Promise<PiSelection | null> {
  const stored = await preferences.getDefaultModel(user)
  if (stored === null) return null
  if (!validPiSelection(stored.selection)) throw new Error('Invalid stored default model')
  return stored.selection
}
export async function settingsRequest(auth: StudioAuth, store: StudioDatabase, request: Request, baseURL: string,
  preferences: SettingsPreferences = store.persistence.settings) {
  try {
    assertStudioSchemaCurrent(store)
    const actor = await requireUser(auth, request.headers)
    if (!actor) return json({ error: 'Sign in required.' }, 401)
    if (request.method === 'GET') {
      const accounts = await auth.api.listUserAccounts({ headers: request.headers })
      return json({
        defaultModel: await readDefaultModel(preferences, actor.id),
        loginMethods: accounts.filter(row => row.providerId === 'github' || row.providerId === 'gitlab')
          .map(row => ({ id: row.id, provider: row.providerId, accountId: row.accountId })),
        gitConnections: listGitConnections(store, actor.id),
        repositories: await preferences.listRepositories(actor.id),
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
      await preferences.putDefaultModel(actor.id, model, new Date().toISOString())
      return json({ defaultModel: model })
    }
    if ((input.provider !== 'github' && input.provider !== 'gitlab') ||
      typeof input.accountRecordId !== 'string') return json({ error: 'Invalid login method.' }, 422)
    const accounts = (await auth.api.listUserAccounts({ headers: request.headers }))
      .filter(row => row.providerId === 'github' || row.providerId === 'gitlab')
    if (accounts.length < 2) return json({ error: 'Connect another login method before removing the last one.' }, 409)
    if (!accounts.some(row => row.providerId === input.provider && row.id === input.accountRecordId))
      return json({ error: 'Login method does not belong to this user.' }, 404)
    if (await preferences.hasLegacyRepositories(actor.id, input.provider)) return json({ error: 'Rebind legacy repositories to a Git connection before removing this login method.' }, 409)
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
