import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { readAuthConfig } from './auth'
import { settingsRequest } from './settings.server'
import { gitConnectionRequest } from './git-connections.server'

export type GitProvider = 'github' | 'gitlab'
export type SavedModel = { provider: string; id: string; thinking?: 'low' | 'medium' | 'high' } | null
export type StudioSettings = {
  defaultModel: SavedModel
  loginMethods: Array<{ id: string; provider: GitProvider; accountId: string }>
  gitConnections: Array<{ id: string; provider: GitProvider; accountId: string; login: string;
    status: 'connected' | 'reauthorize' | 'disconnected'; accessExpiresAt: number | null }>
  repositories: Array<{ id: string; provider: GitProvider; name: string; connectionId: string | null }>
}

async function unwrap<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(value.error ?? 'Studio request failed.')
  return value
}

function internalRequest(path: string, method: 'GET' | 'PUT' | 'DELETE' | 'POST' = 'GET', input?: object) {
  const url = readAuthConfig().baseURL + path
  const headers = new Headers(getRequestHeaders())
  if (input) headers.set('content-type', 'application/json')
  return new Request(url, { method, headers, ...(input ? { body: JSON.stringify(input) } : {}) })
}

/** Internal, authenticated RPC. Provider callbacks and SSE remain HTTP routes. */
export const getSettings = createServerFn({ method: 'GET' }).handler(async () =>
  unwrap<StudioSettings>(await settingsRequest(auth, database, internalRequest('/api/settings'), readAuthConfig().baseURL)))

export const setDefaultModel = createServerFn({ method: 'POST' })
  .validator((data: SavedModel) => data)
  .handler(async ({ data }) => unwrap<{ defaultModel: SavedModel }>(
    await settingsRequest(auth, database,
      internalRequest('/api/settings', 'PUT', { defaultModel: data }), readAuthConfig().baseURL)))

export const unlinkLogin = createServerFn({ method: 'POST' })
  .validator((data: { provider: GitProvider; accountRecordId: string }) => data)
  .handler(async ({ data }) => unwrap<{ unlinked: boolean }>(
    await settingsRequest(auth, database,
      internalRequest('/api/settings', 'DELETE', data), readAuthConfig().baseURL)))

export const beginGitConnection = createServerFn({ method: 'POST' })
  .validator((provider: GitProvider) => provider)
  .handler(async ({ data }) => unwrap<{ authorizationUrl: string }>(
    await gitConnectionRequest(auth, database,
      internalRequest('/api/integrations/git', 'POST', { provider: data }))))

export const disconnectGitConnection = createServerFn({ method: 'POST' })
  .validator((connectionId: string) => connectionId)
  .handler(async ({ data }) => unwrap<{ connections: StudioSettings['gitConnections'] }>(
    await gitConnectionRequest(auth, database,
      internalRequest('/api/integrations/git', 'DELETE', { connectionId: data }))))

export const rebindGitRepository = createServerFn({ method: 'POST' })
  .validator((data: { repositoryId: string; connectionId: string | null }) => data)
  .handler(async ({ data }) => unwrap<{ rebound: boolean }>(
    await gitConnectionRequest(auth, database,
      internalRequest('/api/integrations/git', 'PUT', data))))
