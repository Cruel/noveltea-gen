import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../../lib/runtime.server'
import { readAuthConfig } from '../../../../lib/auth'
import { generationConfigurationRequest } from '../../../../lib/generation-config.server'

export const Route = createFileRoute('/api/jobs/$jobId/configuration')({
  server: { handlers: {
    GET: ({ request, params }) =>
      generationConfigurationRequest(auth, database, request, params.jobId, readAuthConfig().baseURL),
    PUT: ({ request, params }) =>
      generationConfigurationRequest(auth, database, request, params.jobId, readAuthConfig().baseURL),
  } },
})
