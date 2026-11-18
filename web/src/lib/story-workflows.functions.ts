import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { readAuthConfig } from './auth'
import { githubStoryRequest } from './github-stories.server'
import { gitlabStoryRequest } from './gitlab-stories.server'
import { githubInitializationRequest } from './github-initialize.server'
import { gitlabInitializeRequest } from './gitlab-initialize.server'
import { githubJobRequest } from './github-jobs.server'
import { gitlabJobRequest } from './gitlab-jobs.server'
import { onboardingRequest } from './onboarding.server'
import { onboardingPiRequest } from './onboarding-pi.server'
import { onboardingQuery } from './onboarding-query'

type Provider = 'github' | 'gitlab'
type StoryRead = {
  provider: Provider; repositoryId: string; directory?: string; commit?: string
  mode?: 'discover'
}
type InitializationRead = { provider: Provider; repositoryId: string; directory?: string }
type Submission = { provider: Provider; json: string }
type Workspace = { repositoryId: string; workspace: string }
type WorkspaceSubmission = Workspace & { json: string }

async function unwrap(response: Response) {
  const body = await response.text()
  if (!response.ok) {
    let message: string | undefined
    try { message = (JSON.parse(body) as { error?: string }).error } catch { /* no detail */ }
    throw new Error(message || 'Studio operation failed.')
  }
  return body
}
function request(path: string, method: 'GET' | 'POST' | 'PUT', body?: string) {
  const headers = new Headers(getRequestHeaders())
  if (body !== undefined) headers.set('content-type', 'application/json')
  return new Request(readAuthConfig().baseURL + path, {
    method, headers, ...(body !== undefined ? { body } : {}),
  })
}
function params(values: Record<string, string | undefined>) {
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(values)) if (value !== undefined) query.set(name, value)
  return query.toString()
}
function providerStories(provider: Provider, req: Request) {
  return provider === 'github'
    ? githubStoryRequest(auth, database, req, readAuthConfig().baseURL)
    : gitlabStoryRequest(auth, database, req)
}
function providerInitialization(provider: Provider, req: Request) {
  return provider === 'github'
    ? githubInitializationRequest(auth, database, req, readAuthConfig().baseURL)
    : gitlabInitializeRequest(auth, database, req, readAuthConfig().baseURL)
}
function providerJob(provider: Provider, req: Request) {
  return provider === 'github'
    ? githubJobRequest(auth, database, req, readAuthConfig().baseURL)
    : gitlabJobRequest(auth, database, req, readAuthConfig().baseURL)
}

/** Application RPC, not browser HTTP routes. Existing owner-scoped validators stay authoritative. */
export const readRepositoryStories = createServerFn({ method: 'GET' })
  .validator((data: StoryRead) => data)
  .handler(async ({ data }) => unwrap(await providerStories(data.provider,
    request('/api/' + data.provider + '/stories?' + params({
      repositoryId: data.repositoryId, directory: data.directory, commit: data.commit, mode: data.mode,
    }), 'GET'))))

export const selectRepositoryStory = createServerFn({ method: 'POST' })
  .validator((data: Submission) => data)
  .handler(async ({ data }) => unwrap(await providerStories(data.provider,
    request('/api/' + data.provider + '/stories', 'POST', data.json))))

export const inspectRepositoryInitialization = createServerFn({ method: 'GET' })
  .validator((data: InitializationRead) => data)
  .handler(async ({ data }) => unwrap(await providerInitialization(data.provider,
    request('/api/' + data.provider + '/initialize?' +
      params({ repositoryId: data.repositoryId, directory: data.directory }), 'GET'))))

export const initializeRepositoryStory = createServerFn({ method: 'POST' })
  .validator((data: Submission) => data)
  .handler(async ({ data }) => unwrap(await providerInitialization(data.provider,
    request('/api/' + data.provider + '/initialize', 'POST', data.json))))

export const prepareRepositoryJob = createServerFn({ method: 'POST' })
  .validator((data: Submission) => data)
  .handler(async ({ data }) => unwrap(await providerJob(data.provider,
    request('/api/' + data.provider + '/jobs', 'POST', data.json))))

export const loadOnboardingWorkspace = createServerFn({ method: 'GET' })
  .validator((data: Workspace) => data)
  .handler(async ({ data }) => unwrap(await onboardingRequest(auth, database,
    request('/api/onboarding?' + onboardingQuery(data), 'GET'), readAuthConfig().baseURL)))

export const saveOnboardingWorkspace = createServerFn({ method: 'POST' })
  .validator((data: WorkspaceSubmission) => data)
  .handler(async ({ data }) => unwrap(await onboardingRequest(auth, database,
    request('/api/onboarding?' + onboardingQuery(data), 'PUT', data.json), readAuthConfig().baseURL)))

export const reviewOnboardingWorkspace = createServerFn({ method: 'POST' })
  .validator((data: WorkspaceSubmission) => data)
  .handler(async ({ data }) => unwrap(await onboardingRequest(auth, database,
    request('/api/onboarding?' + onboardingQuery(data), 'POST', data.json), readAuthConfig().baseURL)))

export const loadPiDiscovery = createServerFn({ method: 'GET' })
  .validator((data: Workspace) => data)
  .handler(async ({ data }) => unwrap(await onboardingPiRequest(auth, database,
    request('/api/onboarding/pi?' + onboardingQuery(data), 'GET'), readAuthConfig().baseURL)))

export const actPiDiscovery = createServerFn({ method: 'POST' })
  .validator((data: WorkspaceSubmission) => data)
  .handler(async ({ data }) => unwrap(await onboardingPiRequest(auth, database,
    request('/api/onboarding/pi?' + onboardingQuery(data), 'POST', data.json), readAuthConfig().baseURL)))
