import Database from 'better-sqlite3'
import { join } from 'node:path'

/** Minimal, deliberately incomplete SQLite fixture for testing the controller
 * reader in isolation; this is not the Studio application's migration schema.
 * Feature tests should not know how this fixture is stored.
 */
export function createControllerFixtureDatabase(appVolume: string, jobId: string, directory: string,
  configJson: string | null = null) {
  const db = new Database(join(appVolume, 'studio.sqlite'))
  try {
    db.exec(`CREATE TABLE studio_sessions (id TEXT, owner_user_id TEXT, story_id TEXT, source_commit_sha TEXT, generation_config_json TEXT);
      CREATE TABLE stories (id TEXT, owner_user_id TEXT, repository_id TEXT, directory TEXT);
      CREATE TABLE repositories (id TEXT, owner_user_id TEXT, provider TEXT, provider_repository_id TEXT);`)
    db.prepare('INSERT INTO repositories VALUES (?,?,?,?)').run('repo-id', 'owner-1', 'github', '987')
    db.prepare('INSERT INTO stories VALUES (?,?,?,?)').run('story-id', 'owner-1', 'repo-id', directory)
    db.prepare('INSERT INTO studio_sessions VALUES (?,?,?,?,?)').run(jobId, 'owner-1', 'story-id', 'a'.repeat(40), configJson)
  } finally {
    db.close()
  }
}

/** Mutate only the deliberately isolated controller fixture. Feature tests
 * must exercise the catalog port, not open a second raw SQLite client. */
function changeControllerFixture(appVolume: string, statement: string, ownerId?: string) {
  const db = new Database(join(appVolume, 'studio.sqlite'))
  try { db.prepare(statement).run(...(ownerId === undefined ? [] : [ownerId])) }
  finally { db.close() }
}
export function createEmptyControllerFixtureDatabase(appVolume: string) {
  const db = new Database(join(appVolume, 'studio.sqlite'))
  db.close()
}
export function changeControllerFixtureStoryOwner(appVolume: string, ownerId: string) {
  changeControllerFixture(appVolume, 'UPDATE stories SET owner_user_id=?', ownerId)
}
export function changeControllerFixtureRepositoryOwner(appVolume: string, ownerId: string) {
  changeControllerFixture(appVolume, 'UPDATE repositories SET owner_user_id=?', ownerId)
}
export function unpinControllerFixtureJob(appVolume: string) {
  changeControllerFixture(appVolume, 'UPDATE studio_sessions SET source_commit_sha=NULL')
}
export function deleteControllerFixtureJob(appVolume: string) {
  changeControllerFixture(appVolume, 'DELETE FROM studio_sessions')
}
