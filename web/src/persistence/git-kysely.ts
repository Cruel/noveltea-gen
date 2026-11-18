import { sql, type Kysely, type Transaction } from 'kysely'
import type { SharedDatabase, QueryExecutor } from '../db/kysely-connection'
import { studioSafeInteger } from '../db/kysely-values'
import type { StudioDb } from '../db/studio-db'
import type {
  GitConnectionRecord,
  GitConnectionStatus,
  GitConnectionSummary,
  GitIdentities,
  GitProvider,
  PiCredentialVault,
  RepositoryCatalogWrites,
  RepositoryRecord,
  StoryInput,
  StoryOnboarding,
  StoryRecord,
} from './git-contracts'

type Read = QueryExecutor<StudioDb>
type Write = Transaction<StudioDb>
type Ports = {
  git: GitIdentities
  repositories: RepositoryCatalogWrites
  onboarding: StoryOnboarding
  piCredentials: PiCredentialVault
}

function required(owner: string): void {
  if (!owner) throw new Error('Authenticated actor required')
}

/** Better Auth owns and migrates its account table. Its column names use
 * camelCase, unlike Studio's snake_case schema. These fixed quoted references
 * deliberately bypass Studio's CamelCasePlugin; never interpolate input into SQL.
 */
function loginAccounts(db: Read | Write, owner: string, provider: GitProvider) {
  return db
    .selectFrom(sql<{ id: string }>`"account"`.as('login_account'))
    .select('login_account.id')
    .where(sql<string>`"login_account"."userId"`, '=', owner)
    .where(sql<string>`"login_account"."providerId"`, '=', provider)
}

function connectionRow(row: {
  id: string
  ownerUserId: string
  provider: string
  providerAccountId: string
  login: string
  credentials: string
  revision: number
  accessExpiresAt: number | null
  refreshExpiresAt: number | null
  refreshLeaseId: string | null
  refreshLeaseUntil: number | null
  status: string
}): GitConnectionRecord {
  return {
    id: row.id,
    owner: row.ownerUserId,
    provider: row.provider as GitProvider,
    providerAccountId: row.providerAccountId,
    login: row.login,
    credentials: row.credentials,
    revision: studioSafeInteger(row.revision),
    accessExpiresAt: row.accessExpiresAt === null ? null : studioSafeInteger(row.accessExpiresAt),
    refreshExpiresAt: row.refreshExpiresAt === null ? null : studioSafeInteger(row.refreshExpiresAt),
    refreshLeaseId: row.refreshLeaseId,
    refreshLeaseUntil: row.refreshLeaseUntil === null ? null : studioSafeInteger(row.refreshLeaseUntil),
    status: row.status as GitConnectionStatus,
  }
}

function repositoryRow(row: {
  id: string
  provider: string
  providerRepositoryId: string
  name: string
  connectionId: string | null
}): RepositoryRecord {
  return {
    id: row.id,
    provider: row.provider as GitProvider,
    providerId: row.providerRepositoryId,
    name: row.name,
    connectionId: row.connectionId,
  }
}

function storyValues(story: StoryInput) {
  return {
    id: story.id,
    ownerUserId: story.owner,
    repositoryId: story.repositoryId,
    directory: story.directory,
    title: story.title,
    createdAt: story.createdAt,
    sourceCommitSha: story.commitSha,
    initialContentSha256: story.contentSha256 ?? null,
  }
}

function storyRow(row: {
  id: string
  directory: string
  title: string
  sourceCommitSha: string | null
}): StoryRecord {
  return { id: row.id, directory: row.directory, title: row.title, commitSha: row.sourceCommitSha }
}

async function activeConnection(
  db: Read | Write,
  owner: string,
  provider: GitProvider,
  connectionId: string,
) {
  return !!(await db
    .selectFrom('gitConnections')
    .select('id')
    .where('id', '=', connectionId)
    .where('ownerUserId', '=', owner)
    .where('provider', '=', provider)
    .where('status', '=', 'connected')
    .executeTakeFirst())
}

