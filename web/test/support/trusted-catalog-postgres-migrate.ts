/** Execute the exact authored migration as the application role, from the
 * disposable pg-app network; the controller role is never given DDL access. */
import { openStudioSchemaConnection } from '../../src/db/kysely-migrations'
import { up } from '../../kysely-schema/migrations/0002_trusted_catalog'

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
} finally {
  await connection.close()
}
console.log('PASS authored PostgreSQL trusted-catalog migration as app role')
