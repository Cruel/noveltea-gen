import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { githubPublications, gitlabPublications, repositories, sessions, stories } from '../db/schema'
import type { CatalogProvider } from './contracts'
import { PublicationStateConflict } from './publication-contracts'
import { reconcilePublication } from './publication-reconcile'
import type { PublicationJob, PublicationReceipt, PublicationRecords } from './publication-contracts'

type Db = BetterSQLite3Database<typeof schema>
function ownerRequired(owner: string): void {
  if (!owner) throw new Error('Authenticated owner required.')
}

export function createSqlitePublicationRecords(db: Db): PublicationRecords {
  const job = (owner: string, jobId: string, provider: CatalogProvider): PublicationJob | null => {
    ownerRequired(owner)
    return db.select({
      id: sessions.id, title: sessions.title, repository: repositories.name,
      repositoryId: repositories.id, providerId: repositories.providerRepositoryId,
      baseSha: sessions.sourceCommitSha, directory: stories.directory,
      initialContentSha256: stories.initialContentSha256,
    }).from(sessions).innerJoin(stories, and(
      eq(sessions.storyId, stories.id), eq(sessions.ownerUserId, stories.ownerUserId),
    )).innerJoin(repositories, and(
      eq(stories.repositoryId, repositories.id), eq(stories.ownerUserId, repositories.ownerUserId),
    )).where(and(eq(sessions.id, jobId), eq(sessions.ownerUserId, owner),
      eq(repositories.provider, provider))).get() ?? null
  }

  const get = (owner: string, jobId: string, provider: CatalogProvider): PublicationReceipt | null => {
    ownerRequired(owner)
    if (provider === 'github') {
      const row = db.select({
        targetBranch: githubPublications.targetBranch, remoteBranch: githubPublications.remoteBranch,
        headSha: githubPublications.headSha, phase: githubPublications.phase,
        number: githubPublications.prNumber, url: githubPublications.prUrl,
      }).from(githubPublications).where(and(
        eq(githubPublications.ownerUserId, owner), eq(githubPublications.jobId, jobId))).get()
      return row ?? null
    }
    const row = db.select({
      targetBranch: gitlabPublications.targetBranch, remoteBranch: gitlabPublications.remoteBranch,
      headSha: gitlabPublications.headSha, phase: gitlabPublications.phase,
      number: gitlabPublications.mrIid, url: gitlabPublications.mrUrl,
    }).from(gitlabPublications).where(and(
      eq(gitlabPublications.ownerUserId, owner), eq(gitlabPublications.jobId, jobId))).get()
    return row ?? null
  }

  return {
    async job(owner, jobId, provider) { return job(owner, jobId, provider) },
    async get(owner, jobId, provider) { return get(owner, jobId, provider) },
    async save(owner, jobId, provider, next, updatedAt) {
      ownerRequired(owner)
      db.transaction(tx => {
        // Reject revoked or cross-provider job ownership even on an existing receipt.
        if (!job(owner, jobId, provider))
          throw new PublicationStateConflict('Publication job is not owned by this provider account.')
        const effective = reconcilePublication(get(owner, jobId, provider), next)
        if (provider === 'github') {
          tx.insert(githubPublications).values({
            jobId, ownerUserId: owner, targetBranch: effective.targetBranch,
            remoteBranch: effective.remoteBranch, headSha: effective.headSha,
            phase: effective.phase, prNumber: effective.number, prUrl: effective.url, updatedAt,
          }).onConflictDoUpdate({
            target: githubPublications.jobId,
            set: {
              headSha: effective.headSha, phase: effective.phase,
              prNumber: effective.number, prUrl: effective.url, updatedAt,
            },
            setWhere: eq(githubPublications.ownerUserId, owner),
          }).run()
        } else {
          tx.insert(gitlabPublications).values({
            jobId, ownerUserId: owner, targetBranch: effective.targetBranch,
            remoteBranch: effective.remoteBranch, headSha: effective.headSha,
            phase: effective.phase, mrIid: effective.number, mrUrl: effective.url, updatedAt,
          }).onConflictDoUpdate({
            target: gitlabPublications.jobId,
            set: {
              headSha: effective.headSha, phase: effective.phase,
              mrIid: effective.number, mrUrl: effective.url, updatedAt,
            },
            setWhere: eq(gitlabPublications.ownerUserId, owner),
          }).run()
        }
      }, { behavior: 'immediate' })
    },
  }
}
