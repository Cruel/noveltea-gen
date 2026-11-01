import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../lib/runtime.server'
import { githubInitializationRequest } from '../../../lib/github-initialize.server'
import { readGithubAppOptions } from '../../../lib/github-repositories.server'

export const Route = createFileRoute('/api/github/initialize')({
  server: { handlers: {
    GET: ({ request }) => githubInitializationRequest(auth, database, request, readGithubAppOptions().baseURL),
    POST: ({ request }) => githubInitializationRequest(auth, database, request, readGithubAppOptions().baseURL),
  } },
})
