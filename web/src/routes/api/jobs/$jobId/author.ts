import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../../lib/runtime.server'
import { readAuthConfig } from '../../../../lib/auth'
import { authorInteractionRequest } from '../../../../lib/author-interactions.server'

export const Route = createFileRoute('/api/jobs/$jobId/author')({
  server: { handlers: {
    GET: ({ request, params }) =>
      authorInteractionRequest(auth, database, request, params.jobId, readAuthConfig().baseURL),
    POST: ({ request, params }) =>
      authorInteractionRequest(auth, database, request, params.jobId, readAuthConfig().baseURL),
  } },
})
