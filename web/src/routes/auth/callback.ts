import { createFileRoute } from '@tanstack/react-router'
import { chatGPTCallbackRequest } from '../../lib/pi-models.server'

export const Route = createFileRoute('/auth/callback')({
  server: { handlers: {
    GET: ({ request }) => chatGPTCallbackRequest(request),
  } },
})
