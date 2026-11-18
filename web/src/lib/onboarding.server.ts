import type { StudioAuth } from './auth'
import type { StudioStore as StudioDatabase } from '../persistence/store'
import { StudioSchemaError } from '../db/schema-error'
import { requireUser } from './access.server'
import { storyContentDirectory } from './story-discovery.shared'
import { parseGenerationContract } from '../../../src/generation'
import { authorizedStoryJob } from './fixture-jobs.server'

export const questionRounds = [
  ['id', 'title', 'premise', 'central_conflict'],
  ['genre', 'tone', 'player_experience', 'scope'],
  ['decision', 'body', 'task', 'constraints'],
] as const

export type OnboardingDraft = {
  id: string; title: string; premise: string; central_conflict: string
  genre: string; tone: string; player_experience: string; scope: string
  decision: string; body: string; task: string; constraints: string
}
export const blankOnboardingDraft = (): OnboardingDraft => ({
  id: 'foundation', title: '', premise: '', central_conflict: '', genre: '',
  tone: '', player_experience: '', scope: '', decision: '', body: '', task: '', constraints: '',
})
const FIELDS = Object.keys(blankOnboardingDraft()) as Array<keyof OnboardingDraft>
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const slug = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
class OnboardingError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const response = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })

export function onboardingWorkspace(input: unknown): string {
  if (typeof input !== 'string' || input.length > 240 || input.includes('\\') ||
      input.startsWith('/') || input.endsWith('/') || input.split('/').some(segment =>
        segment === '.' || segment === '..' || segment.startsWith('.') ||
        segment.includes(',') || segment.includes('=') || /[\x00-\x1f\x7f*?\[\]!]/.test(segment))) {
    throw new OnboardingError(400, 'Choose a safe workspace directory (blank means repository root).')
  }
  const normalized = input === 'story' || input.endsWith('/story')
    ? input.slice(0, -5).replace(/\/$/, '') : input
  if (normalized.split('/').some(segment => !segment && normalized !== '')) {
    throw new OnboardingError(400, 'Invalid workspace path.')
  }
  return normalized
}
export function validateOnboardingDraft(value: unknown): OnboardingDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== FIELDS.length ||
      Object.keys(value).some(key => !FIELDS.includes(key as keyof OnboardingDraft))) {
    throw new OnboardingError(422, 'Use only the supported discovery answers.')
  }
  const values = value as Record<string, unknown>
  const result = blankOnboardingDraft()
  for (const field of FIELDS) {
    const text = values[field]
    if (typeof text !== 'string' || text.length > (field === 'body' ? 12_000 : field === 'title' ? 120 : 4000) ||
        /[\x00\x7f]/.test(text)) {
      throw new OnboardingError(422, 'Discovery answers must be valid bounded text.')
    }
    result[field] = text
  }
  if (!slug.test(result.id) || result.id.length > 100) {
    throw new OnboardingError(422, 'Creative Direction ID must be a lowercase slug.')
  }
  return result
}

/** The proposal is explicitly author supplied, not a pretend Pi completion.
 * The actual native serializer/validator runs at the provider commit boundary. */
export function reviewedOnboarding(draft: OnboardingDraft) {
  const required = [...questionRounds.flat()].filter(field => field !== 'constraints')
  if (required.some(field => !draft[field].trim()))
    throw new OnboardingError(422, 'Answer all discovery questions before approving the initial Story.')
  const limitedConstraints = draft.constraints.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (limitedConstraints.some(s => s.length > 1000) || limitedConstraints.length > 128)
    throw new OnboardingError(422, 'Generation constraints are too long or too numerous.')
  const contract = parseGenerationContract({
    scope: { kind: 'full-story', depth: 'composition', targets: [], branches: [] },
    constraints: limitedConstraints,
    envelope: { presentation: 'Visual novel',
      hardLimits: [], preferences: [] },
  })
  const { task, constraints, ...foundation } = draft
  return { foundation, task: task.trim(), contract }
}

