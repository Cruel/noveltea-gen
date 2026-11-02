import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../../lib/runtime.server'
import { githubPublicationRequest } from '../../../../lib/github-publication.server'
import { gitlabPublicationRequest } from '../../../../lib/gitlab-publication.server'
import { requireUser } from '../../../../lib/access.server'

async function publicationRequest(request: Request, jobId: string) {
  const user = await requireUser(auth, request.headers)
  if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 })
  const row = database.sqlite.prepare(`SELECT r.provider FROM studio_sessions j
    JOIN stories s ON j.story_id=s.id AND j.owner_user_id=s.owner_user_id
    JOIN repositories r ON s.repository_id=r.id AND s.owner_user_id=r.owner_user_id
    WHERE j.id=? AND j.owner_user_id=?`).get(jobId, user.id) as { provider: string } | undefined
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
