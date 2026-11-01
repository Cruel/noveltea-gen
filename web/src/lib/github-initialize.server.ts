import { createHash, randomUUID } from 'node:crypto'
import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { actorFor, errorResponse, GithubError, json, matchingRepository } from './github-repositories.server'
import { directoryPath, inspectGithubStoryInitialization } from './github-stories.server'
import { storyContentDirectory } from './story-discovery.shared'
import { candidate, validateNewStory, StoryBootstrapError } from './story-foundation.server'
import { acquireCachedStory, bootstrapEmptyGithubRepository,
  GitCacheError, initializeStoryBranch, initialStoryDocument } from './git-cache.server'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{40}$/i

/** A selected GitHub catalog repository, not an arbitrary browser URL/path. */
export async function githubInitializationRequest(
  auth: StudioAuth, store: StudioDatabase, request: Request, baseURL: string,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (request.method === 'POST' && request.headers.get('origin') !== baseURL) {
    return json({ error: 'Cross-origin write refused' }, 403)
  }
  try {
    const actor = await actorFor(auth, store, request.headers)
    if (actor instanceof Response) return actor
    const params = request.method === 'GET' ? new URL(request.url).searchParams : null
    const input = request.method === 'POST' ? await request.json().catch(() => null) : null
    const repositoryId = params?.get('repositoryId') ?? input?.repositoryId
    if (typeof repositoryId !== 'string' || !UUID.test(repositoryId)) {
      throw new GithubError(400, 'Select a connected GitHub repository.')
    }
    const directory = storyContentDirectory(directoryPath(params?.get('directory') ?? input?.directory ?? ''))
    // Initialization must not register a path the sandbox controller will later reject.
    if (directory.split('/').some(part => part.startsWith('.') || part.includes(',') ||
        part.includes('=') || /[*?\[\]!]/.test(part))) {
      throw new GithubError(400, 'Story initialization cannot write into internal metadata or author-only inbox directories.')
    }
    const row = store.sqlite.prepare(`SELECT provider_repository_id AS providerId, name
      FROM repositories WHERE id=? AND owner_user_id=? AND provider='github'`)
      .get(repositoryId, actor.id) as { providerId: string; name: string } | undefined
    if (!row) throw new GithubError(404, 'GitHub repository not connected.')
    const remote = await matchingRepository(actor.token, row.name)
    if (String(remote.id) !== row.providerId) {
      throw new GithubError(409, 'GitHub repository identity has changed. Reconnect before initializing.')
    }
    const inspected = await inspectGithubStoryInitialization(actor.token, row.name, directory)
    if (request.method === 'GET') return json(inspected)

    assertStudioSchemaCurrent(store)
    const title = input?.title
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 120 ||
        /[\x00-\x1f\x7f]/.test(title)) {
      throw new GithubError(400, 'Story title must be 1–120 printable characters.')
    }
    if (typeof input.jobId !== 'string' || !UUID.test(input.jobId)) {
      throw new GithubError(400, 'A new initialization job UUID is required.')
    }
    const foundation = input.foundation === undefined ? null : candidate(input.foundation)
    if (foundation) {
      if (foundation.title !== title.trim()) {
        throw new GithubError(400, 'Story title must match the reviewed Creative Direction title.')
      }
      await validateNewStory(foundation.file)
    }
    const content = foundation?.file ?? initialStoryDocument(title.trim())
    const contentSha256 = createHash('sha256').update(content).digest('hex')
    const expectedCommit = input.commit
    if (inspected.mode === 'branch'
      ? (typeof expectedCommit !== 'string' || !SHA.test(expectedCommit) ||
          expectedCommit.toLowerCase() !== inspected.commit.toLowerCase())
      : expectedCommit !== null) {
      throw new GithubError(409, 'GitHub revision has changed. Refresh before initializing the Story.')
    }

    // A Story may have multiple jobs, but initialization may run only once.
    // Replays must name the same persisted job; other jobs cannot overwrite
    // an already connected Story directory.
    const existingStory = store.sqlite.prepare(`SELECT id, initial_content_sha256 AS contentSha256 FROM stories
      WHERE repository_id=? AND owner_user_id=? AND directory=?`)
      .get(repositoryId, actor.id, directory) as { id: string; contentSha256: string | null } | undefined
    const existingJob = store.sqlite.prepare(`SELECT story_id AS storyId, owner_user_id AS ownerId,
      source_commit_sha AS commitSha FROM studio_sessions WHERE id=?`)
      .get(input.jobId) as { storyId: string; ownerId: string; commitSha: string | null } | undefined
    if (existingJob && (!existingStory || existingStory.id !== existingJob.storyId ||
        existingJob.ownerId !== actor.id || existingJob.commitSha !== inspected.commit)) {
      throw new GithubError(409, 'Initialization job ID is assigned to different saved work.')
    }
    if (existingStory && existingStory.contentSha256 && existingStory.contentSha256 !== contentSha256) {
      throw new GithubError(409, 'Initialization content differs from the saved Story draft. Inspect the original job.')
    }
    if (existingStory && !existingJob) {
      throw new GithubError(409, 'This Story directory is already connected. Open its existing Story instead.')
    }

    const cacheDirectory = process.env.NT_GIT_CACHE_DIR
    if (!cacheDirectory) {
      throw new GithubError(503, 'Studio Git cache is not configured. Set NT_GIT_CACHE_DIR to an absolute cache volume.')
    }
    const common = {
      cacheDirectory, ownerId: actor.id, repositoryId: 'github:' + row.providerId,
      remoteUrl: `https://github.com/${row.name}.git`, token: actor.token,
      directory, title: title.trim(),
    }
    let baseSha: string
    let headSha: string
    let branch: string | null = null
    if (inspected.mode === 'bootstrap') {
      const created = await bootstrapEmptyGithubRepository({
        ...common, defaultBranch: inspected.defaultBranch, foundationMarkdown: content,
      })
      baseSha = created.commit
      const result = await acquireCachedStory({
        ...common, commit: baseSha, jobId: input.jobId,
        verifiedSizeBytes: Buffer.byteLength(content),
        verifiedBlobCount: 1,
      })
      headSha = result.headSha
      branch = result.branch
    } else {
      const created = await initializeStoryBranch({
        ...common, commit: inspected.commit, jobId: input.jobId, foundationMarkdown: content,
        verifiedSizeBytes: inspected.sizeBytes, verifiedBlobCount: inspected.blobCount,
      })
      baseSha = inspected.commit
      headSha = created.headSha
      branch = created.branch
    }

    const storyId = existingStory?.id ?? randomUUID()
    const now = new Date().toISOString()
    store.sqlite.transaction(() => {
      if (!existingStory) {
        store.sqlite.prepare(`INSERT INTO stories
          (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha,initial_content_sha256)
          VALUES (?,?,?,?,?,?,?,?)`)
          .run(storyId, actor.id, repositoryId, directory, common.title, now, baseSha, contentSha256)
      }
      store.sqlite.prepare(`INSERT INTO studio_sessions
        (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at)
        VALUES (?,?,?,?,?,'paused',?,?)
        ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at
        WHERE studio_sessions.owner_user_id=excluded.owner_user_id AND
          studio_sessions.story_id=excluded.story_id AND
          studio_sessions.source_commit_sha=excluded.source_commit_sha`)
        .run(input.jobId, actor.id, storyId, common.title, baseSha, now, now)
    })()
    return json({ story: { id: storyId, title: common.title, directory, commit: baseSha },
      job: { id: input.jobId, baseSha, headSha, branch, status: 'paused' },
      mode: inspected.mode, published: inspected.mode === 'bootstrap' })
  } catch (error) {
    return errorResponse(error instanceof GitCacheError || error instanceof StoryBootstrapError
      ? new GithubError(error.status, error.message) : error)
  }
}
