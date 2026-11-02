import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../lib/runtime.server'
import { readAuthConfig } from '../../../lib/auth'
import { generationJobRequest } from '../../../lib/fixture-jobs.server'

export const Route = createFileRoute('/api/jobs/$jobId')({
  server: { handlers: {
    GET: ({ request, params }) => generationJobRequest(auth, database, request, params.jobId, readAuthConfig().baseURL),
    POST: ({ request, params }) => generationJobRequest(auth, database, request, params.jobId, readAuthConfig().baseURL),
  } },
})
