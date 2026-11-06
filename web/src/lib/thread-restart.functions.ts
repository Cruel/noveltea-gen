import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { readAuthConfig } from './auth'
import { threadRestartRequest, type RestartPreview, type RestartSelection, type DiscardRestartOutcome } from './thread-restart.server'

async function result<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? 'Restart request failed.')
  return body
}
function request(threadId: string, body?: RestartSelection, discardOld = false) {
  const headers = new Headers(getRequestHeaders())
  if (body) headers.set('content-type', 'application/json')
  return new Request(readAuthConfig().baseURL + '/api/threads/' + encodeURIComponent(threadId) + (discardOld ? '/restart-discard' : '/restart'), {
    method: body ? 'POST' : 'GET', headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}
export const getThreadRestartPreview = createServerFn({ method: 'GET' })
  .validator((threadId: string) => threadId)
  .handler(async ({ data }) => result<RestartPreview>(await threadRestartRequest(
    auth, database, request(data), data, readAuthConfig().baseURL)))

export const restartThread = createServerFn({ method: 'POST' })
  .validator((data: RestartSelection & { threadId: string }) => data)
  .handler(async ({ data }) => result<{ id: string; storyId: string; threadId: string }>(
    await threadRestartRequest(auth, database, request(data.threadId, {
      childId: data.childId, mode: data.mode, sourceJobId: data.sourceJobId,
      originalSha: data.originalSha, selectedSha: data.selectedSha, targetBranch: data.targetBranch,
    }), data.threadId, readAuthConfig().baseURL)))

export const restartAndDiscardThread = createServerFn({ method: 'POST' })
  .validator((data: RestartSelection & { threadId: string }) => data)
  .handler(async ({ data }) => result<DiscardRestartOutcome>(
    await threadRestartRequest(auth, database, request(data.threadId, {
      childId: data.childId, mode: data.mode, sourceJobId: data.sourceJobId,
      originalSha: data.originalSha, selectedSha: data.selectedSha, targetBranch: data.targetBranch,
    }, true), data.threadId, readAuthConfig().baseURL, undefined, true)))
