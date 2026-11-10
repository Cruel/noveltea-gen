import { SqliteAdapter, sql, type Kysely } from 'kysely'
import { trustedCatalogProjectionSql, trustedCatalogViewName } from '../../src/db/trusted-catalog-definition'

const sqlite = (db: Kysely<unknown>) => db.getExecutor().adapter instanceof SqliteAdapter

/** One Kysely owner-scoped projection for both engines; no second SQL schema.
 * PostgreSQL controller permissions remain restricted to a single view. */
export async function up(db: Kysely<unknown>) {
  const name = await trustedCatalogViewName(db, sqlite(db) ? 'sqlite' : 'postgres')
  const source = trustedCatalogProjectionSql(db)
  await sql.raw(`${name === 'controller_catalog.trusted_jobs' ? 'CREATE OR REPLACE VIEW' : 'CREATE VIEW'} ${name} AS ${source}`).execute(db)
  if (name === 'controller_catalog.trusted_jobs')
    await sql.raw('GRANT SELECT ON controller_catalog.trusted_jobs TO noveltea_controller').execute(db)
}

export async function down(db: Kysely<unknown>) {
  await sql.raw(`DROP VIEW ${await trustedCatalogViewName(db, sqlite(db) ? 'sqlite' : 'postgres')}`).execute(db)
}
