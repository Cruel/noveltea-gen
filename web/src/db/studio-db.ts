import type { ColumnType } from 'kysely'
import type * as legacy from './schema'

/** Transitional, type-only schema bridge during expand–contract. No Drizzle queries
 * or repositories are used by Kysely. Replace this bridge with canonical codegen
 * after #129/#130 establish physical schema/value parity. Auth tables are excluded.
 * SQLite's boolean column is physically an integer, not Drizzle's decoded boolean.
 */
type Stored<T> = T extends boolean ? number : T
type TableShape<T> = T extends { $inferSelect: infer S; $inferInsert: infer I }
  ? { [C in keyof S]: ColumnType<Stored<S[C]>, C extends keyof I ? Stored<I[C]> : never, Stored<S[C]>> }
  : never
export type StudioDb = {
  [K in keyof typeof legacy as K extends 'sessions' ? 'studioSessions' : K]: TableShape<(typeof legacy)[K]>
}
