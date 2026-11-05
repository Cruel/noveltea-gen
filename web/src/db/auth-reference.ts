import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Type-only foreign-key target. Never export this table from schema.ts or
// include this file in the Drizzle Kit schema glob: Better Auth exclusively
// creates and migrates its `user` table.
export const betterAuthUser = sqliteTable('user', {
  id: text('id').primaryKey(),
})
