import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../../lib/runtime.server'
import { storyExplorerRequest } from '../../../../lib/story-explorer.server'

export const Route = createFileRoute('/api/jobs/$jobId/records')({
  server: { handlers: {
    GET: ({ request, params }) => storyExplorerRequest(auth, database, request, params.jobId),
  } },
})
