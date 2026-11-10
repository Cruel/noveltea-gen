import { sql, type Kysely } from 'kysely'
import type { StudioDb } from './studio-db'

/** One owner-scoped authorization projection for both physical database views.
 * Kysely compiles the same typed joins for SQLite and PostgreSQL. The controller
 * may SELECT the view but never receives these underlying application tables. */
export function trustedCatalogProjection(db: Kysely<StudioDb>) {
  return db.selectFrom('studioSessions as job')
    .innerJoin('stories as story', (join) => join
      .onRef('story.id', '=', 'job.storyId')
      .onRef('story.ownerUserId', '=', 'job.ownerUserId'))
    .innerJoin('repositories as repository', (join) => join
      .onRef('repository.id', '=', 'story.repositoryId')
      .onRef('repository.ownerUserId', '=', 'job.ownerUserId'))
    .select([
      'job.id as jobId',
      'job.ownerUserId as ownerId',
      'repository.provider as provider',
      'repository.providerRepositoryId as providerId',
      'story.directory as directory',
      'job.sourceCommitSha as pin',
      'job.generationConfigJson as configJson',
    ])
}

/** The hosted PostgreSQL view lives outside the application tables. Isolated
 * schema tests use a local view and must not mutate the production catalog. */
export async function trustedCatalogViewName(db: Kysely<unknown>, backend: 'sqlite' | 'postgres'): Promise<string> {
  if (backend === 'sqlite') return 'trusted_jobs'
  const result = await sql<{ name: string }>`SELECT current_schema() AS name`.execute(db)
  return result.rows[0]?.name === 'public' ? 'controller_catalog.trusted_jobs' : 'trusted_jobs'
}

export function trustedCatalogProjectionSql(db: Kysely<unknown> | Kysely<StudioDb>): string {
  const compiled = trustedCatalogProjection(db as Kysely<StudioDb>).compile()
  if (compiled.parameters.length) throw new Error('Trusted catalog view must not contain runtime parameters')
  return compiled.sql
}
