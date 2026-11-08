-- An author follow-up is a new Thread Turn, not an execution of the
-- specialist that happened to be active when the author queued it.
-- Only live steering is causally associated with the active Pi execution.
DROP TRIGGER IF EXISTS story_turn_live_execution;
--> statement-breakpoint
CREATE TRIGGER story_turn_live_execution AFTER INSERT ON thread_live_inputs
WHEN NEW.mode='steer'
BEGIN
  INSERT OR IGNORE INTO story_turn_executions (turn_id,job_id,owner_user_id,thread_id)
    VALUES (NEW.message_id,NEW.source_job_id,NEW.owner_user_id,NEW.thread_id);
END;
