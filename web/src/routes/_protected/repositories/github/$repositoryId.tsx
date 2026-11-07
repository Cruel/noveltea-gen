import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { RepositoryStoryBrowser } from '../-RepositoryStoryBrowser'
import { validateRepositoryBrowseSearch } from '../../../../lib/repository-story-navigation'

export const Route = createFileRoute('/_protected/repositories/github/$repositoryId')({
  validateSearch: validateRepositoryBrowseSearch,
  component: GithubStories,
})

function GithubStories() {
  const { repositoryId } = Route.useParams()
  const location = Route.useSearch()
  const navigate = useNavigate({ from: '/repositories/github/$repositoryId' })
  return <RepositoryStoryBrowser key={repositoryId} provider="github" repositoryId={repositoryId}
    location={location}
    onNavigate={(search, replace = false) => {
      void navigate({ search, replace })
    }} />
}
