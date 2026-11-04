import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { readAuthConfig } from './auth'
import { authorInteractionRequest } from './author-interactions.server'

async function execute(request: Request, jobId: string): Promise<string> {
  const response = await authorInteractionRequest(
    auth, database, request, jobId, readAuthConfig().baseURL)
  const text = await response.text()
  if (!response.ok) {
    let error: string | undefined
    try { error = (JSON.parse(text) as { error?: string }).error } catch { /* no detail */ }
    throw new Error(error || 'Author interaction could not complete.')
  }
  // Preserve exact typed author-review fields, without loosening strict input validation.
  return text
}
function request(jobId: string, command?: string): Request {
  const headers = new Headers(getRequestHeaders())
  if (command !== undefined) headers.set('content-type', 'application/json')
  return new Request(readAuthConfig().baseURL + '/api/jobs/' + encodeURIComponent(jobId) + '/author', {
    method: command === undefined ? 'GET' : 'POST',
    headers,
    ...(command !== undefined ? { body: command } : {}),
  })
}
export const getAuthorInteractions = createServerFn({ method: 'GET' })
  .validator((jobId: string) => jobId)
  .handler(async ({ data }) => execute(request(data), data))

export const sendAuthorCommand = createServerFn({ method: 'POST' })
  .validator((data: { jobId: string; commandJson: string }) => data)
  .handler(async ({ data }) => execute(request(data.jobId, data.commandJson), data.jobId))
