import type { AvailableRepository, RepositorySource } from './repository-candidates.server'

export const candidateKey = (repo: AvailableRepository) =>
  [repo.provider, repo.providerRepositoryId, repo.connectionId ?? 'legacy'].join(':')

export const sourceKey = (source: RepositorySource) =>
  [source.provider, source.connectionId ?? 'legacy', source.installationId ?? ''].join(':')

/** Provider pages can overlap during concurrent imports, refreshes or remote
 * changes. Deduplicate by remote identity plus selected credential. */
export function mergeCandidates(
  existing: readonly AvailableRepository[], incoming: readonly AvailableRepository[],
): AvailableRepository[] {
  const rows = new Map(existing.map(repo => [candidateKey(repo), repo]))
  for (const repo of incoming) rows.set(candidateKey(repo), repo)
  return [...rows.values()]
}

export function eligibleCandidates(
  entries: readonly AvailableRepository[], query: string, added: ReadonlySet<string>,
): AvailableRepository[] {
  const needle = query.trim().toLocaleLowerCase()
  return entries.filter(repo => !repo.added && !added.has(candidateKey(repo)) &&
    (!needle || [repo.name, repo.account, repo.provider].some(text => text.toLocaleLowerCase().includes(needle))))
    .sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider) ||
      a.account.localeCompare(b.account))
}
