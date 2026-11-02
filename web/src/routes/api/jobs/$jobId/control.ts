import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../../lib/runtime.server'
import { readAuthConfig } from '../../../../lib/auth'
import { generationControlRequest } from '../../../../lib/generation-controls.server'

export const Route = createFileRoute('/api/jobs/$jobId/control')({
  server: { handlers: {
    GET: ({ request, params }) => generationControlRequest(
      auth, database, request, params.jobId, readAuthConfig().baseURL),
    POST: ({ request, params }) => generationControlRequest(
      auth, database, request, params.jobId, readAuthConfig().baseURL),
  } },
})
