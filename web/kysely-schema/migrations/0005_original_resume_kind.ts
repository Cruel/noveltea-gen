import type { Kysely } from 'kysely'

/** Record the exact authorized resume mechanism in the same atomic queue
 * transaction. The worker must recheck that mechanism, never substitute a
 * different recovery proof because another eligibility path became available. */
export async function up(db: Kysely<unknown>) {
  await db.schema.alterTable('generationRunQueue')
    .addColumn('resumeKind', 'text').execute()
}

export async function down(db: Kysely<unknown>) {
  await db.schema.alterTable('generationRunQueue')
    .dropColumn('resumeKind').execute()
}
