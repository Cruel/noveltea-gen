import type { CatalogProvider } from '../persistence/contracts'

export type RepositoryBrowseSearch = { directory: string; commit: string }

const SHA = /^[a-f0-9]{40}$/i

/** Both provider routes use the same shareable, immutable Story browsing link. */
export function validateRepositoryBrowseSearch(search: Record<string, unknown>): RepositoryBrowseSearch {
  return {
    directory: typeof search.directory === 'string' ? search.directory : '',
    commit: typeof search.commit === 'string' && SHA.test(search.commit) ? search.commit.toLowerCase() : '',
  }
}

export function repositoryBrowseHref(
  provider: CatalogProvider, repositoryId: string, directory = '', commit: string | null = null,
): string {
  const query = new URLSearchParams()
  if (directory) query.set('directory', directory)
  if (commit && SHA.test(commit)) query.set('commit', commit.toLowerCase())
  const suffix = query.toString()
  return '/repositories/' + provider + '/' + encodeURIComponent(repositoryId) +
    (suffix ? '?' + suffix : '')
}
