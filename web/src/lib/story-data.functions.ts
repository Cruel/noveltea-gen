import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { readAuthConfig } from './auth'
import { storyExplorerRequest, storyRelationshipsRequest } from './story-explorer.server'
import { storyWorkspaceExplorerRequest } from './story-workspace-explorer.server'
import { jobChangesRequest } from './job-changes.server'
import type { ExplorerIndex, ExplorerRecord, ExplorerGraph } from './story-explorer.server'

async function result<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(value.error || 'Could not read the verified Story.')
  return value
}
function request(jobId: string, suffix: string, args: Record<string, string> = {}) {
  const params = new URLSearchParams(args)
  return new Request(readAuthConfig().baseURL + '/api/jobs/' + encodeURIComponent(jobId) +
    suffix + (params.size ? '?' + params : ''), { headers: getRequestHeaders() })
}

export const readStoryIndex = createServerFn({ method: 'GET' })
  .validator((jobId: string) => jobId)
  .handler(async ({ data }) => {
    const { index } = await result<{ index: ExplorerIndex }>(
      await storyExplorerRequest(auth, database, request(data, '/records'), data))
    // Native-readiness details have already passed JSON serialization at the handler boundary.
    return { ...index, readiness: index.readiness as object | null }
  })

export const readStoryRecord = createServerFn({ method: 'GET' })
  .validator((data: { jobId: string; recordId: string }) => data)
  .handler(async ({ data }) => result<{ record: ExplorerRecord; markdown: string; headSha: string }>(
    await storyExplorerRequest(auth, database,
      request(data.jobId, '/records', { id: data.recordId }), data.jobId)))

export const readStoryGraph = createServerFn({ method: 'GET' })
  .validator((data: { jobId: string; selectedId: string; scope: 'focused' | 'related' }) => data)
  .handler(async ({ data }) => result<{ graph: ExplorerGraph }>(
    await storyRelationshipsRequest(auth, database,
      request(data.jobId, '/relationships', { id: data.selectedId, scope: data.scope }), data.jobId)))

type WorkspaceIdentity = { storyId: string; threadId: string | null }
const workspaceRequest = (identity: WorkspaceIdentity, suffix: string, args: Record<string, string> = {}) => {
  const params = new URLSearchParams(args)
  return new Request(readAuthConfig().baseURL + '/stories/' + encodeURIComponent(identity.storyId) +
    '/explorer/' + suffix + (params.size ? '?' + params : ''),
  { headers: getRequestHeaders() })
}

export const readWorkspaceStoryIndex = createServerFn({ method: 'GET' })
  .validator((data: WorkspaceIdentity) => data)
  .handler(async ({ data }) => {
    const view = await result<{
      source: 'base' | 'thread'; baseSha: string; jobId: string | null; index: ExplorerIndex | null
      story?: { title: string; provider: 'github' | 'gitlab'; directory: string }
    }>(await storyWorkspaceExplorerRequest(auth, database,
      workspaceRequest(data, 'index'), data.storyId, data.threadId, 'index'))
    return { ...view, index: view.index ? {
      ...view.index, readiness: view.index.readiness as object | null,
    } : null }
  })

export const readWorkspaceStoryRecord = createServerFn({ method: 'GET' })
  .validator((data: WorkspaceIdentity & { recordId: string }) => data)
  .handler(async ({ data }) => result<{ record: ExplorerRecord; markdown: string; headSha: string }>(
    await storyWorkspaceExplorerRequest(auth, database,
      workspaceRequest(data, 'record', { id: data.recordId }), data.storyId, data.threadId, 'record')))

export const readWorkspaceStoryGraph = createServerFn({ method: 'GET' })
  .validator((data: WorkspaceIdentity & { selectedId: string; scope: 'focused' | 'related' }) => data)
  .handler(async ({ data }) => result<{ graph: ExplorerGraph }>(
    await storyWorkspaceExplorerRequest(auth, database,
      workspaceRequest(data, 'graph', { id: data.selectedId, scope: data.scope }),
      data.storyId, data.threadId, 'graph')))

export const readJobChanges = createServerFn({ method: 'GET' })
  .validator((data: { jobId: string; file?: string }) => data)
  .handler(async ({ data }) => result<{
    headSha: string; files?: string[]; file?: string; diff?: string
  }>(await jobChangesRequest(auth, database,
    request(data.jobId, '/changes', data.file ? { file: data.file } : {}), data.jobId)))
