import Database from 'better-sqlite3'
import { assertLegacySqliteBackend } from './backend-readiness'

/** A separately opened, read-only catalog for the rootless sandbox controller.
 * Host validation must never create or migrate the application's database.
 * This is the only raw SQLite exception outside Studio migration/auth wiring.
 */
export type TrustedControllerJobRow = {
  ownerId: string; provider: string; providerId: string; directory: string; pin: string
  configJson: string | null
}
export function readTrustedControllerJob(dbPath: string, jobId: string): TrustedControllerJobRow | null {
  assertLegacySqliteBackend()
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    return db.prepare(`SELECT s.owner_user_id AS ownerId, r.provider AS provider,
      r.provider_repository_id AS providerId, st.directory AS directory,
      s.source_commit_sha AS pin, s.generation_config_json AS configJson
      FROM studio_sessions s
      JOIN stories st ON st.id=s.story_id AND st.owner_user_id=s.owner_user_id
      JOIN repositories r ON r.id=st.repository_id AND r.owner_user_id=s.owner_user_id
      WHERE s.id=?`).get(jobId) as TrustedControllerJobRow | undefined ?? null
  } finally {
    db.close()
  }
}
