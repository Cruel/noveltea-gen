import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { actorFor, errorResponse, GithubError, json, matchingRepository } from './github-repositories.server'
import { verifyGithubStorySelection } from './github-stories.server'
import { acquireCachedStory, GitCacheError } from './git-cache.server'

// Creating/reopening a job is an authenticated controller action, not a Pi tool.
// The caller identifies a catalog Story, idempotent job UUID and expected
// pinned revision (an equality check, not authority to select another SHA).
// Git URLs, filesystem paths and owner identities remain server-owned.
export async function githubJobRequest(
  auth: StudioAuth, store: StudioDatabase, request: Request, baseURL: string,
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (request.headers.get('origin') !== baseURL) return json({ error: 'Cross-origin write refused' }, 403)
  try {
    const actor = await actorFor(auth, store, request.headers)
    if (actor instanceof Response) return actor
    assertStudioSchemaCurrent(store)
    const input = await request.json().catch(() => null)
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
    if (typeof input?.storyId !== 'string' || !uuid.test(input.storyId) ||
        typeof input?.jobId !== 'string' || !uuid.test(input.jobId) ||
        typeof input?.commit !== 'string' || !/^[a-f0-9]{40}$/i.test(input.commit)) {
      throw new GithubError(400, 'Select a Story, job UUID and pinned commit.')
    }
    const row = store.sqlite.prepare(`SELECT s.id, s.directory, s.title,
      s.source_commit_sha AS commitSha, r.name AS repository, r.provider_repository_id AS providerId
      FROM stories s JOIN repositories r ON s.repository_id=r.id AND s.owner_user_id=r.owner_user_id
      WHERE s.id=? AND s.owner_user_id=? AND r.provider='github'`)
      .get(input.storyId, actor.id) as {
        id: string; directory: string; title: string; commitSha: string | null;
        repository: string; providerId: string
      } | undefined
    if (!row) throw new GithubError(404, 'GitHub Story is not connected to this account.')
    if (!row.commitSha) throw new GithubError(409, 'Story has no verified base commit; reselect it before creating a job.')
    const existing = store.sqlite.prepare(`SELECT story_id AS storyId, owner_user_id AS ownerId,
      source_commit_sha AS commitSha FROM studio_sessions WHERE id=?`)
      .get(input.jobId) as { storyId: string; ownerId: string; commitSha: string | null } | undefined
    if (existing && (existing.storyId !== row.id || existing.ownerId !== actor.id)) {
      throw new GithubError(409, 'Job ID is already assigned to another Story.')
    }
    if (existing && !existing.commitSha) {
      throw new GithubError(409, 'Saved job has no pinned commit and cannot be safely reopened.')
    }
    const pinned = existing?.commitSha ?? row.commitSha
    if (pinned.toLowerCase() !== input.commit.toLowerCase()) {
      throw new GithubError(409, 'Selected Story revision changed. Refresh the selection or reopen the job at its saved commit.')
    }
    const repo = await matchingRepository(actor.token, row.repository)
    if (String(repo.id) !== row.providerId) {
      throw new GithubError(409, 'GitHub repository identity has changed; reconnect it before creating a job.')
    }
    // Reverify both the content cap and the exact persisted SHA. The UI cannot
    // replace this commit with a branch name or latest default-branch HEAD.
    const preflight = await verifyGithubStorySelection(actor.token, row.repository, pinned, row.directory)
    const cacheDirectory = process.env.NT_GIT_CACHE_DIR
    if (!cacheDirectory) throw new GithubError(503, 'Studio Git cache is not configured. Set NT_GIT_CACHE_DIR to a dedicated absolute cache volume.')
    const result = await acquireCachedStory({
      cacheDirectory, ownerId: actor.id, repositoryId: 'github:' + row.providerId,
      remoteUrl: `https://github.com/${row.repository}.git`, token: actor.token,
      directory: row.directory, commit: pinned, jobId: input.jobId,
      verifiedSizeBytes: preflight.sizeBytes, verifiedBlobCount: preflight.blobCount,
    })
    const now = new Date().toISOString()
    store.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at)
      VALUES (?,?,?,?,?,'paused',?,?)
      ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at
      WHERE studio_sessions.owner_user_id=excluded.owner_user_id AND
        studio_sessions.story_id=excluded.story_id AND
        studio_sessions.source_commit_sha=excluded.source_commit_sha`)
      .run(input.jobId, actor.id, row.id, row.title, pinned, now, now)
    return json({ job: { id: input.jobId, storyId: row.id, status: 'paused',
      baseSha: result.baseSha, headSha: result.headSha } })
  } catch (error) {
    return errorResponse(error instanceof GitCacheError ? new GithubError(error.status, error.message) : error)
  }
}
