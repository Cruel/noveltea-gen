import type { StudioAuth } from './auth'
import type { StudioStore as StudioDatabase } from '../persistence/store'
import { requireUser } from './session.server'
import { listGitConnections } from './git-connections.server'
import { githubRepositoryRequest, readGithubAppOptions } from './github-repositories.server'
import { gitlabRepositoryRequest } from './gitlab-repositories.server'

export type RepositoryProvider = 'github' | 'gitlab'
export type RepositoryAccount = {
  provider: RepositoryProvider
  connectionId: string | null
  label: string
}
export type AvailableRepository = {
  provider: RepositoryProvider
  providerRepositoryId: string
  name: string
  account: string
  connectionId: string | null
  private: boolean
  empty: boolean
  added: boolean
}
export type RepositorySource = RepositoryAccount & {
  installationId?: number
  installationName?: string
  page: number
  hasMore: boolean
}
export type RepositoryCatalog = {
  repositories: AvailableRepository[]
  sources: RepositorySource[]
  accounts: RepositoryAccount[]
  warnings: string[]
  pendingGitHub: string[]
}
export type RepositoryPage = { repositories: AvailableRepository[]; source: RepositorySource }

type GitHubListing = {
  installations: Array<{
    id: number; account: string; suspended: boolean; canImport: boolean; settingsUrl: string
  }>
  pending: string[]
  repositories?: Array<{ id: number; fullName: string; private: boolean }>
  page?: number; hasMore?: boolean
}
type GitLabListing = {
  projects: Array<{ id: number; name: string; path: string; visibility: string; empty: boolean }>
  page: number; nextPage: number | null
}

async function installed(store: StudioDatabase, userId: string): Promise<Set<string>> {
  const rows = await store.persistence.repositories.identities(userId)
  return new Set(rows.map(row => row.provider + ':' + row.id))
}

export async function discoverAccounts(store: StudioDatabase, userId: string): Promise<{
  accounts: RepositoryAccount[]; warnings: string[]
}> {
  const connections = await listGitConnections(store, userId)
  const legacy = await store.persistence.git.legacyProviders(userId)
  const accounts: RepositoryAccount[] = []
  const warnings: string[] = []
  for (const provider of ['github', 'gitlab'] as const) {
    const forProvider = connections.filter(connection => connection.provider === provider)
    for (const connection of forProvider) {
      if (connection.status === 'connected') {
        accounts.push({ provider, connectionId: connection.id, label: connection.login })
      } else if (connection.status === 'reauthorize') {
        warnings.push(providerLabel(provider) + ' account ' + connection.login + ' needs reconnection in Settings.')
      }
    }
    // Never silently fall back to a login credential when a dedicated account
    // is connected or awaiting reauthorization. The existing provider handlers
    // remain authoritative for token and permission verification.
    if (!forProvider.some(connection => connection.status !== 'disconnected') &&
        legacy.includes(provider)) {
      accounts.push({ provider, connectionId: null, label: providerLabel(provider) + ' login' })
    }
  }
  return { accounts, warnings }
}

function providerLabel(provider: RepositoryProvider) {
  return provider === 'github' ? 'GitHub' : 'GitLab'
}

function encodeRequest(baseURL: string, path: string, headers: Headers, params: Record<string, string | number | null>) {
  const url = new URL(path, baseURL)
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, String(value))
  }
  return new Request(url, { method: 'GET', headers })
}

async function unwrap<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error || 'Could not list provider repositories.')
  return body
}

async function githubPage(auth: StudioAuth, store: StudioDatabase, headers: Headers,
  baseURL: string, account: RepositoryAccount, installationId?: number, page = 1): Promise<GitHubListing> {
  return unwrap<GitHubListing>(await githubRepositoryRequest(auth, store,
    encodeRequest(baseURL, '/api/github/repositories', headers, {
      connectionId: account.connectionId, installationId: installationId ?? null, page,
    }), readGithubAppOptions()))
}

async function gitlabPage(auth: StudioAuth, store: StudioDatabase, headers: Headers,
  baseURL: string, account: RepositoryAccount, page = 1): Promise<GitLabListing> {
  return unwrap<GitLabListing>(await gitlabRepositoryRequest(auth, store,
    encodeRequest(baseURL, '/api/gitlab/repositories', headers, {
      connectionId: account.connectionId, page,
    })))
}

function githubItems(page: GitHubListing, account: RepositoryAccount, known: Set<string>): AvailableRepository[] {
  return (page.repositories ?? []).map(repo => ({
    provider: 'github', providerRepositoryId: String(repo.id),
    name: repo.fullName, account: account.label, connectionId: account.connectionId,
    private: repo.private, empty: false, added: known.has('github:' + repo.id),
  }))
}

function gitlabItems(page: GitLabListing, account: RepositoryAccount, known: Set<string>): AvailableRepository[] {
  return page.projects.map(project => ({
    provider: 'gitlab', providerRepositoryId: String(project.id),
    name: project.path, account: account.label, connectionId: account.connectionId,
    private: project.visibility === 'private', empty: project.empty,
    added: known.has('gitlab:' + project.id),
  }))
}

