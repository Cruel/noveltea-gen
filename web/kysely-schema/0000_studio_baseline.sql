-- Baseline source section 1: 0000_large_tyrannus
CREATE TABLE `checkpoint_forks` (
	`child_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`source_job_id` text NOT NULL,
	`source_base_sha` text NOT NULL,
	`commit_sha` text NOT NULL,
	`bundle_json` text NOT NULL,
	`draft_json` text NOT NULL,
	`created_at` text NOT NULL,
	`source_thread_id` text,
	`proof_digest` text,
	`guidance` text DEFAULT '' NOT NULL,
	`history_json` text,
	`edited_message_id` text,
	`edited_body` text,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_job_id`,`owner_user_id`,`source_thread_id`) REFERENCES `story_thread_runs`(`job_id`,`owner_user_id`,`thread_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `generation_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`stage` text,
	`milestone` text,
	`files_json` text DEFAULT '[]' NOT NULL,
	`status` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`,`owner_user_id`) REFERENCES `studio_sessions`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "generation_events_kind_check" CHECK("generation_events"."kind" in ('started','working','verified','finished','interrupted'))
);
--> statement-breakpoint
CREATE INDEX `generation_events_job_idx` ON `generation_events` (`owner_user_id`,`job_id`,`id`);--> statement-breakpoint
CREATE TABLE `generation_run_queue` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`intent` text NOT NULL,
	`phase` text NOT NULL,
	`worker_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`job_id`,`owner_user_id`) REFERENCES `studio_sessions`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "generation_run_queue_intent_check" CHECK("generation_run_queue"."intent" in ('start','resume')),
	CONSTRAINT "generation_run_queue_phase_check" CHECK("generation_run_queue"."phase" in ('queued','running','finished','interrupted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `generation_run_queue_job_id_unique` ON `generation_run_queue` (`job_id`);--> statement-breakpoint
CREATE INDEX `generation_run_queue_order` ON `generation_run_queue` (`phase`,`sequence`);--> statement-breakpoint
CREATE TABLE `git_connection_flows` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`provider` text NOT NULL,
	`verifier` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "git_connection_flows_provider_check" CHECK("git_connection_flows"."provider" in ('github', 'gitlab'))
);
--> statement-breakpoint
CREATE TABLE `git_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`login` text NOT NULL,
	`credentials` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`refresh_lease_id` text,
	`refresh_lease_until` integer,
	`access_expires_at` integer,
	`refresh_expires_at` integer,
	`status` text DEFAULT 'connected' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "git_connections_provider_check" CHECK("git_connections"."provider" in ('github', 'gitlab')),
	CONSTRAINT "git_connections_status_check" CHECK("git_connections"."status" in ('connected', 'reauthorize', 'disconnected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `git_connections_owner_identity` ON `git_connections` (`owner_user_id`,`provider`,`provider_account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `git_connections_owner_pair` ON `git_connections` (`id`,`owner_user_id`);--> statement-breakpoint
CREATE INDEX `git_connections_owner_idx` ON `git_connections` (`owner_user_id`,`provider`);--> statement-breakpoint
CREATE TABLE `github_install_flows` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`desired_repository` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`connection_id` text,
	FOREIGN KEY (`connection_id`) REFERENCES `git_connections`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "github_install_flows_status_check" CHECK("github_install_flows"."status" in ('started','used','pending'))
);
--> statement-breakpoint
CREATE INDEX `github_install_flows_owner` ON `github_install_flows` (`owner_user_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `github_publications` (
	`job_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`target_branch` text NOT NULL,
	`remote_branch` text NOT NULL,
	`head_sha` text NOT NULL,
	`phase` text NOT NULL,
	`pr_number` integer,
	`pr_url` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`job_id`,`owner_user_id`) REFERENCES `studio_sessions`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "github_publications_phase_check" CHECK("github_publications"."phase" in ('pending','linked'))
);
--> statement-breakpoint
CREATE TABLE `gitlab_publications` (
	`job_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`target_branch` text NOT NULL,
	`remote_branch` text NOT NULL,
	`head_sha` text NOT NULL,
	`phase` text NOT NULL,
	`mr_iid` integer,
	`mr_url` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`job_id`,`owner_user_id`) REFERENCES `studio_sessions`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "gitlab_publications_phase_check" CHECK("gitlab_publications"."phase" in ('pending','linked'))
);
--> statement-breakpoint
CREATE TABLE `pi_credentials` (
	`owner_user_id` text NOT NULL,
	`provider` text NOT NULL,
	`ciphertext` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`owner_user_id`, `provider`),
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_repository_id` text NOT NULL,
	`connection_id` text,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `git_connections`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "repositories_provider_check" CHECK("repositories"."provider" in ('github', 'gitlab'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_identity` ON `repositories` (`owner_user_id`,`provider`,`provider_repository_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_owner_pair` ON `repositories` (`id`,`owner_user_id`);--> statement-breakpoint
CREATE INDEX `repositories_owner_idx` ON `repositories` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `studio_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`story_id` text NOT NULL,
	`title` text NOT NULL,
	`source_commit_sha` text,
	`generation_request_json` text,
	`generation_thread_id` text,
	`generation_config_json` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`story_id`,`owner_user_id`) REFERENCES `stories`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "studio_sessions_status_check" CHECK("studio_sessions"."status" in ('running','paused','blocked','completed','cancelled'))
);
--> statement-breakpoint
CREATE INDEX `studio_sessions_owner_idx` ON `studio_sessions` (`owner_user_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `studio_sessions_owner_pair` ON `studio_sessions` (`id`,`owner_user_id`);--> statement-breakpoint
CREATE TABLE `stories` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`directory` text NOT NULL,
	`title` text NOT NULL,
	`created_at` text NOT NULL,
	`source_commit_sha` text,
	`initial_content_sha256` text,
	FOREIGN KEY (`repository_id`,`owner_user_id`) REFERENCES `repositories`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stories_owner_pair` ON `stories` (`id`,`owner_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `stories_directory` ON `stories` (`repository_id`,`directory`);--> statement-breakpoint
CREATE INDEX `stories_owner_idx` ON `stories` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `story_onboarding_conversations` (
	`owner_user_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`workspace` text NOT NULL,
	`revision` integer NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_user_id`, `repository_id`, `workspace`),
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`,`owner_user_id`) REFERENCES `repositories`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `story_onboarding_drafts` (
	`owner_user_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`workspace` text NOT NULL,
	`revision` integer NOT NULL,
	`draft_json` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_user_id`, `repository_id`, `workspace`),
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`,`owner_user_id`) REFERENCES `repositories`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `story_thread_message_cancellations` (
	`message_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`cancelled_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `story_thread_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`,`owner_user_id`) REFERENCES `story_threads`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `story_thread_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`body` text NOT NULL,
	`origin_message_id` text,
	`verified_commit_sha` text,
	`phase` text,
	`job_id` text,
	`source_job_id` text,
	`created_at` text NOT NULL,
	`revision_scope_json` text,
	FOREIGN KEY (`thread_id`,`owner_user_id`) REFERENCES `story_threads`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "story_thread_messages_role_check" CHECK("story_thread_messages"."role" in ('user', 'assistant')),
	CONSTRAINT "story_thread_messages_status_check" CHECK("story_thread_messages"."status" in ('delivered', 'queued')),
	CONSTRAINT "story_thread_messages_phase_check" CHECK("story_thread_messages"."phase" is null or "story_thread_messages"."phase" in ('queued','preparing','running','finished','blocked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_thread_messages_one_preparing` ON `story_thread_messages` (`thread_id`) WHERE "story_thread_messages"."role"='user' and "story_thread_messages"."phase"='preparing';--> statement-breakpoint
CREATE UNIQUE INDEX `story_thread_messages_identity` ON `story_thread_messages` (`id`,`owner_user_id`,`thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `story_thread_messages_order` ON `story_thread_messages` (`thread_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `story_thread_messages_thread_idx` ON `story_thread_messages` (`owner_user_id`,`thread_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `story_thread_preferences` (
	`owner_user_id` text NOT NULL,
	`story_id` text NOT NULL,
	`view_mode` text NOT NULL,
	`expanded_ids_json` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_user_id`, `story_id`),
	FOREIGN KEY (`story_id`,`owner_user_id`) REFERENCES `stories`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "story_thread_preferences_view_mode_check" CHECK("story_thread_preferences"."view_mode" in ('tree','flat'))
);
--> statement-breakpoint
CREATE TABLE `story_thread_runs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`run_order` integer NOT NULL,
	`needs_author` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`thread_id`,`owner_user_id`) REFERENCES `story_threads`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`,`owner_user_id`) REFERENCES `studio_sessions`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "story_thread_runs_needs_author_check" CHECK("story_thread_runs"."needs_author" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_thread_runs_order` ON `story_thread_runs` (`thread_id`,`run_order`);--> statement-breakpoint
CREATE INDEX `story_thread_runs_thread_idx` ON `story_thread_runs` (`owner_user_id`,`thread_id`,`run_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `story_thread_runs_identity` ON `story_thread_runs` (`job_id`,`owner_user_id`,`thread_id`);--> statement-breakpoint
CREATE TABLE `story_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`story_id` text NOT NULL,
	`parent_thread_id` text,
	`title` text NOT NULL,
	`activity_at` text NOT NULL,
	`archived_at` text,
	`deleted_at` text,
	`deletion_complete_at` text,
	`deletion_plan_json` text,
	`deletion_bytes` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`story_id`,`owner_user_id`) REFERENCES `stories`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_thread_id`,`owner_user_id`,`story_id`) REFERENCES `story_threads`(`id`,`owner_user_id`,`story_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "story_threads_parent_not_self" CHECK("story_threads"."parent_thread_id" is null or "story_threads"."parent_thread_id" <> "story_threads"."id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_threads_owner_pair` ON `story_threads` (`id`,`owner_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `story_threads_owner_story` ON `story_threads` (`id`,`owner_user_id`,`story_id`);--> statement-breakpoint
CREATE INDEX `story_threads_story_idx` ON `story_threads` (`owner_user_id`,`story_id`);--> statement-breakpoint
CREATE TABLE `story_turn_executions` (
	`turn_id` text NOT NULL,
	`job_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	PRIMARY KEY(`turn_id`, `job_id`),
	FOREIGN KEY (`turn_id`,`owner_user_id`,`thread_id`) REFERENCES `story_turns`(`id`,`owner_user_id`,`thread_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`,`owner_user_id`,`thread_id`) REFERENCES `story_thread_runs`(`job_id`,`owner_user_id`,`thread_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `story_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`id`,`owner_user_id`,`thread_id`) REFERENCES `story_thread_messages`(`id`,`owner_user_id`,`thread_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_turns_identity` ON `story_turns` (`id`,`owner_user_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `story_turns_thread` ON `story_turns` (`owner_user_id`,`thread_id`);--> statement-breakpoint
CREATE TABLE `thread_active_pi_turns` (
	`job_id` text PRIMARY KEY NOT NULL,
	`pi_token` text NOT NULL,
	`pi_session_id` text NOT NULL,
	`work_item` text NOT NULL,
	`created_at` text NOT NULL,
	`expected_head` text,
	FOREIGN KEY (`job_id`) REFERENCES `studio_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_active_pi_turns_pi_token_unique` ON `thread_active_pi_turns` (`pi_token`);--> statement-breakpoint
CREATE TABLE `thread_live_effect_reviews` (
	`message_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`job_id` text NOT NULL,
	`commit_sha` text NOT NULL,
	`reviewer` text NOT NULL,
	`evidence` text NOT NULL,
	`verified_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `thread_live_inputs`(`message_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `thread_live_inputs` (
	`message_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`source_job_id` text NOT NULL,
	`mode` text NOT NULL,
	`state` text NOT NULL,
	`pi_token` text,
	`pi_session_id` text,
	`delivered_at` text,
	`created_at` text NOT NULL,
	`target_pi_token` text,
	`target_work_item` text,
	`submitted_head` text,
	FOREIGN KEY (`message_id`) REFERENCES `story_thread_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`,`owner_user_id`) REFERENCES `story_threads`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_job_id`,`owner_user_id`) REFERENCES `studio_sessions`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "thread_live_inputs_mode_check" CHECK("thread_live_inputs"."mode" in ('steer','follow-up')),
	CONSTRAINT "thread_live_inputs_state_check" CHECK("thread_live_inputs"."state" in ('pending','dispatching','sdk-queued','delivered','deferred','blocked'))
);
--> statement-breakpoint
CREATE INDEX `thread_live_inputs_pending` ON `thread_live_inputs` (`source_job_id`,`state`);--> statement-breakpoint
CREATE TABLE `thread_protected_decisions` (
	`message_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`source_job_id` text NOT NULL,
	`source_sha` text NOT NULL,
	`proposal_sha256` text NOT NULL,
	`change_json` text NOT NULL,
	`nonce` text NOT NULL,
	`decision` text NOT NULL,
	`principal` text NOT NULL,
	`recorded_at` text NOT NULL,
	`consumed_sha` text,
	FOREIGN KEY (`message_id`) REFERENCES `story_thread_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`,`owner_user_id`) REFERENCES `story_threads`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_job_id`,`owner_user_id`) REFERENCES `studio_sessions`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "thread_protected_decisions_decision_check" CHECK("thread_protected_decisions"."decision" in ('approved','rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_protected_decisions_nonce_unique` ON `thread_protected_decisions` (`nonce`);--> statement-breakpoint
CREATE TABLE `thread_queued_message_edits` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`message_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`old_body` text NOT NULL,
	`new_body` text NOT NULL,
	`edited_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `story_thread_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`,`owner_user_id`) REFERENCES `story_threads`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_queued_message_edits_request_id_unique` ON `thread_queued_message_edits` (`request_id`);
--> statement-breakpoint
CREATE TABLE `thread_restarts` (
	`child_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`source_thread_id` text NOT NULL,
	`source_job_id` text NOT NULL,
	`root_job_id` text NOT NULL,
	`original_sha` text NOT NULL,
	`mode` text NOT NULL,
	`selected_sha` text NOT NULL,
	`target_branch` text,
	`draft_json` text NOT NULL,
	`created_at` text NOT NULL,
	`prepared_at` text,
	FOREIGN KEY (`source_thread_id`,`owner_user_id`) REFERENCES `story_threads`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_job_id`,`owner_user_id`) REFERENCES `studio_sessions`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "thread_restarts_mode_check" CHECK("thread_restarts"."mode" in ('original','newer'))
);
--> statement-breakpoint
CREATE INDEX `thread_restarts_owner_source` ON `thread_restarts` (`owner_user_id`,`source_thread_id`);--> statement-breakpoint
CREATE TABLE `thread_steering_checkpoint_links` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`source_job_id` text NOT NULL,
	`checkpoint_sha` text NOT NULL,
	`proof_digest` text NOT NULL,
	`work_item` text NOT NULL,
	`association` text NOT NULL,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `thread_live_inputs`(`message_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "thread_steering_checkpoint_links_association_check" CHECK("thread_steering_checkpoint_links"."association" in ('considered','verified-influence','pending-unresolved','verified-implementation'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_steering_checkpoint_links_message_sha_unique` ON `thread_steering_checkpoint_links` (`message_id`,`checkpoint_sha`);
--> statement-breakpoint
CREATE TABLE `thread_steering_intents` (
	`message_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`source_job_id` text NOT NULL,
	`disposition` text NOT NULL,
	`work_item` text,
	`considered_at` text NOT NULL,
	`checkpoint_sha` text,
	`checkpoint_proof` text,
	`review_message_id` text,
	`review_state` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `thread_live_inputs`(`message_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_message_id`) REFERENCES `story_thread_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_id`,`owner_user_id`) REFERENCES `story_threads`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_job_id`,`owner_user_id`) REFERENCES `studio_sessions`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "thread_steering_intents_disposition_check" CHECK("thread_steering_intents"."disposition" in ('within-scope','scope-review','protected-review','unresolved')),
	CONSTRAINT "thread_steering_intents_review_state_check" CHECK("thread_steering_intents"."review_state" in ('considered','pending-boundary','awaiting-review','approved-run','unresolved'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_steering_intents_review_message_id_unique` ON `thread_steering_intents` (`review_message_id`);--> statement-breakpoint
CREATE INDEX `thread_steering_intents_source` ON `thread_steering_intents` (`source_job_id`,`review_state`);--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`owner_user_id` text PRIMARY KEY NOT NULL,
	`default_model_json` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

--> statement-breakpoint
-- Baseline source section 2: 0001_story_thread_invariants
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

--> statement-breakpoint
-- Baseline source section 3: 0002_damp_next_avengers
CREATE TABLE `story_collection_memberships` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`story_id` text NOT NULL,
	`collection_id` text NOT NULL,
	FOREIGN KEY (`thread_id`,`owner_user_id`,`story_id`) REFERENCES `story_threads`(`id`,`owner_user_id`,`story_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`collection_id`,`owner_user_id`,`story_id`) REFERENCES `story_collections`(`id`,`owner_user_id`,`story_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `story_collection_memberships_collection` ON `story_collection_memberships` (`owner_user_id`,`story_id`,`collection_id`);--> statement-breakpoint
CREATE TABLE `story_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`story_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`story_id`,`owner_user_id`) REFERENCES `stories`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_collections_identity` ON `story_collections` (`id`,`owner_user_id`,`story_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `story_collections_name` ON `story_collections` (`owner_user_id`,`story_id`,`name`);--> statement-breakpoint
CREATE INDEX `story_collections_story` ON `story_collections` (`owner_user_id`,`story_id`);--> statement-breakpoint
CREATE TABLE `user_story_selection` (
	`owner_user_id` text PRIMARY KEY NOT NULL,
	`story_id` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`story_id`,`owner_user_id`) REFERENCES `stories`(`id`,`owner_user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `story_thread_preferences` ADD `collapsed_collection_ids_json` text DEFAULT '[]' NOT NULL;

--> statement-breakpoint
-- Baseline source section 4: 0003_queued_turn_isolation
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

--> statement-breakpoint
-- Baseline source section 5: 0004_overconfident_exodus
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
