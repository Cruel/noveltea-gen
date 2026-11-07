import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { RepositoryStoryBrowser } from './-RepositoryStoryBrowser'
import { getRepositoryForBrowser } from '../../../lib/repository-browser.functions'
import { validateRepositoryBrowseSearch } from '../../../lib/repository-story-navigation'

export const Route = createFileRoute('/_protected/repositories/$repositoryId')({
  validateSearch: validateRepositoryBrowseSearch,
  loader: ({ params }) => getRepositoryForBrowser({ data: params.repositoryId }),
  component: RepositoryStories,
})

function RepositoryStories() {
  const repository = Route.useLoaderData()
  const { repositoryId } = Route.useParams()
  const location = Route.useSearch()
  const navigate = useNavigate({ from: '/repositories/$repositoryId' })
  return <RepositoryStoryBrowser key={repositoryId} provider={repository.provider}
    repositoryId={repositoryId} location={location}
    onNavigate={(search, replace = false) => {
      void navigate({ search, replace })
    }} />
}
