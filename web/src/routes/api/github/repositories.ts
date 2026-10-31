import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../lib/runtime.server'
import { githubRepositoryRequest, readGithubAppOptions } from '../../../lib/github-repositories.server'

export const Route = createFileRoute('/api/github/repositories')({
  server: { handlers: {
    GET: ({ request }) => githubRepositoryRequest(auth, database, request, readGithubAppOptions()),
    POST: ({ request }) => githubRepositoryRequest(auth, database, request, readGithubAppOptions()),
  } },
})
