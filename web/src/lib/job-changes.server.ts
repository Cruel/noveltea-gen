import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'
import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './access.server'
import { authorizedStoryJob } from './fixture-jobs.server'
import { committedStoryFiles } from './generation-progress.server'
import { trustedHead } from '../../../src/revision'

/** Git diff lives on a separate authenticated read-only surface from progress.
 * Only verified commits and Story Markdown, never dirty working-tree drafts. */
export async function jobChangesRequest(auth: StudioAuth, store: StudioDatabase,
  request: Request, id: string): Promise<Response> {
  try {
    if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405 })
    assertStudioSchemaCurrent(store)
    const user = await requireUser(auth, request.headers)
    if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 })
    const job = await authorizedStoryJob(store, user.id, id)
    const head = await trustedHead(job)
    const files = committedStoryFiles(job, job.baseSha, head)
    const requested = new URL(request.url).searchParams.get('file')
    if (requested !== null && !files.includes(requested))
      return Response.json({ error: 'File is not in the verified Story change set' }, { status: 404 })
    if (requested !== null) {
      const story = relative(job.worktreeRoot, job.worktreeStoryRoot)
      const env = { ...process.env }
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[key]
      const diff = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-color',
        '--unified=3', job.baseSha, head, '--', ':(literal)' + join(story, requested)],
      { cwd: job.worktreeRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 256 * 1024 })
      return Response.json({ headSha: head, file: requested, diff }, {
        headers: { 'Cache-Control': 'private, no-store' },
      })
    }
    return Response.json({ headSha: head, files }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    const status = error instanceof Error && 'status' in error &&
      typeof error.status === 'number' ? error.status : 409
    return Response.json({ error: 'Verified Git changes are unavailable. Inspect the saved Story job.' },
      { status, headers: { 'Cache-Control': 'no-store' } })
  }
}
