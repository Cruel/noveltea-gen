import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { betterAuth } from 'better-auth'
import type { Kysely } from 'kysely'
import { openKyselyDatabase, type DatabaseOptions, type SharedDatabase } from '../../src/db/kysely-connection'
import type { StudioDb } from '../../src/db/studio-db'
import {
  openStudioSchemaConnection,
  migrateStudioKysely,
  type StudioSchemaOptions,
} from '../../src/db/kysely-migrations'
import { studioAuthOptionsForDatabase } from '../../src/lib/auth'
import { createKyselyCollectionCatalog } from '../../src/persistence/collection-kysely'
import { createKyselyPublicationRecords } from '../../src/persistence/publication-kysely'
import { createKyselyGitPersistence } from '../../src/persistence/git-kysely'
import { createKyselyConversationCatalog } from '../../src/persistence/conversation-kysely'
import { createKyselyNaturalStoryPersistence } from '../../src/persistence/natural-story-kysely'
import { createKyselyThreadMessages } from '../../src/persistence/thread-message-kysely'
import { createKyselyAdvancedThreads } from '../../src/persistence/advanced-thread-kysely'
import type { AdvancedThreadPersistence } from '../../src/persistence/advanced-thread-contracts'
import type { ThreadMessagePersistence } from '../../src/persistence/thread-message-contracts'
import { createKyselyCatalogPersistence } from '../../src/persistence/catalog-kysely'
import type { ConversationCatalog } from '../../src/persistence/conversation-contracts'
import type { NaturalStoryPersistence } from '../../src/persistence/natural-story-contracts'
import type { DashboardCatalog, SettingsPreferences } from '../../src/persistence/contracts'
import type {
  GitIdentities,
  RepositoryCatalogWrites,
  StoryOnboarding,
  PiCredentialVault,
  GitProvider,
} from '../../src/persistence/git-contracts'
import type { CollectionCatalog } from '../../src/persistence/collection-contracts'
import type { PublicationRecords } from '../../src/persistence/publication-contracts'
import type { TestFields, TestPersistence } from './test-persistence'

const authConfig = {
  baseURL: 'http://localhost:3000',
  secret: 'kysely-feature-conformance-test-secret-0123456789',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}

export interface KyselyFeatureFixture {
  /** Disposable-only connection options for independent OS-process conformance workers. */
  databaseOptions: DatabaseOptions
  collections: CollectionCatalog
  publications: PublicationRecords
  git: GitIdentities
  repositories: RepositoryCatalogWrites
  onboarding: StoryOnboarding
  piCredentials: PiCredentialVault
  conversations: ConversationCatalog
  naturalStory: NaturalStoryPersistence
  messages: ThreadMessagePersistence
  advancedThreads: AdvancedThreadPersistence
  dashboard: DashboardCatalog
  settings: SettingsPreferences
  account(owner: string, provider: GitProvider): Promise<void>
  /** Reopen the same backing database with a new connection to prove persistence. */
  reopenGit(): Promise<ReturnType<typeof createKyselyGitPersistence>>
  openIndependentMessages(): Promise<{ messages: ThreadMessagePersistence; close(): Promise<void> }>
  openIndependentAdvancedThreads(): Promise<{ advancedThreads: AdvancedThreadPersistence; close(): Promise<void> }>
  reopenAdvancedThreads(): Promise<AdvancedThreadPersistence>
  reopenMessages(): Promise<ThreadMessagePersistence>
  reopenNavigation(): Promise<{
    conversations: ConversationCatalog
    naturalStory: NaturalStoryPersistence
    collections: CollectionCatalog
    dashboard: DashboardCatalog
    settings: SettingsPreferences
  }>
  /** Exactly one test-only records surface for SQLite and PostgreSQL. */
  records: TestPersistence['records']
  owner(): Promise<string>
  close(): Promise<void>
}

