import type { Kysely } from 'kysely'

/** Only new, explicitly typed verifier stops are indexed for known-fix
 * pickup. This is not a migration or scan of historical generation runs. */
export async function up(db: Kysely<unknown>) {
  await db.schema.createTable('generationVerifierStops')
    .addColumn('jobId', 'text', col => col.primaryKey().notNull()
      .references('studioSessions.id').onDelete('cascade'))
    .addColumn('ownerUserId', 'text', col => col.notNull())
    .addColumn('threadId', 'text', col => col.notNull())
    .addColumn('checkId', 'text', col => col.notNull())
    .addColumn('checkVersion', 'integer', col => col.notNull())
    .addColumn('failureSignature', 'text', col => col.notNull())
    .addColumn('sourceSha', 'text', col => col.notNull())
    .addColumn('turnDigest', 'text', col => col.notNull())
    .addColumn('attemptedFixesJson', 'text', col => col.notNull())
    .execute()
  await db.schema.createIndex('generation_verifier_stops_check_version')
    .on('generationVerifierStops').columns(['checkId', 'checkVersion']).execute()
  await db.schema.alterTable('generationRunQueue')
    .addColumn('fixId', 'text').execute()
}

export async function down(db: Kysely<unknown>) {
  await db.schema.alterTable('generationRunQueue').dropColumn('fixId').execute()
  await db.schema.dropTable('generationVerifierStops').execute()
}
