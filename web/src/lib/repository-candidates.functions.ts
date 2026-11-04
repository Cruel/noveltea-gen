import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { readAuthConfig } from './auth'
import { discoverRepositoryCatalog, loadRepositorySourcePage } from './repository-candidates.server'
import type { RepositoryProvider, RepositorySource } from './repository-candidates.server'

export type {
  AvailableRepository, RepositoryAccount, RepositoryCatalog, RepositorySource, RepositoryPage,
} from './repository-candidates.server'

export const getRepositoryCandidates = createServerFn({ method: 'GET' })
  .handler(async () => discoverRepositoryCatalog(auth, database, getRequestHeaders(), readAuthConfig().baseURL))

export const loadMoreRepositoryCandidates = createServerFn({ method: 'GET' })
  .validator((source: RepositorySource) => {
    if (!source || !(['github', 'gitlab'] as RepositoryProvider[]).includes(source.provider) ||
        !(source.connectionId === null ||
          (typeof source.connectionId === 'string' && /^[0-9a-f-]{36}$/i.test(source.connectionId))) ||
        !Number.isSafeInteger(source.page) || source.page < 2 || source.page > 100 ||
        (source.provider === 'github' &&
          (!Number.isSafeInteger(source.installationId) || (source.installationId ?? 0) <= 0)))
      throw new Error('Invalid repository listing request.')
    return source
  })
  .handler(async ({ data }) =>
    loadRepositorySourcePage(auth, database, getRequestHeaders(), readAuthConfig().baseURL, data))
