import { Navigate, createFileRoute } from '@tanstack/react-router'

/** Preserve old bookmarks and provider callback URLs, but expose only one
 * dashboard-owned repository picker in the authenticated UI. */
export const Route = createFileRoute('/_protected/repositories/add')({
  validateSearch: (search: Record<string, unknown>) => ({
    result: typeof search.result === 'string' ? search.result : 'open',
  }),
  component: LegacyAddRepository,
})

function LegacyAddRepository() {
  const { result } = Route.useSearch()
  return <Navigate to="/dashboard" search={{ addRepository: result }} replace />
}
