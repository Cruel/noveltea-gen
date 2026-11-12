import type { Kysely } from 'kysely'

/** Plan amendments have their own source-bound identity. An existing Pi
 * checkpoint link may have the exact same source SHA, so the old
 * (message_id,checkpoint_sha) unique index cannot safely represent both. */
export async function up(db: Kysely<unknown>) {
  await db.schema.createTable('threadSteeringPlanAmendments')
    .addColumn('messageId', 'text', col => col.primaryKey().notNull()
      .references('threadLiveInputs.messageId').onDelete('cascade'))
    .addColumn('ownerUserId', 'text', col => col.notNull())
    .addColumn('threadId', 'text', col => col.notNull())
    .addColumn('sourceJobId', 'text', col => col.notNull())
    .addColumn('sourceSha', 'text', col => col.notNull())
    .addColumn('amendmentDigest', 'text', col => col.notNull())
    .addColumn('recordedAt', 'text', col => col.notNull())
    .execute()
  await db.schema.createIndex('thread_steering_plan_amendments_owner_job')
    .on('threadSteeringPlanAmendments').columns(['ownerUserId', 'sourceJobId']).execute()
}

export async function down(db: Kysely<unknown>) {
  await db.schema.dropTable('threadSteeringPlanAmendments').execute()
}
