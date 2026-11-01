import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../lib/runtime.server'
import { readAuthConfig } from '../../../lib/auth'
import { gitlabJobRequest } from '../../../lib/gitlab-jobs.server'

export const Route = createFileRoute('/api/gitlab/jobs')({
  server: { handlers: {
    POST: ({ request }) => gitlabJobRequest(auth, database, request, readAuthConfig().baseURL),
  } },
})