async function savedRepository(db: Read | Write, owner: string, provider: GitProvider, providerId: string) {
  const row = await db
    .selectFrom('repositories')
    .select(['id', 'provider', 'providerRepositoryId', 'name', 'connectionId'])
    .where('ownerUserId', '=', owner)
    .where('provider', '=', provider)
    .where('providerRepositoryId', '=', providerId)
    .executeTakeFirst()
  if (!row) throw new Error('Imported repository was not persisted')
  return repositoryRow(row)
}

/** One owner-scoped Git persistence implementation for SQLite and PostgreSQL.
 * Every write (including CAS and multi-statement flows) uses the shared,
 * rollback-safe transaction and its executor. This port is composed with all other domains in the shared Studio store.
 */
export function createKyselyGitPersistence(db: SharedDatabase<StudioDb>): Ports {
  const git: GitIdentities = {
    async list(owner) {
      required(owner)
      const rows = await db.read
        .selectFrom('gitConnections')
        .select(['id', 'provider', 'providerAccountId', 'login', 'status', 'accessExpiresAt'])
        .where('ownerUserId', '=', owner)
        .orderBy('provider')
        .orderBy('login')
        .execute()
      return rows.map((row): GitConnectionSummary => ({
        id: row.id,
        provider: row.provider as GitProvider,
        accountId: row.providerAccountId,
        login: row.login,
        status: row.status as GitConnectionStatus,
        accessExpiresAt: row.accessExpiresAt === null ? null : studioSafeInteger(row.accessExpiresAt),
      }))
    },
    async read(owner, id) {
      required(owner)
      const row = await db.read
        .selectFrom('gitConnections')
        .select([
          'id',
          'ownerUserId',
          'provider',
          'providerAccountId',
          'login',
          'credentials',
          'revision',
          'accessExpiresAt',
          'refreshExpiresAt',
          'refreshLeaseId',
          'refreshLeaseUntil',
          'status',
        ])
        .where('id', '=', id)
        .where('ownerUserId', '=', owner)
        .executeTakeFirst()
      return row ? connectionRow(row) : null
    },
    async hasActive(owner, provider) {
      required(owner)
      return !!(await db.read
        .selectFrom('gitConnections')
        .select('id')
        .where('ownerUserId', '=', owner)
        .where('provider', '=', provider)
        .where('status', '!=', 'disconnected')
        .executeTakeFirst())
    },
    async legacyAccounts(owner, provider) {
      required(owner)
      return (await loginAccounts(db.read, owner, provider).execute()).map((row) => row.id)
    },
    async startFlow(owner, provider, stateHash, verifier, expiresAt, now) {
      required(owner)
      await db.withWriteTransaction([], async (tx) => {
        await tx.deleteFrom('gitConnectionFlows').where('expiresAt', '<', now).execute()
        await tx
          .insertInto('gitConnectionFlows')
          .values({
            stateHash,
            ownerUserId: owner,
            provider,
            verifier,
            expiresAt,
          })
          .execute()
      })
    },
    async consumeFlow(stateHash, provider, now) {
      return db.withWriteTransaction([], async (tx) => {
        const row = await tx
          .deleteFrom('gitConnectionFlows')
          .where('stateHash', '=', stateHash)
          .where('provider', '=', provider)
          .where('expiresAt', '>=', now)
          .returning(['ownerUserId', 'verifier'])
          .executeTakeFirst()
        return row ? { owner: row.ownerUserId, verifier: row.verifier } : null
      })
    },
    async connect(record) {
      required(record.owner)
      await db.withWriteTransaction([], async (tx) => {
        await tx
          .insertInto('gitConnections')
          .values({
            id: record.id,
            ownerUserId: record.owner,
            provider: record.provider,
            providerAccountId: record.providerAccountId,
            login: record.login,
            credentials: record.credentials,
            accessExpiresAt: record.accessExpiresAt,
            refreshExpiresAt: record.refreshExpiresAt,
            createdAt: record.now,
            updatedAt: record.now,
          })
          .onConflict((oc) =>
            oc.columns(['ownerUserId', 'provider', 'providerAccountId']).doUpdateSet({
              login: record.login,
              credentials: record.credentials,
              accessExpiresAt: record.accessExpiresAt,
              refreshExpiresAt: record.refreshExpiresAt,
              revision: sql<number>`"git_connections"."revision" + 1`,
              status: 'connected',
              refreshLeaseId: null,
              refreshLeaseUntil: null,
              updatedAt: record.now,
            }),
          )
          .execute()
      })
    },
    async disconnect(owner, id, now) {
      required(owner)
      return db.withWriteTransaction([], async (tx) => {
        const row = await tx
          .updateTable('gitConnections')
          .set({
            status: 'disconnected',
            credentials: '',
            accessExpiresAt: null,
            refreshExpiresAt: null,
            revision: sql<number>`revision + 1`,
            refreshLeaseId: null,
            refreshLeaseUntil: null,
            updatedAt: now,
          })
          .where('id', '=', id)
          .where('ownerUserId', '=', owner)
          .returning('id')
          .executeTakeFirst()
        return !!row
      })
    },
    async requireReauthorization(owner, id, revision, leaseId) {
      required(owner)
      await db.withWriteTransaction([], async (tx) => {
        let query = tx
          .updateTable('gitConnections')
          .set({ status: 'reauthorize' })
          .where('id', '=', id)
          .where('ownerUserId', '=', owner)
          .where('revision', '=', revision)
        if (leaseId) query = query.where('refreshLeaseId', '=', leaseId)
        await query.execute()
      })
    },
    async acquireRefreshLease(owner, id, revision, leaseId, leaseUntil, now) {
      required(owner)
      return db.withWriteTransaction([], async (tx) => {
        const row = await tx
          .updateTable('gitConnections')
          .set({ refreshLeaseId: leaseId, refreshLeaseUntil: leaseUntil })
          .where('id', '=', id)
          .where('ownerUserId', '=', owner)
          .where('revision', '=', revision)
          .where('status', '=', 'connected')
          .where((eb) => eb.or([eb('refreshLeaseUntil', 'is', null), eb('refreshLeaseUntil', '<', now)]))
          .returning('id')
          .executeTakeFirst()
        return !!row
      })
    },
    async finishRefresh(owner, id, revision, leaseId, values) {
      required(owner)
      return db.withWriteTransaction([], async (tx) => {
        const row = await tx
          .updateTable('gitConnections')
          .set({
            credentials: values.credentials,
            accessExpiresAt: values.accessExpiresAt,
            refreshExpiresAt: values.refreshExpiresAt,
            revision: sql<number>`revision + 1`,
            refreshLeaseId: null,
            refreshLeaseUntil: null,
            updatedAt: values.now,
          })
          .where('id', '=', id)
          .where('ownerUserId', '=', owner)
          .where('revision', '=', revision)
          .where('refreshLeaseId', '=', leaseId)
          .returning('id')
          .executeTakeFirst()
        return !!row
      })
    },
    async failRefresh(owner, id, leaseId) {
      required(owner)
      await db.withWriteTransaction([], async (tx) => {
        await tx
          .updateTable('gitConnections')
          .set({ status: 'reauthorize', refreshLeaseId: null, refreshLeaseUntil: null })
          .where('id', '=', id)
          .where('ownerUserId', '=', owner)
          .where('refreshLeaseId', '=', leaseId)
          .execute()
      })
    },
  }
  const repositories: RepositoryCatalogWrites = {
    async get(owner, id, provider) {
      required(owner)
      let query = db.read
        .selectFrom('repositories')
        .select(['id', 'provider', 'providerRepositoryId', 'name', 'connectionId'])
        .where('id', '=', id)
        .where('ownerUserId', '=', owner)
      if (provider) query = query.where('provider', '=', provider)
      const row = await query.executeTakeFirst()
      return row ? repositoryRow(row) : null
    },
    async identities(owner) {
      required(owner)
      const rows = await db.read
        .selectFrom('repositories')
        .select(['provider', 'providerRepositoryId'])
        .where('ownerUserId', '=', owner)
        .execute()
      return rows.map((row) => ({ provider: row.provider as GitProvider, id: row.providerRepositoryId }))
    },
    async upsert(owner, provider, providerId, name, connectionId, id, now) {
      required(owner)
      return db.withWriteTransaction([], async (tx) => {
        if (connectionId && !(await activeConnection(tx, owner, provider, connectionId)))
          throw new Error('Repository import requires an active, owner-scoped Git connection')
        // Duplicate discovery may rename, but must never silently change credentials.
        await tx
          .insertInto('repositories')
          .values({
            id,
            ownerUserId: owner,
            provider,
            providerRepositoryId: providerId,
            connectionId,
            name,
            createdAt: now,
          })
          .onConflict((oc) =>
            oc.columns(['ownerUserId', 'provider', 'providerRepositoryId']).doUpdateSet({ name }),
          )
          .execute()
        return savedRepository(tx, owner, provider, providerId)
      })
    },
    async rebind(owner, repository, connectionId) {
      required(owner)
      return db.withWriteTransaction([], async (tx) => {
        if (connectionId === null) {
          if ((await loginAccounts(tx, owner, repository.provider).execute()).length !== 1) return false
        } else if (!(await activeConnection(tx, owner, repository.provider, connectionId))) {
          return false
        }
        const row = await tx
          .updateTable('repositories')
          .set({ connectionId })
          .where('id', '=', repository.id)
          .where('ownerUserId', '=', owner)
          .where('provider', '=', repository.provider)
          .where('name', '=', repository.name)
          .where('providerRepositoryId', '=', repository.providerId)
          .returning('id')
          .executeTakeFirst()
        return !!row
      })
    },
    async repositoryForStory(owner, storyId, provider) {
      required(owner)
      const row = await db.read
        .selectFrom('stories')
        .innerJoin('repositories', (join) =>
          join
            .onRef('stories.repositoryId', '=', 'repositories.id')
            .onRef('stories.ownerUserId', '=', 'repositories.ownerUserId'),
        )
        .select('repositories.id as id')
        .where('stories.id', '=', storyId)
        .where('stories.ownerUserId', '=', owner)
        .where('repositories.provider', '=', provider)
        .executeTakeFirst()
      return row?.id ?? null
    },
    async pendingInstallNames(owner, now) {
      required(owner)
      const rows = await db.read
        .selectFrom('githubInstallFlows')
        .select('desiredRepository')
        .where('ownerUserId', '=', owner)
        .where('status', '=', 'pending')
        .where('expiresAt', '>', now)
        .where('desiredRepository', 'is not', null)
        .orderBy('createdAt', 'desc')
        .execute()
      return rows.flatMap((row) => (row.desiredRepository ? [row.desiredRepository] : []))
    },
    async beginInstall(flow, now) {
      required(flow.owner)
      await db.withWriteTransaction([], async (tx) => {
        await tx.deleteFrom('githubInstallFlows').where('expiresAt', '<', now).execute()
        await tx
          .insertInto('githubInstallFlows')
          .values({
            stateHash: flow.stateHash,
            ownerUserId: flow.owner,
            desiredRepository: flow.desired,
            createdAt: flow.createdAt,
            expiresAt: flow.expiresAt,
            status: 'started',
            connectionId: flow.connectionId,
          })
          .execute()
      })
    },
    async consumeInstall(owner, hash, now) {
      required(owner)
      return db.withWriteTransaction([], async (tx) => {
        const row = await tx
          .updateTable('githubInstallFlows')
          .set({ status: 'used' })
          .where('stateHash', '=', hash)
          .where('ownerUserId', '=', owner)
          .where('status', '=', 'started')
          .where('expiresAt', '>', now)
          .returning(['desiredRepository', 'connectionId'])
          .executeTakeFirst()
        return row ? { desired: row.desiredRepository, connectionId: row.connectionId } : null
      })
    },
    async deferInstall(owner, hash, expiresAt) {
      required(owner)
      await db.withWriteTransaction([], async (tx) => {
        await tx
          .updateTable('githubInstallFlows')
          .set({ status: 'pending', expiresAt })
          .where('stateHash', '=', hash)
          .where('ownerUserId', '=', owner)
          .execute()
      })
    },
    async clearPendingInstall(owner, name) {
      required(owner)
      await db.withWriteTransaction([], async (tx) => {
        await tx
          .deleteFrom('githubInstallFlows')
          .where('ownerUserId', '=', owner)
          .where('status', '=', 'pending')
          .where(sql<boolean>`lower(desired_repository) = lower(${name})`)
          .execute()
      })
    },
  }
  const onboarding: StoryOnboarding = {
    async conversation(owner, repositoryId, workspace) {
      required(owner)
      const row = await db.read
        .selectFrom('storyOnboardingConversations')
        .select(['revision', 'stateJson'])
        .where('ownerUserId', '=', owner)
        .where('repositoryId', '=', repositoryId)
        .where('workspace', '=', workspace)
        .executeTakeFirst()
      return row ? { revision: studioSafeInteger(row.revision), state: row.stateJson } : null
    },
    async saveConversation(owner, repositoryId, workspace, revision, state, previousRevision, now) {
      required(owner)
      return db.withWriteTransaction([], async (tx) => {
        if (previousRevision === null)
          return !!(await tx
            .insertInto('storyOnboardingConversations')
            .values({
              ownerUserId: owner,
              repositoryId,
              workspace,
              revision,
              stateJson: state,
              updatedAt: now,
            })
            .onConflict((oc) => oc.doNothing())
            .returning('ownerUserId')
            .executeTakeFirst())
        return !!(await tx
          .updateTable('storyOnboardingConversations')
          .set({
            revision,
            stateJson: state,
            updatedAt: now,
          })
          .where('ownerUserId', '=', owner)
          .where('repositoryId', '=', repositoryId)
          .where('workspace', '=', workspace)
          .where('revision', '=', previousRevision)
          .returning('ownerUserId')
          .executeTakeFirst())
      })
    },
    async draft(owner, repositoryId, workspace) {
      required(owner)
      const row = await db.read
        .selectFrom('storyOnboardingDrafts')
        .select(['revision', 'draftJson'])
        .where('ownerUserId', '=', owner)
        .where('repositoryId', '=', repositoryId)
        .where('workspace', '=', workspace)
        .executeTakeFirst()
      return row ? { revision: studioSafeInteger(row.revision), draftJson: row.draftJson } : null
    },
    async saveDraft(owner, repositoryId, workspace, previousRevision, draftJson, now) {
      required(owner)
      return db.withWriteTransaction([], async (tx) => {
        const row = await tx
          .insertInto('storyOnboardingDrafts')
          .values({
            ownerUserId: owner,
            repositoryId,
            workspace,
            revision: previousRevision + 1,
            draftJson,
            updatedAt: now,
          })
          .onConflict((oc) =>
            oc
              .columns(['ownerUserId', 'repositoryId', 'workspace'])
              .doUpdateSet({ revision: previousRevision + 1, draftJson, updatedAt: now })
              .where('storyOnboardingDrafts.revision', '=', previousRevision),
          )
          .returning('ownerUserId')
          .executeTakeFirst()
        return !!row
      })
    },
    async story(owner, repositoryId, directory) {
      required(owner)
      const row = await db.read
        .selectFrom('stories')
        .select(['id', 'initialContentSha256'])
        .where('ownerUserId', '=', owner)
        .where('repositoryId', '=', repositoryId)
        .where('directory', '=', directory)
        .executeTakeFirst()
      return row ? { id: row.id, contentSha256: row.initialContentSha256 } : null
    },
    async initializationJob(jobId) {
      const row = await db.read
        .selectFrom('studioSessions')
        .select(['storyId', 'ownerUserId', 'sourceCommitSha'])
        .where('id', '=', jobId)
        .executeTakeFirst()
      return row ? { storyId: row.storyId, ownerId: row.ownerUserId, commitSha: row.sourceCommitSha } : null
    },
    async githubInitialization(owner, repositoryId, directory) {
      required(owner)
      const row = await db.read
        .selectFrom('stories as story')
        .innerJoin('studioSessions as job', 'job.storyId', 'story.id')
        .select(['story.id as storyId', 'story.title', 'story.sourceCommitSha as baseSha',
          'job.id as jobId', 'job.generationConfigJson as configJson'])
        .where('story.ownerUserId', '=', owner)
        .where('story.repositoryId', '=', repositoryId)
        .where('story.directory', '=', directory)
        .where('story.initialContentSha256', 'is not', null)
        .where('job.ownerUserId', '=', owner)
        .whereRef('job.sourceCommitSha', '=', 'story.sourceCommitSha')
        .whereRef('job.createdAt', '=', 'story.createdAt')
        .where('job.generationRequestJson', 'is', null)
        .executeTakeFirst()
      return row?.baseSha ? { storyId: row.storyId, title: row.title,
        jobId: row.jobId, baseSha: row.baseSha, configured: row.configJson !== null } : null
    },
    async commitGithubInitialization(story, jobId) {
      required(story.owner)
      await db.withWriteTransaction([], async (tx) => {
        const existing = await tx
          .selectFrom('stories')
          .select('id')
          .where('ownerUserId', '=', story.owner)
          .where('repositoryId', '=', story.repositoryId)
          .where('directory', '=', story.directory)
          .executeTakeFirst()
        if (existing && existing.id !== story.id)
          throw new Error('Initialization Story identity changed during registration')
        if (!existing) await tx.insertInto('stories').values(storyValues(story)).execute()
        const saved = await tx
          .insertInto('studioSessions')
          .values({
            id: jobId,
            ownerUserId: story.owner,
            storyId: story.id,
            title: story.title,
            sourceCommitSha: story.commitSha,
            status: 'paused',
            createdAt: story.createdAt,
            updatedAt: story.createdAt,
          })
          .onConflict((oc) =>
            oc
              .column('id')
              .doUpdateSet({ updatedAt: story.createdAt })
              .where('studioSessions.ownerUserId', '=', story.owner)
              .where('studioSessions.storyId', '=', story.id)
              .where('studioSessions.sourceCommitSha', '=', story.commitSha),
          )
          .returning('id')
          .executeTakeFirst()
        if (!saved) throw new Error('Initialization job identity changed during registration')
      })
    },
    async importStory(story) {
      required(story.owner)
      return db.withWriteTransaction([], async (tx) => {
        const row = await tx
          .insertInto('stories')
          .values(storyValues(story))
          .onConflict((oc) =>
            oc
              .columns(['repositoryId', 'directory'])
              .doUpdateSet({
                title: story.title,
                sourceCommitSha: story.commitSha,
                ...(story.contentSha256
                  ? {
                      initialContentSha256: sql<string>`coalesce("stories"."initial_content_sha256", ${story.contentSha256})`,
                    }
                  : {}),
              })
              .where('stories.ownerUserId', '=', story.owner),
          )
          .returning(['id', 'directory', 'title', 'sourceCommitSha'])
          .executeTakeFirst()
        if (!row) throw new Error('Story import conflicts with another owner')
        return storyRow(row)
      })
    },
    async createStory(story) {
      required(story.owner)
      const row = await db.withWriteTransaction([], (tx) =>
        tx
          .insertInto('stories')
          .values({ ...storyValues(story), initialContentSha256: null })
          .returning(['id', 'directory', 'title', 'sourceCommitSha'])
          .executeTakeFirstOrThrow(),
      )
      return storyRow(row)
    },
  }
  const piCredentials: PiCredentialVault = {
    async read(owner, provider) {
      required(owner)
      const row = await db.read
        .selectFrom('piCredentials')
        .select(['ciphertext', 'revision'])
        .where('ownerUserId', '=', owner)
        .where('provider', '=', provider)
        .executeTakeFirst()
      return row ? { ciphertext: row.ciphertext, revision: studioSafeInteger(row.revision) } : null
    },
    async list(owner) {
      required(owner)
      return db.read
        .selectFrom('piCredentials')
        .select(['provider', 'ciphertext'])
        .where('ownerUserId', '=', owner)
        .execute()
    },
    async compareAndSwap(owner, provider, ciphertext, previousRevision) {
      required(owner)
      return db.withWriteTransaction([], async (tx) => {
        if (previousRevision === null)
          return !!(await tx
            .insertInto('piCredentials')
            .values({ ownerUserId: owner, provider, ciphertext })
            .onConflict((oc) => oc.doNothing())
            .returning('ownerUserId')
            .executeTakeFirst())
        return !!(await tx
          .updateTable('piCredentials')
          .set({ ciphertext, revision: sql<number>`revision + 1` })
          .where('ownerUserId', '=', owner)
          .where('provider', '=', provider)
          .where('revision', '=', previousRevision)
          .returning('ownerUserId')
          .executeTakeFirst())
      })
    },
    async delete(owner, provider) {
      required(owner)
      await db.withWriteTransaction([], async (tx) => {
        await tx
          .deleteFrom('piCredentials')
          .where('ownerUserId', '=', owner)
          .where('provider', '=', provider)
          .execute()
      })
    },
  }
  return { git, repositories, onboarding, piCredentials }
}
