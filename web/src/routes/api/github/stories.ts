import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../lib/runtime.server'
import { githubStoryRequest } from '../../../lib/github-stories.server'
import { readGithubAppOptions } from '../../../lib/github-repositories.server'

export const Route = createFileRoute('/api/github/stories')({
  server: { handlers: {
    GET: ({ request }) => githubStoryRequest(auth, database, request, readGithubAppOptions().baseURL),
    POST: ({ request }) => githubStoryRequest(auth, database, request, readGithubAppOptions().baseURL),
  } },
})
