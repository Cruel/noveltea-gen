import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { readAuthConfig } from './auth'
import { piModelsRequest } from './pi-models.server'

function request(method: 'GET' | 'POST' | 'DELETE', payload?: string) {
  const headers = new Headers(getRequestHeaders())
  if (payload !== undefined) headers.set('content-type', 'application/json')
  return new Request(readAuthConfig().baseURL + '/api/pi/models', { method, headers,
    ...(payload !== undefined ? { body: payload } : {}),
  })
}
async function unwrap(response: Response) {
  const body = await response.text()
  if (!response.ok) {
    let message: string | undefined
    try { message = (JSON.parse(body) as { error?: string }).error } catch { /* no details */ }
    throw new Error(message || 'Pi credential operation failed.')
  }
  return body
}
export const getPiCatalog = createServerFn({ method: 'GET' })
  .handler(async () => unwrap(await piModelsRequest(auth, database,
    request('GET'), readAuthConfig().baseURL)))

export const mutatePiCredentials = createServerFn({ method: 'POST' })
  .validator((data: { method: 'POST' | 'DELETE'; payloadJson: string }) => data)
  .handler(async ({ data }) => unwrap(await piModelsRequest(auth, database,
    request(data.method, data.payloadJson), readAuthConfig().baseURL)))
