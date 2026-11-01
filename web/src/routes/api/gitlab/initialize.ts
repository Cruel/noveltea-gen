import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../lib/runtime.server'
import { readAuthConfig } from '../../../lib/auth'
import { gitlabInitializeRequest } from '../../../lib/gitlab-initialize.server'

export const Route = createFileRoute('/api/gitlab/initialize')({
  server: { handlers: {
    GET: ({ request }) => gitlabInitializeRequest(auth, database, request, readAuthConfig().baseURL),
    POST: ({ request }) => gitlabInitializeRequest(auth, database, request, readAuthConfig().baseURL),
  } },
})
