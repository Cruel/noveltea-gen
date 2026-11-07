import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { resolveRepositoryForBrowser } from './repository-browser.server'

/** Authenticated, owner-scoped repository lookup for the provider-neutral browser. */
export const getRepositoryForBrowser = createServerFn({ method: 'GET' })
  .validator((repositoryId: string) => repositoryId)
  .handler(async ({ data }) => resolveRepositoryForBrowser(auth, database, getRequestHeaders(), data))
