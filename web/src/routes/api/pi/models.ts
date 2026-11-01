import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../lib/runtime.server'
import { readAuthConfig } from '../../../lib/auth'
import { piModelsRequest } from '../../../lib/pi-models.server'

export const Route = createFileRoute('/api/pi/models')({
  server: { handlers: {
    GET: ({ request }) => piModelsRequest(auth, database, request, readAuthConfig().baseURL),
    POST: ({ request }) => piModelsRequest(auth, database, request, readAuthConfig().baseURL),
    DELETE: ({ request }) => piModelsRequest(auth, database, request, readAuthConfig().baseURL),
  } },
})
