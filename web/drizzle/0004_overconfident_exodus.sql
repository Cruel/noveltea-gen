ALTER TABLE `story_thread_messages` ADD `creative_policy_json` text DEFAULT '{"version":1,"mode":"autonomous"}' NOT NULL;--> statement-breakpoint
ALTER TABLE `story_thread_messages` ADD `creative_mode_override` text;--> statement-breakpoint
ALTER TABLE `story_threads` ADD `creative_policy_json` text DEFAULT '{"version":1,"mode":"autonomous"}' NOT NULL;--> statement-breakpoint
ALTER TABLE `story_turns` ADD `creative_policy_json` text DEFAULT '{"version":1,"mode":"autonomous"}' NOT NULL;--> statement-breakpoint
-- New author Turns inherit the policy pinned when their message was enqueued,
-- never the mutable Thread preference observed when a worker finally starts.
DROP TRIGGER story_turn_from_message;--> statement-breakpoint
CREATE TRIGGER story_turn_from_message AFTER INSERT ON story_thread_messages
WHEN NEW.role='user' AND (NEW.origin_message_id IS NULL OR NEW.phase IS NOT NULL)
BEGIN
  INSERT INTO story_turns (id,owner_user_id,thread_id,creative_policy_json,created_at)
    VALUES (NEW.id,NEW.owner_user_id,NEW.thread_id,NEW.creative_policy_json,NEW.created_at);
  INSERT INTO story_turn_executions (turn_id,job_id,owner_user_id,thread_id)
    SELECT NEW.id,r.job_id,r.owner_user_id,r.thread_id FROM story_thread_runs r
    WHERE r.job_id=NEW.job_id AND r.owner_user_id=NEW.owner_user_id AND r.thread_id=NEW.thread_id;
END;
