import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../../lib/runtime.server'
import { githubPublicationRequest } from '../../../../lib/github-publication.server'
import { gitlabPublicationRequest } from '../../../../lib/gitlab-publication.server'
import { requireUser } from '../../../../lib/access.server'

async function publicationRequest(request: Request, jobId: string) {
  const user = await requireUser(auth, request.headers)
  if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 })
  const row = await database.persistence.approvalJobs.job(user.id, jobId)
  if (!row) return Response.json({ error: 'Job not found' }, { status: 404 })
  const base = new URL(process.env.BETTER_AUTH_URL!).origin
  if (row.provider === 'gitlab') return gitlabPublicationRequest(auth, database, request, jobId, base)
  if (row.provider === 'github') return githubPublicationRequest(auth, database, request, jobId, base)
  return Response.json({ error: 'Unknown Git provider' }, { status: 409 })
}

export const Route = createFileRoute('/api/jobs/$jobId/publish')({
  server: { handlers: {
    GET: ({ request, params }) => publicationRequest(request, params.jobId),
    POST: ({ request, params }) => publicationRequest(request, params.jobId),
  } },
})
