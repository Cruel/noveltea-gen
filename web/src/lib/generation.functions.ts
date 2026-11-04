import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { readAuthConfig } from './auth'
import { generationConfigurationRequest } from './generation-config.server'
import { generationJobRequest } from './fixture-jobs.server'

function request(jobId: string, suffix: string, method: 'GET' | 'PUT' | 'POST', value?: string) {
  const headers = new Headers(getRequestHeaders())
  if (value !== undefined) headers.set('content-type', 'application/json')
  return new Request(readAuthConfig().baseURL + '/api/jobs/' + encodeURIComponent(jobId) + suffix, {
    method, headers, ...(value !== undefined ? { body: value } : {}),
  })
}
async function unwrap(response: Response) {
  const body = await response.text()
  if (!response.ok) {
    let message: string | undefined
    try { message = (JSON.parse(body) as { error?: string }).error } catch { /* no detail */ }
    throw new Error(message || 'Job configuration operation failed.')
  }
  // Keep the existing bounded, validated request handlers authoritative.
  return body
}
export const readGenerationConfiguration = createServerFn({ method: 'GET' })
  .validator((jobId: string) => jobId)
  .handler(async ({ data }) => unwrap(await generationConfigurationRequest(
    auth, database, request(data, '/configuration', 'GET'),
    data, readAuthConfig().baseURL)))

export const saveGenerationConfiguration = createServerFn({ method: 'POST' })
  .validator((data: { jobId: string; draftJson: string }) => data)
  .handler(async ({ data }) => unwrap(await generationConfigurationRequest(
    auth, database, request(data.jobId, '/configuration', 'PUT', data.draftJson),
    data.jobId, readAuthConfig().baseURL)))

export const startConfiguredGeneration = createServerFn({ method: 'POST' })
  .validator((data: { jobId: string; requestJson: string }) => data)
  .handler(async ({ data }) => unwrap(await generationJobRequest(
    auth, database, request(data.jobId, '', 'POST', data.requestJson),
    data.jobId, readAuthConfig().baseURL)))
