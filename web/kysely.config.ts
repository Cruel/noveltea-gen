import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { defineConfig } from 'kysely-ctl'
import { fileURLToPath } from 'node:url'

// Used ONLY to scaffold handwritten migrations. All real up/down/to/check
// operations go through src/db/kysely-migrate-cli.ts, which runs Better Auth
// first, validates migration history and selects the explicitly configured DB.
// Never let scaffolding connect to a developer/Compose database.
export default defineConfig({
  kysely: new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) }),
  migrations: {
    migrationFolder:
      process.env.NT_KYSELY_SCAFFOLD_DIR ??
      fileURLToPath(new URL('./kysely-schema/migrations/', import.meta.url)),
    getMigrationPrefix: () =>
      new Date()
        .toISOString()
        .replace(/[-:.TZ]/g, '')
        .slice(0, 14) + '_',
  },
})