async function forAccounts<T>(accounts: RepositoryAccount[], work: (account: RepositoryAccount) => Promise<T>) {
  return Promise.allSettled(accounts.map(work))
}

/** The composed catalog invokes existing owner-scoped, provider-validated GET
 * handlers. Failure of one provider or installation cannot conceal the others. */
export async function discoverRepositoryCatalog(auth: StudioAuth, store: StudioDatabase,
  headers: Headers, baseURL: string): Promise<RepositoryCatalog> {
  const viewer = await requireUser(auth, headers)
  if (!viewer) throw new Error('Sign in required.')
  const { accounts, warnings } = await discoverAccounts(store, viewer.id)
  const known = await installed(store, viewer.id)
  const catalog: RepositoryCatalog = { accounts, warnings, repositories: [], sources: [], pendingGitHub: [] }
  const results = await forAccounts(accounts, async account => {
    if (account.provider === 'gitlab') return { account, data: await gitlabPage(auth, store, headers, baseURL, account) }
    return { account, data: await githubPage(auth, store, headers, baseURL, account) }
  })

  const githubInstallations: Array<{ account: RepositoryAccount; id: number; name: string }> = []
  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index]!
    const result = results[index]!
    if (result.status === 'rejected') {
      catalog.warnings.push(providerLabel(account.provider) + ' (' + account.label + '): ' +
        (result.reason instanceof Error ? result.reason.message : 'Repository listing unavailable'))
      continue
    }
    if (account.provider === 'gitlab') {
      const page = result.value.data as GitLabListing
      catalog.repositories.push(...gitlabItems(page, account, known))
      catalog.sources.push({ ...account, page: 1, hasMore: page.nextPage !== null && page.nextPage <= 100 })
    } else {
      const page = result.value.data as GitHubListing
      catalog.pendingGitHub.push(...page.pending)
      for (const installation of page.installations) {
        if (installation.canImport) {
          githubInstallations.push({ account, id: installation.id, name: installation.account })
        } else {
          catalog.warnings.push('GitHub App installation for ' + installation.account +
            ' is suspended or lacks Contents write permission.')
        }
      }
    }
  }

  // Bound external API fan-out to four at a time. A provider may expose many
  // installations; remaining repositories can still be imported by URL.
  const selected = githubInstallations.slice(0, 40)
  if (githubInstallations.length > selected.length)
    catalog.warnings.push('Showing repositories from the first 40 GitHub installations. Use the GitHub URL option for another installation.')
  for (let offset = 0; offset < selected.length; offset += 4) {
    const batch = selected.slice(offset, offset + 4)
    const results = await Promise.allSettled(batch.map(installation =>
      githubPage(auth, store, headers, baseURL, installation.account, installation.id)))
    for (let index = 0; index < batch.length; index++) {
      const installation = batch[index]!
      const result = results[index]!
      if (result.status === 'rejected') {
        catalog.warnings.push('GitHub (' + installation.name + '): ' +
          (result.reason instanceof Error ? result.reason.message : 'Repository listing unavailable'))
        continue
      }
      const page = result.value
      catalog.repositories.push(...githubItems(page, installation.account, known))
      catalog.sources.push({ ...installation.account,
        installationId: installation.id, installationName: installation.name,
        page: 1, hasMore: !!page.hasMore })
    }
  }
  return catalog
}

/** Read the next page for a source already selected in the browser.
 * The provider always re-verifies owner, credential and remote access. */
export async function loadRepositorySourcePage(auth: StudioAuth, store: StudioDatabase,
  headers: Headers, baseURL: string, source: RepositorySource): Promise<RepositoryPage> {
  const viewer = await requireUser(auth, headers)
  if (!viewer) throw new Error('Sign in required.')
  const available = (await discoverAccounts(store, viewer.id)).accounts
  const account = available.find(item => item.provider === source.provider &&
    item.connectionId === source.connectionId)
  if (!account) throw new Error('Repository identity is no longer connected.')
  if (!Number.isSafeInteger(source.page) || source.page < 2 || source.page > 100)
    throw new Error('Invalid repository page.')
  const known = await installed(store, viewer.id)
  if (account.provider === 'gitlab') {
    const page = await gitlabPage(auth, store, headers, baseURL, account, source.page)
    return { repositories: gitlabItems(page, account, known), source: {
      ...account, page: source.page, hasMore: page.nextPage !== null && page.nextPage <= 100,
    } }
  }
  if (!Number.isSafeInteger(source.installationId) || (source.installationId ?? 0) <= 0)
    throw new Error('Invalid GitHub installation.')
  const page = await githubPage(auth, store, headers, baseURL, account, source.installationId, source.page)
  return { repositories: githubItems(page, account, known), source: {
    ...account, installationId: source.installationId, installationName: source.installationName,
    page: source.page, hasMore: !!page.hasMore,
  } }
}
