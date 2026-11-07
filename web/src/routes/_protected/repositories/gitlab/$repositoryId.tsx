import { createFileRoute, redirect } from '@tanstack/react-router'
import { validateRepositoryBrowseSearch } from '../../../../lib/repository-story-navigation'

/** Preserve existing provider-qualified bookmarks; the destination resolves
 * the actual provider from the signed-in user's repository catalog. */
export const Route = createFileRoute('/_protected/repositories/gitlab/$repositoryId')({
  validateSearch: validateRepositoryBrowseSearch,
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: '/repositories/$repositoryId', params: { repositoryId: params.repositoryId },
      search, replace: true,
    })
  },
})
