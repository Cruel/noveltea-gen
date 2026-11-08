-- Controller-owned revision identities cannot be reorganized with navigation metadata.
CREATE TRIGGER story_threads_identity_immutable BEFORE UPDATE ON story_threads
WHEN NEW.id IS NOT OLD.id OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.story_id IS NOT OLD.story_id OR NEW.parent_thread_id IS NOT OLD.parent_thread_id
BEGIN SELECT RAISE(ABORT, 'Thread ancestry and ownership are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER checkpoint_forks_immutable BEFORE UPDATE ON checkpoint_forks
BEGIN SELECT RAISE(ABORT, 'Checkpoint fork receipt is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER thread_restarts_identity_immutable BEFORE UPDATE ON thread_restarts
WHEN NEW.child_id IS NOT OLD.child_id OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.source_thread_id IS NOT OLD.source_thread_id OR NEW.source_job_id IS NOT OLD.source_job_id
  OR NEW.root_job_id IS NOT OLD.root_job_id OR NEW.original_sha IS NOT OLD.original_sha
  OR NEW.mode IS NOT OLD.mode OR NEW.selected_sha IS NOT OLD.selected_sha
  OR NEW.target_branch IS NOT OLD.target_branch OR NEW.draft_json IS NOT OLD.draft_json
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.prepared_at IS NOT NULL AND NEW.prepared_at IS NOT OLD.prepared_at)
BEGIN SELECT RAISE(ABORT, 'Restart source receipt is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER story_thread_runs_story_insert BEFORE INSERT ON story_thread_runs
WHEN NOT EXISTS (SELECT 1 FROM story_threads t JOIN studio_sessions s
  ON s.story_id=t.story_id AND s.owner_user_id=t.owner_user_id
  WHERE t.id=NEW.thread_id AND t.owner_user_id=NEW.owner_user_id AND s.id=NEW.job_id)
BEGIN SELECT RAISE(ABORT, 'Execution must belong to the same owned Story as its Thread'); END;
--> statement-breakpoint
CREATE TRIGGER story_thread_fork_registration BEFORE INSERT ON story_thread_runs
WHEN NEW.run_order=0 AND EXISTS (SELECT 1 FROM story_threads WHERE id=NEW.thread_id AND parent_thread_id IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM story_threads t JOIN studio_sessions s ON s.id=NEW.job_id
    WHERE t.id=NEW.thread_id AND (
      EXISTS (SELECT 1 FROM checkpoint_forks f JOIN story_thread_runs source ON source.job_id=f.source_job_id
        WHERE f.child_id=NEW.job_id AND f.owner_user_id=NEW.owner_user_id
          AND f.source_thread_id=t.parent_thread_id AND f.commit_sha=s.source_commit_sha
          AND source.thread_id=t.parent_thread_id AND source.owner_user_id=NEW.owner_user_id
          AND length(f.proof_digest)=64)
      OR EXISTS (SELECT 1 FROM thread_restarts r
        WHERE r.child_id=NEW.job_id AND r.owner_user_id=NEW.owner_user_id
          AND r.source_thread_id=t.parent_thread_id AND r.selected_sha=s.source_commit_sha)))
BEGIN SELECT RAISE(ABORT, 'Fork requires an exact source-bound checkpoint or restart receipt'); END;
--> statement-breakpoint
CREATE TRIGGER checkpoint_forks_referenced BEFORE DELETE ON checkpoint_forks
WHEN EXISTS (SELECT 1 FROM story_thread_runs WHERE job_id=OLD.child_id)
BEGIN SELECT RAISE(ABORT, 'Registered fork receipt is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER thread_restarts_referenced BEFORE DELETE ON thread_restarts
WHEN EXISTS (SELECT 1 FROM story_thread_runs WHERE job_id=OLD.child_id)
BEGIN SELECT RAISE(ABORT, 'Registered restart receipt is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER story_thread_runs_identity_immutable BEFORE UPDATE ON story_thread_runs
WHEN NEW.job_id IS NOT OLD.job_id OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.thread_id IS NOT OLD.thread_id OR NEW.run_order IS NOT OLD.run_order
BEGIN SELECT RAISE(ABORT, 'Thread execution identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER studio_sessions_identity_immutable BEFORE UPDATE ON studio_sessions
WHEN NEW.id IS NOT OLD.id OR NEW.owner_user_id IS NOT OLD.owner_user_id OR NEW.story_id IS NOT OLD.story_id
BEGIN SELECT RAISE(ABORT, 'Execution Story and ownership are immutable'); END;
--> statement-breakpoint
-- Request identity is the author message ID, never a later Job allocation.
-- Inherited transcript entries are history, not new Turns; edited requests are Turns.
CREATE TRIGGER story_turn_from_message AFTER INSERT ON story_thread_messages
WHEN NEW.role='user' AND (NEW.origin_message_id IS NULL OR NEW.phase IS NOT NULL)
BEGIN
  INSERT INTO story_turns (id,owner_user_id,thread_id,created_at)
    VALUES (NEW.id,NEW.owner_user_id,NEW.thread_id,NEW.created_at);
  INSERT INTO story_turn_executions (turn_id,job_id,owner_user_id,thread_id)
    SELECT NEW.id,r.job_id,r.owner_user_id,r.thread_id FROM story_thread_runs r
    WHERE r.job_id=NEW.job_id AND r.owner_user_id=NEW.owner_user_id AND r.thread_id=NEW.thread_id;
END;
--> statement-breakpoint
CREATE TRIGGER story_turn_execution_admitted AFTER UPDATE OF job_id ON story_thread_messages
WHEN NEW.role='user' AND NEW.job_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO story_turn_executions (turn_id,job_id,owner_user_id,thread_id)
    SELECT t.id,r.job_id,r.owner_user_id,r.thread_id FROM story_turns t JOIN story_thread_runs r
    ON r.owner_user_id=t.owner_user_id AND r.thread_id=t.thread_id
    WHERE t.id=NEW.id AND r.job_id=NEW.job_id;
END;
--> statement-breakpoint
CREATE TRIGGER story_turn_execution_registered AFTER INSERT ON story_thread_runs
BEGIN
  INSERT OR IGNORE INTO story_turn_executions (turn_id,job_id,owner_user_id,thread_id)
    SELECT t.id,NEW.job_id,NEW.owner_user_id,NEW.thread_id FROM story_turns t
    JOIN story_thread_messages m ON m.id=t.id
    WHERE m.job_id=NEW.job_id AND t.owner_user_id=NEW.owner_user_id AND t.thread_id=NEW.thread_id;
  -- Safe recovery continues the original request in a fresh internal execution.
  -- A real fork has a different Thread, so cannot inherit these associations.
  INSERT OR IGNORE INTO story_turn_executions (turn_id,job_id,owner_user_id,thread_id)
    SELECT e.turn_id,NEW.job_id,NEW.owner_user_id,NEW.thread_id
    FROM checkpoint_forks f JOIN story_turn_executions e ON e.job_id=f.source_job_id
    WHERE f.child_id=NEW.job_id AND f.owner_user_id=NEW.owner_user_id
      AND f.source_thread_id=NEW.thread_id AND e.thread_id=NEW.thread_id
      AND e.owner_user_id=NEW.owner_user_id;
END;
--> statement-breakpoint
CREATE TRIGGER story_turn_live_execution AFTER INSERT ON thread_live_inputs
BEGIN
  -- An already admitted request may have the same execution via its job_id.
  INSERT OR IGNORE INTO story_turn_executions (turn_id,job_id,owner_user_id,thread_id)
    VALUES (NEW.message_id,NEW.source_job_id,NEW.owner_user_id,NEW.thread_id);
END;
--> statement-breakpoint
CREATE TRIGGER story_turn_identity_immutable BEFORE UPDATE ON story_turns
BEGIN SELECT RAISE(ABORT, 'Turn identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER story_turn_execution_immutable BEFORE UPDATE ON story_turn_executions
BEGIN SELECT RAISE(ABORT, 'Turn execution association is immutable'); END;
