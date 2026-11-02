import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../../lib/runtime.server'
import { githubPublicationRequest } from '../../../../lib/github-publication.server'

export const Route = createFileRoute('/api/jobs/$jobId/publish')({
  server: { handlers: {
    GET: ({ request, params }) => githubPublicationRequest(auth, database, request, params.jobId, new URL(process.env.BETTER_AUTH_URL!).origin),
    POST: ({ request, params }) => githubPublicationRequest(auth, database, request, params.jobId, new URL(process.env.BETTER_AUTH_URL!).origin),
  } },
})
