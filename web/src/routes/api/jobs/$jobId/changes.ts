import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../../lib/runtime.server'
import { jobChangesRequest } from '../../../../lib/job-changes.server'

export const Route = createFileRoute('/api/jobs/$jobId/changes')({
  server: { handlers: {
    GET: ({ request, params }) => jobChangesRequest(auth, database, request, params.jobId),
  } },
})
