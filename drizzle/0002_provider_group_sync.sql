ALTER TABLE `group_members` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `groups` ADD `provider_values` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `provider_groups` text DEFAULT '[]' NOT NULL;