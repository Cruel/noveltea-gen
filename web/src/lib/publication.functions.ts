import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { requireUser } from './session.server'
import { readAuthConfig } from './auth'
import { githubPublicationRequest } from './github-publication.server'
import { gitlabPublicationRequest } from './gitlab-publication.server'

function request(jobId: string, serialized?: string) {
  const headers = new Headers(getRequestHeaders())
  if (serialized !== undefined) headers.set('content-type', 'application/json')
  return new Request(readAuthConfig().baseURL + '/api/jobs/' + encodeURIComponent(jobId) + '/publish', {
    method: serialized === undefined ? 'GET' : 'POST', headers,
    ...(serialized !== undefined ? { body: serialized } : {}),
  })
}
async function execute(jobId: string, serialized?: string) {
  const headers = getRequestHeaders()
  const user = await requireUser(auth, headers)
  if (!user) throw new Error('Sign in required.')
  const row = database.sqlite.prepare(`SELECT r.provider FROM studio_sessions j
    JOIN stories s ON j.story_id=s.id AND j.owner_user_id=s.owner_user_id
    JOIN repositories r ON s.repository_id=r.id AND s.owner_user_id=r.owner_user_id
    WHERE j.id=? AND j.owner_user_id=?`).get(jobId, user.id) as { provider: string } | undefined
  if (!row) throw new Error('Job not found.')
  const req = request(jobId, serialized)
  const base = readAuthConfig().baseURL
  const response = row.provider === 'gitlab'
    ? await gitlabPublicationRequest(auth, database, req, jobId, base)
    : row.provider === 'github'
      ? await githubPublicationRequest(auth, database, req, jobId, base)
      : Response.json({ error: 'Unsupported Git provider.' }, { status: 409 })
  const text = await response.text()
  if (!response.ok) {
    let message: string | undefined
    try { message = (JSON.parse(text) as { error?: string }).error } catch { /* no details */ }
    throw new Error(message || 'Publication request failed.')
  }
  return text
}
export const previewPublication = createServerFn({ method: 'GET' })
  .validator((jobId: string) => jobId)
  .handler(async ({ data }) => execute(data))

export const submitPublication = createServerFn({ method: 'POST' })
  .validator((data: { jobId: string; approvalJson: string }) => data)
  .handler(async ({ data }) => execute(data.jobId, data.approvalJson))
