import { and, eq, exists, gt, isNull, lt, or, sql, desc } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as schema from '../db/schema'
import { gitConnections, gitConnectionFlows, githubInstallFlows, piCredentials,
  repositories, sessions, stories, storyOnboardingDrafts, storyOnboardingConversations } from '../db/schema'
import type { GitIdentities, RepositoryCatalogWrites, StoryOnboarding,
  PiCredentialVault, GitProvider } from './git-contracts'

type StudioDrizzle = BetterSQLite3Database<typeof schema>
// Better Auth owns this table's migration. This is a read-only query projection.
const loginAccounts = sqliteTable('account', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  providerId: text('providerId').notNull(),
})
function ownerScope(owner: string) {
  if (!owner) throw new Error('Authenticated actor required')
}
const one = (n: { changes: number }) => n.changes === 1

/** Keep synchronous SQLite transactions inside this adapter. All public ports
 * are Promise-based so another SQL backend can be used without call-site changes.
 */
export function createGitSqlitePersistence(db: StudioDrizzle): {
  git: GitIdentities; repositories: RepositoryCatalogWrites
  onboarding: StoryOnboarding; piCredentials: PiCredentialVault
} {
  const git: GitIdentities = {
    async list(owner) {
      ownerScope(owner)
      return db.select({
        id: gitConnections.id, provider: gitConnections.provider,
        accountId: gitConnections.providerAccountId, login: gitConnections.login,
        status: gitConnections.status, accessExpiresAt: gitConnections.accessExpiresAt,
      }).from(gitConnections).where(eq(gitConnections.ownerUserId, owner))
        .orderBy(gitConnections.provider, gitConnections.login).all()
    },
    async read(owner, id) {
      ownerScope(owner)
      return db.select({
        id: gitConnections.id, owner: gitConnections.ownerUserId, provider: gitConnections.provider,
        providerAccountId: gitConnections.providerAccountId, login: gitConnections.login,
        credentials: gitConnections.credentials, revision: gitConnections.revision,
        refreshLeaseId: gitConnections.refreshLeaseId, refreshLeaseUntil: gitConnections.refreshLeaseUntil,
        accessExpiresAt: gitConnections.accessExpiresAt, refreshExpiresAt: gitConnections.refreshExpiresAt,
        status: gitConnections.status,
      }).from(gitConnections).where(and(eq(gitConnections.id, id),
        eq(gitConnections.ownerUserId, owner))).get() ?? null
    },
    async hasActive(owner, provider) {
      ownerScope(owner)
      return !!db.select({ id: gitConnections.id }).from(gitConnections).where(and(
        eq(gitConnections.ownerUserId, owner), eq(gitConnections.provider, provider),
        sql`${gitConnections.status} != 'disconnected'`,
      )).get()
    },
    async legacyAccounts(owner, provider) {
      ownerScope(owner)
      return db.select({ id: loginAccounts.id }).from(loginAccounts).where(and(
        eq(loginAccounts.userId, owner), eq(loginAccounts.providerId, provider),
      )).all().map(row => row.id)
    },
    async legacyProviders(owner) {
      ownerScope(owner)
      return db.selectDistinct({ provider: loginAccounts.providerId }).from(loginAccounts)
        .where(and(eq(loginAccounts.userId, owner),
          or(eq(loginAccounts.providerId, 'github'), eq(loginAccounts.providerId, 'gitlab'))))
        .all().map(row => row.provider as GitProvider)
    },
    async startFlow(owner, provider, stateHash, verifier, expiresAt, now) {
      ownerScope(owner)
      db.transaction(tx => {
        tx.delete(gitConnectionFlows).where(lt(gitConnectionFlows.expiresAt, now)).run()
        tx.insert(gitConnectionFlows).values({
          ownerUserId: owner, provider, stateHash, verifier, expiresAt,
        }).run()
      })
    },
    async consumeFlow(stateHash, provider, now) {
      const row = db.delete(gitConnectionFlows).where(and(
        eq(gitConnectionFlows.stateHash, stateHash), eq(gitConnectionFlows.provider, provider),
        sql`${gitConnectionFlows.expiresAt} >= ${now}`,
      )).returning({ owner: gitConnectionFlows.ownerUserId, verifier: gitConnectionFlows.verifier }).get()
      return row ?? null
    },
    async connect(record) {
      ownerScope(record.owner)
      db.insert(gitConnections).values({
        id: record.id, ownerUserId: record.owner, provider: record.provider,
        providerAccountId: record.providerAccountId, login: record.login,
        credentials: record.credentials, accessExpiresAt: record.accessExpiresAt,
        refreshExpiresAt: record.refreshExpiresAt, createdAt: record.now, updatedAt: record.now,
      }).onConflictDoUpdate({
        target: [gitConnections.ownerUserId, gitConnections.provider, gitConnections.providerAccountId],
        set: {
          login: record.login, credentials: record.credentials,
          accessExpiresAt: record.accessExpiresAt, refreshExpiresAt: record.refreshExpiresAt,
          revision: sql`${gitConnections.revision} + 1`, status: 'connected',
          refreshLeaseId: null, refreshLeaseUntil: null, updatedAt: record.now,
        },
      }).run()
    },
    async disconnect(owner, id, now) {
      ownerScope(owner)
      return one(db.update(gitConnections).set({
        status: 'disconnected', credentials: '', accessExpiresAt: null, refreshExpiresAt: null,
        revision: sql`${gitConnections.revision} + 1`, refreshLeaseId: null,
        refreshLeaseUntil: null, updatedAt: now,
      }).where(and(eq(gitConnections.id, id), eq(gitConnections.ownerUserId, owner))).run())
    },
    async requireReauthorization(owner, id, revision, leaseId) {
      ownerScope(owner)
      db.update(gitConnections).set({ status: 'reauthorize' }).where(and(
        eq(gitConnections.id, id), eq(gitConnections.ownerUserId, owner),
        eq(gitConnections.revision, revision),
        ...(leaseId ? [eq(gitConnections.refreshLeaseId, leaseId)] : []),
      )).run()
    },
    async acquireRefreshLease(owner, id, revision, leaseId, leaseUntil, now) {
      ownerScope(owner)
      return one(db.update(gitConnections).set({
        refreshLeaseId: leaseId, refreshLeaseUntil: leaseUntil,
      }).where(and(
        eq(gitConnections.id, id), eq(gitConnections.ownerUserId, owner),
        eq(gitConnections.revision, revision), eq(gitConnections.status, 'connected'),
        or(isNull(gitConnections.refreshLeaseUntil), lt(gitConnections.refreshLeaseUntil, now)),
      )).run())
    },
    async finishRefresh(owner, id, revision, leaseId, values) {
      ownerScope(owner)
      return one(db.update(gitConnections).set({
        credentials: values.credentials, accessExpiresAt: values.accessExpiresAt,
        refreshExpiresAt: values.refreshExpiresAt, revision: sql`${gitConnections.revision} + 1`,
        refreshLeaseId: null, refreshLeaseUntil: null, updatedAt: values.now,
      }).where(and(eq(gitConnections.id, id), eq(gitConnections.ownerUserId, owner),
        eq(gitConnections.revision, revision), eq(gitConnections.refreshLeaseId, leaseId))).run())
    },
    async failRefresh(owner, id, leaseId) {
      ownerScope(owner)
      db.update(gitConnections).set({
        status: 'reauthorize', refreshLeaseId: null, refreshLeaseUntil: null,
      }).where(and(eq(gitConnections.id, id), eq(gitConnections.ownerUserId, owner),
        eq(gitConnections.refreshLeaseId, leaseId))).run()
    },
  }
  const catalog: RepositoryCatalogWrites = {
    async get(owner, id, provider) {
      ownerScope(owner)
      return db.select({
        id: repositories.id, provider: repositories.provider,
        providerId: repositories.providerRepositoryId, name: repositories.name,
        connectionId: repositories.connectionId,
      }).from(repositories).where(and(
        eq(repositories.id, id), eq(repositories.ownerUserId, owner),
        ...(provider ? [eq(repositories.provider, provider)] : []),
      )).get() ?? null
    },
    async identities(owner) {
      ownerScope(owner)
      return db.select({ provider: repositories.provider, id: repositories.providerRepositoryId })
        .from(repositories).where(eq(repositories.ownerUserId, owner)).all()
    },
    async upsert(owner, provider, providerId, name, connectionId, id, now) {
      ownerScope(owner)
      return db.transaction(tx => {
        if (connectionId && !tx.select({ id: gitConnections.id }).from(gitConnections).where(and(
          eq(gitConnections.id, connectionId), eq(gitConnections.ownerUserId, owner),
          eq(gitConnections.provider, provider), eq(gitConnections.status, 'connected'),
        )).get()) {
          throw new Error('Repository import requires an active, owner-scoped Git connection')
        }
        tx.insert(repositories).values({
          id, ownerUserId: owner, provider, providerRepositoryId: providerId,
          connectionId, name, createdAt: now,
        }).onConflictDoUpdate({
          target: [repositories.ownerUserId, repositories.provider, repositories.providerRepositoryId],
          // Identity can ONLY be rebound through the dedicated, verified operation.
          set: { name },
        }).run()
        return tx.select({
          id: repositories.id, provider: repositories.provider, name: repositories.name,
          providerId: repositories.providerRepositoryId, connectionId: repositories.connectionId,
        }).from(repositories).where(and(eq(repositories.ownerUserId, owner),
          eq(repositories.provider, provider), eq(repositories.providerRepositoryId, providerId))).get()!
      })
    },
    async rebind(owner, repository, connectionId) {
      ownerScope(owner)
      const authorized = db.select({ id: gitConnections.id }).from(gitConnections).where(and(
        eq(gitConnections.id, connectionId), eq(gitConnections.ownerUserId, owner),
        eq(gitConnections.provider, repository.provider), eq(gitConnections.status, 'connected'),
      ))
      return one(db.update(repositories).set({ connectionId }).where(and(
        eq(repositories.id, repository.id), eq(repositories.ownerUserId, owner),
        eq(repositories.provider, repository.provider), eq(repositories.name, repository.name),
        eq(repositories.providerRepositoryId, repository.providerId), exists(authorized),
      )).run())
    },
    async repositoryForStory(owner, storyId, provider) {
      ownerScope(owner)
      const match = db.select({ id: repositories.id }).from(stories)
        .innerJoin(repositories, and(eq(stories.repositoryId, repositories.id),
          eq(stories.ownerUserId, repositories.ownerUserId)))
        .where(and(eq(stories.id, storyId), eq(stories.ownerUserId, owner),
          eq(repositories.provider, provider))).get()
      return match?.id ?? null
    },
    async pendingInstallNames(owner, now) {
      ownerScope(owner)
      return db.select({ desired: githubInstallFlows.desiredRepository }).from(githubInstallFlows)
        .where(and(eq(githubInstallFlows.ownerUserId, owner),
          eq(githubInstallFlows.status, 'pending'), gt(githubInstallFlows.expiresAt, now),
          sql`${githubInstallFlows.desiredRepository} IS NOT NULL`))
        .orderBy(desc(githubInstallFlows.createdAt)).all().flatMap(row => row.desired ? [row.desired] : [])
    },
    async beginInstall(flow, now) {
      ownerScope(flow.owner)
      db.transaction(tx => {
        tx.delete(githubInstallFlows).where(lt(githubInstallFlows.expiresAt, now)).run()
        tx.insert(githubInstallFlows).values({
          stateHash: flow.stateHash, ownerUserId: flow.owner, desiredRepository: flow.desired,
          createdAt: flow.createdAt, expiresAt: flow.expiresAt, status: 'started',
          connectionId: flow.connectionId,
        }).run()
      })
    },
    async consumeInstall(owner, hash, now) {
      ownerScope(owner)
      const row = db.update(githubInstallFlows).set({ status: 'used' }).where(and(
        eq(githubInstallFlows.stateHash, hash), eq(githubInstallFlows.ownerUserId, owner),
        eq(githubInstallFlows.status, 'started'), gt(githubInstallFlows.expiresAt, now),
      )).returning({
        desired: githubInstallFlows.desiredRepository,
        connectionId: githubInstallFlows.connectionId,
      }).get()
      return row ?? null
    },
    async deferInstall(owner, hash, expiresAt) {
      ownerScope(owner)
      db.update(githubInstallFlows).set({ status: 'pending', expiresAt })
        .where(and(eq(githubInstallFlows.stateHash, hash),
          eq(githubInstallFlows.ownerUserId, owner))).run()
    },
    async clearPendingInstall(owner, name) {
      ownerScope(owner)
      db.delete(githubInstallFlows).where(and(
        eq(githubInstallFlows.ownerUserId, owner), eq(githubInstallFlows.status, 'pending'),
        sql`lower(${githubInstallFlows.desiredRepository}) = lower(${name})`,
      )).run()
    },
  }
  const onboarding: StoryOnboarding = {
    async conversation(owner, repositoryId, workspace) {
      ownerScope(owner)
      const row = db.select({
        revision: storyOnboardingConversations.revision,
        state: storyOnboardingConversations.stateJson,
      }).from(storyOnboardingConversations).where(and(
        eq(storyOnboardingConversations.ownerUserId, owner),
        eq(storyOnboardingConversations.repositoryId, repositoryId),
        eq(storyOnboardingConversations.workspace, workspace),
      )).get()
      return row ?? null
    },
    async saveConversation(owner, repositoryId, workspace, revision, state, previousRevision, now) {
      ownerScope(owner)
      if (previousRevision === null) return one(db.insert(storyOnboardingConversations).values({
        ownerUserId: owner, repositoryId, workspace, revision, stateJson: state, updatedAt: now,
      }).onConflictDoNothing().run())
      return one(db.update(storyOnboardingConversations).set({
        revision, stateJson: state, updatedAt: now,
      }).where(and(eq(storyOnboardingConversations.ownerUserId, owner),
        eq(storyOnboardingConversations.repositoryId, repositoryId),
        eq(storyOnboardingConversations.workspace, workspace),
        eq(storyOnboardingConversations.revision, previousRevision))).run())
    },
    async draft(owner, repositoryId, workspace) {
      ownerScope(owner)
      const row = db.select({ revision: storyOnboardingDrafts.revision,
        draftJson: storyOnboardingDrafts.draftJson }).from(storyOnboardingDrafts)
        .where(and(eq(storyOnboardingDrafts.ownerUserId, owner),
          eq(storyOnboardingDrafts.repositoryId, repositoryId),
          eq(storyOnboardingDrafts.workspace, workspace))).get()
      return row ?? null
    },
    async saveDraft(owner, repositoryId, workspace, previousRevision, draftJson, now) {
      ownerScope(owner)
      const row = db.insert(storyOnboardingDrafts).values({
        ownerUserId: owner, repositoryId, workspace,
        revision: previousRevision + 1, draftJson, updatedAt: now,
      }).onConflictDoUpdate({
        target: [storyOnboardingDrafts.ownerUserId, storyOnboardingDrafts.repositoryId,
          storyOnboardingDrafts.workspace],
        set: { revision: previousRevision + 1, draftJson, updatedAt: now },
        setWhere: eq(storyOnboardingDrafts.revision, previousRevision),
      }).run()
      return one(row)
    },
    async story(owner, repositoryId, directory) {
      ownerScope(owner)
      const row = db.select({ id: stories.id, contentSha256: stories.initialContentSha256 })
        .from(stories).where(and(eq(stories.ownerUserId, owner),
          eq(stories.repositoryId, repositoryId), eq(stories.directory, directory))).get()
      return row ?? null
    },
    async initializationJob(jobId) {
      const row = db.select({ storyId: sessions.storyId, ownerId: sessions.ownerUserId,
        commitSha: sessions.sourceCommitSha }).from(sessions).where(eq(sessions.id, jobId)).get()
      return row ?? null
    },
    async commitGithubInitialization(story, jobId) {
      ownerScope(story.owner)
      db.transaction(tx => {
        const existing = tx.select({ id: stories.id }).from(stories).where(and(
          eq(stories.ownerUserId, story.owner), eq(stories.repositoryId, story.repositoryId),
          eq(stories.directory, story.directory))).get()
        if (existing && existing.id !== story.id) {
          throw new Error('Initialization Story identity changed during registration')
        }
        if (!existing) tx.insert(stories).values({
          id: story.id, ownerUserId: story.owner, repositoryId: story.repositoryId,
          directory: story.directory, title: story.title, createdAt: story.createdAt,
          sourceCommitSha: story.commitSha, initialContentSha256: story.contentSha256 ?? null,
        }).run()
        const saved = tx.insert(sessions).values({
          id: jobId, ownerUserId: story.owner, storyId: story.id, title: story.title,
          sourceCommitSha: story.commitSha, status: 'paused',
          createdAt: story.createdAt, updatedAt: story.createdAt,
        }).onConflictDoUpdate({
          target: sessions.id, set: { updatedAt: story.createdAt },
          setWhere: and(eq(sessions.ownerUserId, story.owner), eq(sessions.storyId, story.id),
            eq(sessions.sourceCommitSha, story.commitSha)),
        }).run()
        if (!one(saved)) throw new Error('Initialization job identity changed during registration')
      })
    },
    async importStory(story) {
      ownerScope(story.owner)
      return db.transaction(tx => {
        const saved = tx.insert(stories).values({
          id: story.id, ownerUserId: story.owner, repositoryId: story.repositoryId,
          directory: story.directory, title: story.title, createdAt: story.createdAt,
          sourceCommitSha: story.commitSha,
        }).onConflictDoUpdate({
          target: [stories.repositoryId, stories.directory],
          set: { title: story.title, sourceCommitSha: story.commitSha },
          setWhere: eq(stories.ownerUserId, story.owner),
        }).run()
        if (!one(saved)) throw new Error('Story import conflicts with another owner')
        return tx.select({ id: stories.id, directory: stories.directory,
          title: stories.title, commitSha: stories.sourceCommitSha }).from(stories).where(and(
          eq(stories.ownerUserId, story.owner), eq(stories.repositoryId, story.repositoryId),
          eq(stories.directory, story.directory))).get()!
      })
    },
    async createStory(story) {
      ownerScope(story.owner)
      const row = db.insert(stories).values({
        id: story.id, ownerUserId: story.owner, repositoryId: story.repositoryId,
        directory: story.directory, title: story.title, createdAt: story.createdAt,
        sourceCommitSha: story.commitSha,
      }).returning({ id: stories.id, directory: stories.directory,
        title: stories.title, commitSha: stories.sourceCommitSha }).get()
      return row
    },
  }
  const vault: PiCredentialVault = {
    async read(owner, provider) {
      ownerScope(owner)
      return db.select({ ciphertext: piCredentials.ciphertext, revision: piCredentials.revision })
        .from(piCredentials).where(and(eq(piCredentials.ownerUserId, owner),
          eq(piCredentials.provider, provider))).get() ?? null
    },
    async list(owner) {
      ownerScope(owner)
      return db.select({ provider: piCredentials.provider, ciphertext: piCredentials.ciphertext })
        .from(piCredentials).where(eq(piCredentials.ownerUserId, owner)).all()
    },
    async compareAndSwap(owner, provider, ciphertext, previousRevision) {
      ownerScope(owner)
      if (previousRevision === null) return one(db.insert(piCredentials).values({
        ownerUserId: owner, provider, ciphertext,
      }).onConflictDoNothing().run())
      return one(db.update(piCredentials).set({
        ciphertext, revision: sql`${piCredentials.revision} + 1`,
      }).where(and(eq(piCredentials.ownerUserId, owner),
        eq(piCredentials.provider, provider), eq(piCredentials.revision, previousRevision))).run())
    },
    async delete(owner, provider) {
      ownerScope(owner)
      db.delete(piCredentials).where(and(eq(piCredentials.ownerUserId, owner),
        eq(piCredentials.provider, provider))).run()
    },
  }
  return { git, repositories: catalog, onboarding, piCredentials: vault }
}
