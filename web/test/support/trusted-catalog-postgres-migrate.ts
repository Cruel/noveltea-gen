/** Execute the exact authored migration as the application role, from the
 * disposable pg-app network; the controller role is never given DDL access. */
import { openStudioSchemaConnection, assertTrustedCatalogView } from '../../src/db/kysely-migrations'
import { up } from '../../kysely-schema/migrations/0002_trusted_catalog'
import { trustedCatalogProjectionSql } from '../../src/db/trusted-catalog-definition'
import { sql } from 'kysely'
import assert from 'node:assert/strict'

if (process.env.PGUSER !== 'noveltea_app') throw new Error('Migration probe requires application role')
const connection = openStudioSchemaConnection({
  backend: 'postgres',
  connection: {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT ?? '5432'),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  },
})
try {
  await up(connection.db)
  await assertTrustedCatalogView(connection)
  const projection = trustedCatalogProjectionSql(connection.db)
  const forged = projection.replace('"repository"."provider" as "provider"',
    '"repository"."id" as "provider"')
  assert.notEqual(forged, projection)
  await sql.raw('CREATE OR REPLACE VIEW controller_catalog.trusted_jobs AS ' + forged).execute(connection.db)
  await assert.rejects(assertTrustedCatalogView(connection), /trusted catalog view definition drift/)
  await up(connection.db)
  await assertTrustedCatalogView(connection)
} finally {
  await connection.close()
}
console.log('PASS authored PostgreSQL trusted-catalog migration as app role')
