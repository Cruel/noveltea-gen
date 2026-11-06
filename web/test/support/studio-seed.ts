import type { TestStudioDatabase } from './studio-database'
import type { TestFields } from './test-persistence'

/** Pure fixture API. Neither its input records nor return values depend on
 * a database dialect, and every operation can use a remote adapter.
 */
export function studioSeed(store: TestStudioDatabase) {
  const data = store.testing.records
  return {
    async user(id: string, at = Date.now()) {
      await store.testing.auth.createUser(id, at)
    },
    async repository(row: TestFields) {
      await data.insert('repositories', row)
    },
    async story(row: TestFields) {
      await data.insert('stories', row)
    },
    async job(row: TestFields) {
      await data.insert('studio_sessions', row)
    },
    async conversation(row: TestFields) {
      await data.insert('story_conversations', row)
    },
    async thread(row: TestFields) {
      await data.insert('story_threads', row)
    },
    async threadRun(row: TestFields) {
      await data.insert('story_thread_runs', row)
    },
    async queue(row: TestFields) {
      await data.insert('generation_run_queue', row)
    },
    async event(row: TestFields) {
      await data.insert('generation_events', row)
    },
    async message(row: TestFields) {
      await data.insert('story_thread_messages', row)
    },
  }
}