/** Test-only structural data helpers. No driver SQL or backend branching here. */
function records(db: Kysely<any>): TestPersistence['records'] {
  function filtered<T>(query: T, filter?: TestFields): T {
    let result: any = query
    for (const [key, value] of Object.entries(filter ?? {}))
      result = value === null ? result.where(key, 'is', null) : result.where(key, '=', value)
    return result as T
  }
  return {
    async insert(table, row) {
      await db.insertInto(table).values(row).execute()
    },
    async update(table, filter, changes) {
      const result = await filtered(db.updateTable(table).set(changes), filter).executeTakeFirst()
      return Number(result.numUpdatedRows)
    },
    async delete(table, filter) {
      const result = await filtered(db.deleteFrom(table), filter).executeTakeFirst()
      return Number(result.numDeletedRows)
    },
    async all<T extends TestFields = TestFields>(
      table: string,
      filter?: TestFields,
      sort?: {
        by: string
        direction?: 'asc' | 'desc'
      },
    ): Promise<T[]> {
      let query = filtered(db.selectFrom(table).selectAll(), filter)
      if (sort) query = query.orderBy(sort.by, sort.direction ?? 'asc')
      return (await query.execute()) as T[]
    },
    async first<T extends TestFields = TestFields>(table: string, filter?: TestFields) {
      return (await filtered(db.selectFrom(table).selectAll(), filter).executeTakeFirst()) as T | undefined
    },
    async count(table, filter) {
      const row = await filtered(
        db.selectFrom(table).select((eb) => eb.fn.countAll().as('count')),
        filter,
      ).executeTakeFirst()
      return Number(row?.count ?? 0)
    },
  }
}

export async function openKyselyFeatureFixture(
  backend: 'sqlite' | 'postgres',
): Promise<KyselyFeatureFixture> {
  const directory = mkdtempSync(join(tmpdir(), 'nt-kysely-features-'))
  const schema = 'studio_features_' + randomUUID().replace(/-/g, '')
  const url = process.env.NT_TEST_PG_URL
  const admin = backend === 'postgres' ? new Pool({ connectionString: url }) : null
  let createdSchema = false
  const options: StudioSchemaOptions =
    backend === 'sqlite'
      ? { backend, path: join(directory, 'studio.sqlite') }
      : { backend, connection: { connectionString: url, options: `-c search_path=${schema}` } }
  let maintenance: ReturnType<typeof openStudioSchemaConnection> | undefined
  let database: SharedDatabase<StudioDb> | undefined
  try {
    if (admin) {
      await admin.query(`CREATE SCHEMA "${schema}"`)
      createdSchema = true
    }
    maintenance = openStudioSchemaConnection(options)
    await migrateStudioKysely(maintenance, authConfig)
    database = openKyselyDatabase<StudioDb>(options)
    const auth = betterAuth(studioAuthOptionsForDatabase(maintenance.authDatabase, authConfig))
    const authContext = await auth.$context
    const fixtureRecords = records(maintenance.db)
    return {
      databaseOptions: options,
      collections: createKyselyCollectionCatalog(database),
      conversations: createKyselyConversationCatalog(database),
      naturalStory: createKyselyNaturalStoryPersistence(database),
      messages: createKyselyThreadMessages(database),
      advancedThreads: createKyselyAdvancedThreads(database),
      ...createKyselyCatalogPersistence(database),
      publications: createKyselyPublicationRecords(database),
      ...createKyselyGitPersistence(database),
      records: fixtureRecords,
      async account(owner, provider) {
        await authContext.internalAdapter.createAccount({
          userId: owner,
          providerId: provider,
          accountId: randomUUID(),
        })
      },
      async reopenGit() {
        await database!.close()
        database = openKyselyDatabase<StudioDb>(options)
        return createKyselyGitPersistence(database)
      },
      async openIndependentMessages() {
        const other = openKyselyDatabase<StudioDb>(options)
        return { messages: createKyselyThreadMessages(other), close: () => other.close() }
      },
      async openIndependentAdvancedThreads() {
        const other = openKyselyDatabase<StudioDb>(options)
        return { advancedThreads: createKyselyAdvancedThreads(other), close: () => other.close() }
      },
      async reopenAdvancedThreads() {
        await database!.close()
        database = openKyselyDatabase<StudioDb>(options)
        return createKyselyAdvancedThreads(database)
      },
      async reopenMessages() {
        await database!.close()
        database = openKyselyDatabase<StudioDb>(options)
        return createKyselyThreadMessages(database)
      },
      async reopenNavigation() {
        await database!.close()
        database = openKyselyDatabase<StudioDb>(options)
        return {
          collections: createKyselyCollectionCatalog(database),
          conversations: createKyselyConversationCatalog(database),
          naturalStory: createKyselyNaturalStoryPersistence(database),
          ...createKyselyCatalogPersistence(database),
        }
      },
      async owner() {
        const id = randomUUID()
        const user = await authContext.internalAdapter.createUser(
          {
            name: 'Fixture ' + id,
            email: id + '@kysely.test',
            emailVerified: true,
          },
          { method: 'test' },
        )
        return user.id
      },
      async close() {
        await database!.close()
        await maintenance!.close()
        if (createdSchema) await admin!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        await admin?.end()
        rmSync(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await database?.close()
    await maintenance?.close()
    if (createdSchema) await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin?.end()
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
