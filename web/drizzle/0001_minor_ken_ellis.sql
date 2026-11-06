ALTER TABLE `story_threads` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `story_threads` ADD `deletion_complete_at` text;--> statement-breakpoint
ALTER TABLE `story_threads` ADD `deletion_plan_json` text;--> statement-breakpoint
ALTER TABLE `story_threads` ADD `deletion_bytes` integer;