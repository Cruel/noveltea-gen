import { createFileRoute } from '@tanstack/react-router'
import { piOAuthCallbackRequest } from '../../lib/pi-models.server'
import { database } from '../../lib/runtime.server'

export const Route = createFileRoute('/oauth/callback')({
  server: { handlers: {
    GET: ({ request }) => piOAuthCallbackRequest(request, database),
  } },
})
