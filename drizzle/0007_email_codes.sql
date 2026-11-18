CREATE TABLE `email_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`code_hash` text NOT NULL,
	`tries` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `email_codes_user` ON `email_codes` (`user_id`);--> statement-breakpoint
CREATE INDEX `email_codes_expires` ON `email_codes` (`expires_at`);--> statement-breakpoint
ALTER TABLE `local_credentials` ADD `password_allowed` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `local_credentials` ADD `code_emails` text DEFAULT '[]' NOT NULL;