export async function onboardingRequest(auth: StudioAuth, store: StudioDatabase,
  request: Request, baseURL: string): Promise<Response> {
  if (!['GET', 'PUT', 'POST'].includes(request.method)) return response({ error: 'Method not allowed.' }, 405)
  if (request.method !== 'GET' && request.headers.get('origin') !== baseURL)
    return response({ error: 'Cross-origin write refused.' }, 403)
  try {
    await store.assertReady()
    const user = await requireUser(auth, request.headers)
    if (!user) throw new OnboardingError(401, 'Sign in required.')
    const params = new URL(request.url).searchParams
    if ([...params.keys()].some(key => !['repositoryId', 'workspace'].includes(key)) ||
        params.getAll('repositoryId').length !== 1 || params.getAll('workspace').length > 1)
      throw new OnboardingError(400, 'Select one connected repository and workspace.')
    const repositoryId = params.get('repositoryId')
    const workspace = onboardingWorkspace(params.get('workspace') ?? '')
    if (!repositoryId || !uuid.test(repositoryId)) throw new OnboardingError(400, 'Invalid repository.')
    const owner = await store.persistence.repositories.get(user.id, repositoryId)
    if (!owner) throw new OnboardingError(404, 'Repository is not connected to this account.')
    const saved = await store.persistence.onboarding.draft(user.id, repositoryId, workspace)
    if (request.method === 'GET') {
      const target = storyContentDirectory(workspace)
      const initial = owner.provider === 'github'
        ? await store.persistence.onboarding.githubInitialization(user.id, repositoryId, target)
        : null
      let initialized: { kind: 'recoverable'; created: {
        jobId: string; headSha: string; branch: string; commit: string; baseSha: string;
        story: { id: string; directory: string; title: string }; mode: string
      }; configured: boolean } | { kind: 'unavailable'; storyId: string } | undefined
      if (initial) {
        try {
          const job = await authorizedStoryJob(store, user.id, initial.jobId)
          if (job.jobId !== initial.jobId || job.baseSha !== initial.baseSha ||
              job.storyRelativePath !== target) throw new Error('Saved Story job identity changed')
          initialized = { kind: 'recoverable', configured: initial.configured, created: {
            jobId: job.jobId, headSha: job.headSha, branch: job.branch,
            commit: job.headSha, baseSha: job.baseSha,
            story: { id: initial.storyId, directory: target, title: initial.title },
            mode: job.headSha === job.baseSha ? 'bootstrap' : 'branch',
          } }
        } catch {
          initialized = { kind: 'unavailable', storyId: initial.storyId }
        }
      }
      return response({ repositoryId, provider: owner.provider, workspace, target,
        revision: saved?.revision ?? 0,
        draft: saved ? validateOnboardingDraft(JSON.parse(saved.draftJson)) : blankOnboardingDraft(),
        ...(initialized ? { initialized } : {}) })
    }
    const reader = request.body?.getReader()
    if (!reader) throw new OnboardingError(400, 'Missing discovery draft.')
    let bytes = 0
    const chunks: Uint8Array[] = []
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > 64 * 1024) throw new OnboardingError(413, 'Discovery draft exceeds request limit.')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    let body: { revision?: unknown; draft?: unknown }
    try { body = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { throw new OnboardingError(400, 'Discovery draft must be UTF-8 JSON.') }
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => key !== 'revision' && (request.method !== 'PUT' || key !== 'draft')) ||
        !Number.isSafeInteger(body.revision) || body.revision !== (saved?.revision ?? 0)) {
      throw new OnboardingError(409, 'Discovery draft was modified elsewhere. Refresh to review the saved answers.')
    }
    if (request.method === 'POST') {
      if (!saved) throw new OnboardingError(409, 'Save discovery answers before reviewing the initial Story.')
      const proposal = reviewedOnboarding(validateOnboardingDraft(JSON.parse(saved.draftJson)))
      return response({ revision: saved.revision, workspace, target: storyContentDirectory(workspace),
        ...proposal })
    }
    const draft = validateOnboardingDraft(body.draft)
    const revision = (saved?.revision ?? 0) + 1
    const updated = await store.persistence.onboarding.saveDraft(
      user.id, repositoryId, workspace, saved?.revision ?? 0,
      JSON.stringify(draft), new Date().toISOString())
    if (!updated) throw new OnboardingError(409, 'Discovery changed concurrently; refresh.')
    return response({ revision, draft, workspace, target: storyContentDirectory(workspace) })
  } catch (error) {
    if (error instanceof OnboardingError) return response({ error: error.message }, error.status)
    if (error instanceof StudioSchemaError) return response({ error: error.message }, 503)
    console.error('[Story onboarding] Cannot save author discovery', error instanceof Error ? error.stack : String(error))
    return response({ error: 'Discovery state could not be verified or saved.' }, 409)
  }
}
