import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../../lib/runtime.server'
import { readAuthConfig } from '../../../../lib/auth'
import { foundationReviewRequest } from '../../../../lib/foundation-review.server'

export const Route = createFileRoute('/api/jobs/$jobId/foundation-review')({
  server: { handlers: {
    GET: ({ request, params }) =>
      foundationReviewRequest(auth, database, request, params.jobId, readAuthConfig().baseURL),
    POST: ({ request, params }) =>
      foundationReviewRequest(auth, database, request, params.jobId, readAuthConfig().baseURL),
  } },
})
