import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../lib/runtime.server'
import { gitlabRepositoryRequest } from '../../../lib/gitlab-repositories.server'

export const Route = createFileRoute('/api/gitlab/repositories')({
  server: { handlers: {
    GET: ({ request }) => gitlabRepositoryRequest(auth, database, request),
    POST: ({ request }) => gitlabRepositoryRequest(auth, database, request),
  } },
})
