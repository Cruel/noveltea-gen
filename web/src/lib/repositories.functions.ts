import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { readAuthConfig } from './auth'
import { githubRepositoryRequest, githubInstallStart, readGithubAppOptions } from './github-repositories.server'
import { gitlabRepositoryRequest } from './gitlab-repositories.server'

export type GitHubListing = {
  installations: Array<{ id: number; account: string; accountType: string; selection: 'all' | 'selected';
    suspended: boolean; canImport: boolean; settingsUrl: string }>
  repositories?: Array<{ id: number; fullName: string; private: boolean }>
  pending: string[]; total?: number; page?: number; hasMore?: boolean
}
export type GitLabListing = {
  projects: Array<{ id: number; name: string; path: string; visibility: string; empty: boolean }>
  page: number; nextPage: number | null
}
export type GitHubListingInput = { installationId?: number; page?: number; connectionId?: string }
export type GitLabListingInput = { page?: number; connectionId?: string }

async function result<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(value.error || 'Repository request failed.')
  return value
}
function request(path: string, data?: object): Request {
  const headers = new Headers(getRequestHeaders())
  if (data) headers.set('content-type', 'application/json')
  return new Request(readAuthConfig().baseURL + path, {
    method: data ? 'POST' : 'GET', headers,
    ...(data ? { body: JSON.stringify(data) } : {}),
  })
}
function query(path: string, input: Record<string, unknown>) {
  const parameters = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    if (value !== null && value !== undefined && value !== '') parameters.set(key, String(value))
  }
  return path + '?' + parameters
}

export const listGitHubRepositories = createServerFn({ method: 'GET' })
  .validator((data: GitHubListingInput) => data)
  .handler(async ({ data }) => result<GitHubListing>(
    await githubRepositoryRequest(auth, database,
      request(query('/api/github/repositories', data)), readGithubAppOptions())))

export const importGitHubRepository = createServerFn({ method: 'POST' })
  .validator((data: { fullName: string; connectionId?: string | null }) => data)
  .handler(async ({ data }) => result<{ repository: { id: string; name: string } }>(
    await githubRepositoryRequest(auth, database,
      request('/api/github/repositories', data), readGithubAppOptions())))

export const beginGitHubInstallation = createServerFn({ method: 'POST' })
  .validator((data: { fullName?: string | null; connectionId?: string }) => data)
  .handler(async ({ data }) => result<{ url: string }>(
    await githubInstallStart(auth, database,
      request('/api/github/install', data), readGithubAppOptions())))

export const listGitLabProjects = createServerFn({ method: 'GET' })
  .validator((data: GitLabListingInput) => data)
  .handler(async ({ data }) => result<GitLabListing>(
    await gitlabRepositoryRequest(auth, database,
      request(query('/api/gitlab/repositories', data)))))

export const importGitLabProject = createServerFn({ method: 'POST' })
  .validator((data: { projectId: number; connectionId?: string | null }) => data)
  .handler(async ({ data }) => result<{ repository: { id: string; name: string } }>(
    await gitlabRepositoryRequest(auth, database,
      request('/api/gitlab/repositories', data))))
