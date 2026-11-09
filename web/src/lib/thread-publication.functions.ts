import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { requireUser } from './access.server'
import { readAuthConfig } from './auth'
import { readThreadChat } from './thread-chat.server'
import { resolveThreadPublication, type ThreadPublicationChoice } from './thread-publication.server'
import { githubPublicationRequest } from './github-publication.server'
import type { PublicationPreview } from './publication-review.server'
import { gitlabPublicationRequest } from './gitlab-publication.server'

const ID = /^[a-zA-Z0-9:_-]{1,128}$/
const SHA = /^[a-f0-9]{40}$/i

function validChoice(input: ThreadPublicationChoice) {
  if (!input || !ID.test(input.threadId) ||
      !['create', 'update'].includes(input.action) ||
      input.action === 'update' && (!input.linkJobId || !ID.test(input.linkJobId)) ||
      input.action === 'create' && input.linkJobId !== undefined)
    throw new Error('Invalid Thread publication selection.')
  return input
}
async function owner() {
  await database.assertReady()
  const user = await requireUser(auth, getRequestHeaders())
  if (!user) throw new Error('Sign in required.')
  return user.id
}

/** Discover linked drafts without touching Git or reaching an upstream. */
export const getThreadPublicationOptions = createServerFn({ method: 'GET' })
  .validator((threadId: string) => {
    if (!ID.test(threadId)) throw new Error('Invalid Thread ID.')
    return threadId
  })
  .handler(async ({ data }) => {
    const user = await owner()
    const chat = await readThreadChat(database, user, data)
    const publications = []
    for (const run of chat.runs) {
      const row = await database.persistence.approvalJobs.job(user, run.jobId)
      if (!row) throw new Error('Thread provider ownership changed.')
      const publication = await database.persistence.publications.get(user, run.jobId, row.provider)
      if (publication?.phase === 'linked') publications.push({
        jobId: run.jobId, provider: row.provider, ...publication,
      })
    }
    return { publications, canSelect: !chat.archived }
  })

async function execute(choice: ThreadPublicationChoice,
  expected?: { headSha: string; targetSha: string; allowPartial: boolean; confirmed: boolean }):
  Promise<Omit<PublicationPreview, 'diagnostics'> & { diagnostics: string[] }> {
  const user = await owner()
  const selected = await resolveThreadPublication(database, user, choice)
  if (expected) {
    if (!expected.confirmed)
      throw new Error('Explicit author publication confirmation is required.')
    if (selected.headSha !== expected.headSha)
      throw new Error('Thread HEAD changed; refresh the publication preview.')
    if (choice.action === 'create' && selected.publications.some(item =>
      item.jobId === selected.job.jobId && item.receipt.phase === 'linked' &&
      item.receipt.headSha !== selected.headSha))
      throw new Error('This Turn already owns a draft. Advance the Thread before creating another.')
  }
  const headers = new Headers(getRequestHeaders())
  headers.set('origin', readAuthConfig().baseURL)
  const request = new Request(readAuthConfig().baseURL + '/api/jobs/' +
    encodeURIComponent(selected.job.jobId) + '/publish', {
    method: expected ? 'POST' : 'GET', headers,
    ...(expected ? { body: JSON.stringify({
      headSha: expected.headSha, targetSha: expected.targetSha,
      allowPartial: expected.allowPartial,
    }) } : {}),
  })
  const response = selected.provider === 'github'
    ? await githubPublicationRequest(auth, database, request, selected.job.jobId,
      readAuthConfig().baseURL, choice)
    : await gitlabPublicationRequest(auth, database, request, selected.job.jobId,
      readAuthConfig().baseURL, choice)
  const result = await response.json() as { publication?: PublicationPreview; error?: string }
  if (!response.ok || !result.publication)
    throw new Error(result.error ?? 'Thread publication failed.')
  return { ...result.publication,
    diagnostics: result.publication.diagnostics.map(item => JSON.stringify(item)),
  }
}

export const getThreadPublicationPreview = createServerFn({ method: 'GET' })
  .validator(validChoice)
  .handler(async ({ data }) => execute(data))

export const postThreadPublication = createServerFn({ method: 'POST' })
  .validator((input: ThreadPublicationChoice & {
    headSha: string; targetSha: string; allowPartial: boolean; confirmed: boolean
  }) => {
    validChoice(input)
    if (!SHA.test(input.headSha) || !SHA.test(input.targetSha) ||
        typeof input.allowPartial !== 'boolean' || input.confirmed !== true)
      throw new Error('Exact preview HEADs and author confirmation are required.')
    return input
  })
  .handler(async ({ data }) => execute(data, data))
