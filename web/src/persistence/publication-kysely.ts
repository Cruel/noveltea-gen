import type { QueryExecutor, SharedDatabase } from '../db/kysely-connection'
import type { StudioDb } from '../db/studio-db'
import type { CatalogProvider } from './contracts'
import { PublicationStateConflict } from './publication-contracts'
import type { PublicationJob, PublicationReceipt, PublicationRecords } from './publication-contracts'
import { reconcilePublication } from './publication-reconcile'

type Read = QueryExecutor<StudioDb>

function required(owner: string): void {
  if (!owner) throw new Error('Authenticated owner required.')
}

async function ownedJob(
  db: Read,
  owner: string,
  jobId: string,
  provider: CatalogProvider,
): Promise<PublicationJob | null> {
  const row = await db
    .selectFrom('studioSessions')
    .innerJoin('stories', (join) =>
      join
        .onRef('studioSessions.storyId', '=', 'stories.id')
        .onRef('studioSessions.ownerUserId', '=', 'stories.ownerUserId'),
    )
    .innerJoin('repositories', (join) =>
      join
        .onRef('stories.repositoryId', '=', 'repositories.id')
        .onRef('stories.ownerUserId', '=', 'repositories.ownerUserId'),
    )
    .select([
      'studioSessions.id as id',
      'studioSessions.title as title',
      'repositories.name as repository',
      'repositories.id as repositoryId',
      'repositories.providerRepositoryId as providerId',
      'studioSessions.sourceCommitSha as baseSha',
      'stories.directory as directory',
      'stories.initialContentSha256 as initialContentSha256',
    ])
    .where('studioSessions.id', '=', jobId)
    .where('studioSessions.ownerUserId', '=', owner)
    .where('repositories.provider', '=', provider)
    .executeTakeFirst()
  return row ?? null
}

async function receipt(
  db: Read,
  owner: string,
  jobId: string,
  provider: CatalogProvider,
): Promise<PublicationReceipt | null> {
  // The only provider-specific difference is the physical identity column.
  const row =
    provider === 'github'
      ? await db
          .selectFrom('githubPublications')
          .select(['targetBranch', 'remoteBranch', 'headSha', 'phase', 'prNumber as number', 'prUrl as url'])
          .where('ownerUserId', '=', owner)
          .where('jobId', '=', jobId)
          .executeTakeFirst()
      : await db
          .selectFrom('gitlabPublications')
          .select(['targetBranch', 'remoteBranch', 'headSha', 'phase', 'mrIid as number', 'mrUrl as url'])
          .where('ownerUserId', '=', owner)
          .where('jobId', '=', jobId)
          .executeTakeFirst()
  if (!row) return null
  if (row.phase !== 'pending' && row.phase !== 'linked')
    throw new PublicationStateConflict('Unknown persisted publication phase.')
  return { ...row, phase: row.phase }
}

/** Single publication domain implementation for both SQL engines. */
export function createKyselyPublicationRecords(db: SharedDatabase<StudioDb>): PublicationRecords {
  return {
    async job(owner, jobId, provider) {
      required(owner)
      return ownedJob(db.read, owner, jobId, provider)
    },
    async get(owner, jobId, provider) {
      required(owner)
      return receipt(db.read, owner, jobId, provider)
    },
    async save(owner, jobId, provider, next, updatedAt) {
      required(owner)
      await db.withWriteTransaction([{ kind: 'job', id: jobId }], async (tx) => {
        // Both checks use the SAME transaction, not the independent read pool.
        if (!(await ownedJob(tx, owner, jobId, provider)))
          throw new PublicationStateConflict('Publication job is not owned by this provider account.')
        const effective = reconcilePublication(await receipt(tx, owner, jobId, provider), next)
        const common = {
          jobId,
          ownerUserId: owner,
          targetBranch: effective.targetBranch,
          remoteBranch: effective.remoteBranch,
          headSha: effective.headSha,
          phase: effective.phase,
          updatedAt,
        }
        const update = { headSha: effective.headSha, phase: effective.phase, updatedAt }
        if (provider === 'github') {
          await tx
            .insertInto('githubPublications')
            .values({ ...common, prNumber: effective.number, prUrl: effective.url })
            .onConflict((oc) =>
              oc
                .column('jobId')
                .doUpdateSet({
                  ...update,
                  prNumber: effective.number,
                  prUrl: effective.url,
                })
                .where('githubPublications.ownerUserId', '=', owner),
            )
            .execute()
        } else {
          await tx
            .insertInto('gitlabPublications')
            .values({ ...common, mrIid: effective.number, mrUrl: effective.url })
            .onConflict((oc) =>
              oc
                .column('jobId')
                .doUpdateSet({
                  ...update,
                  mrIid: effective.number,
                  mrUrl: effective.url,
                })
                .where('gitlabPublications.ownerUserId', '=', owner),
            )
            .execute()
        }
      })
    },
  }
}
