import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../../lib/runtime.server'
import { generationEventsRequest } from '../../../../lib/generation-progress.server'

export const Route = createFileRoute('/api/jobs/$jobId/events')({
  server: { handlers: {
    GET: ({ request, params }) => generationEventsRequest(auth, database, request, params.jobId),
  } },
})
