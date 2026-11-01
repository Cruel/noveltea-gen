import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../../lib/runtime.server'
import { storyRelationshipsRequest } from '../../../../lib/story-explorer.server'

export const Route = createFileRoute('/api/jobs/$jobId/relationships')({
  server: { handlers: {
    GET: ({ request, params }) => storyRelationshipsRequest(auth, database, request, params.jobId),
  } },
})
