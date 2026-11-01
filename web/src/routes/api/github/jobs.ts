import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../lib/runtime.server'
import { githubJobRequest } from '../../../lib/github-jobs.server'
import { readGithubAppOptions } from '../../../lib/github-repositories.server'

export const Route = createFileRoute('/api/github/jobs')({
  server: { handlers: {
    POST: ({ request }) => githubJobRequest(auth, database, request, readGithubAppOptions().baseURL),
  } },
})
