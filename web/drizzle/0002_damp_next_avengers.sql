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