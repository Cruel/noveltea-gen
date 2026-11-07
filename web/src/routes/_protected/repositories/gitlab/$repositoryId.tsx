import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { RepositoryStoryBrowser } from '../-RepositoryStoryBrowser'
import { validateRepositoryBrowseSearch } from '../../../../lib/repository-story-navigation'

export const Route = createFileRoute('/_protected/repositories/gitlab/$repositoryId')({
  validateSearch: validateRepositoryBrowseSearch,
  component: GitlabStories,
})

function GitlabStories() {
  const { repositoryId } = Route.useParams()
  const location = Route.useSearch()
  const navigate = useNavigate({ from: '/repositories/gitlab/$repositoryId' })
  return <RepositoryStoryBrowser key={repositoryId} provider="gitlab" repositoryId={repositoryId}
    location={location}
    onNavigate={(search, replace = false) => {
      void navigate({ search, replace })
    }} />
}
