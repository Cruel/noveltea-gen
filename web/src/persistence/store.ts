import type { StudioPersistence } from './contracts'

/** Public, backend-independent Studio data store. Domain services and agent
 * workflows depend on this shape, never on the database factory/driver.
 *
 * close() may be asynchronous for remote connection pools. Owners of a store
 * must await Promise.resolve(store.close()) before releasing its resources.
 */
export interface StudioStore {
  readonly persistence: StudioPersistence
  /** Read-only validation before serving app requests; never run migrations. */
  assertReady(): Promise<void>
  close(): void | Promise<void>
}
