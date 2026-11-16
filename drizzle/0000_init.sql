CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`actor_id` text,
	`preview_subject_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`outcome` text DEFAULT 'ok' NOT NULL,
	`request_id` text,
	`ip` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_at` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_actor` ON `audit_log` (`actor_id`);--> statement-breakpoint
CREATE TABLE `camera_tags` (
	`camera_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`camera_id`, `tag_id`),
	FOREIGN KEY (`camera_id`) REFERENCES `cameras`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `camera_tags_tag` ON `camera_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `cameras` (
	`id` text PRIMARY KEY NOT NULL,
	`nvr_id` text NOT NULL,
	`protect_id` text NOT NULL,
	`name` text NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`missing_since` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cameras_nvr_protect` ON `cameras` (`nvr_id`,`protect_id`);--> statement-breakpoint
CREATE TABLE `default_views` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`user_id` text,
	`group_id` text,
	`view_id` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`view_id`) REFERENCES `views`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "default_views_scope" CHECK(("default_views"."scope" = 'org' and "default_views"."user_id" is null and "default_views"."group_id" is null) or ("default_views"."scope" = 'group' and "default_views"."group_id" is not null and "default_views"."user_id" is null) or ("default_views"."scope" in ('user','personal') and "default_views"."user_id" is not null and "default_views"."group_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `default_views_org` ON `default_views` (`scope`) WHERE "default_views"."scope" = 'org';--> statement-breakpoint
CREATE UNIQUE INDEX `default_views_group` ON `default_views` (`group_id`) WHERE "default_views"."scope" = 'group';--> statement-breakpoint
CREATE UNIQUE INDEX `default_views_user` ON `default_views` (`user_id`,`scope`) WHERE "default_views"."scope" in ('user','personal');--> statement-breakpoint
CREATE TABLE `export_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`camera_id` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`status` text NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`file_path` text,
	`error` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subject_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`camera_id`) REFERENCES `cameras`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `export_jobs_session` ON `export_jobs` (`session_id`);--> statement-breakpoint
CREATE TABLE `group_camera_grants` (
	`group_id` text NOT NULL,
	`camera_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `camera_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`camera_id`) REFERENCES `cameras`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `group_members_user` ON `group_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`default_priority` integer DEFAULT 0 NOT NULL,
	`is_all_staff` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_name` ON `groups` (`name`);--> statement-breakpoint
CREATE TABLE `login_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`nonce` text NOT NULL,
	`code_verifier` text NOT NULL,
	`return_to` text DEFAULT '/' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE TABLE `logout_token_jtis` (
	`jti` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `preview_contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ended_at` integer,
	`end_reason` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subject_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `preview_session` ON `preview_contexts` (`session_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`provider_sid` text,
	`id_token_enc` text,
	`refresh_token_enc` text,
	`csrf_secret` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`idle_expires_at` integer NOT NULL,
	`absolute_expires_at` integer NOT NULL,
	`last_validated_at` integer NOT NULL,
	`revoked_at` integer,
	`revoke_reason` text,
	`user_agent` text,
	`ip` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_sid` ON `sessions` (`provider_sid`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "tags_name_format" CHECK("tags"."name" glob '[a-z0-9]*' and "tags"."name" not glob '*[^a-z0-9_]*' and length("tags"."name") <= 40)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name` ON `tags` (`name`);--> statement-breakpoint
CREATE TABLE `user_camera_grants` (
	`user_id` text NOT NULL,
	`camera_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `camera_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`camera_id`) REFERENCES `cameras`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`email` text,
	`name` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'staff' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`allow_private_views` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_login_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "users_role" CHECK("users"."role" in ('admin','staff')),
	CONSTRAINT "users_status" CHECK("users"."status" in ('active','disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_issuer_subject` ON `users` (`issuer`,`subject`);--> statement-breakpoint
CREATE TABLE `view_cameras` (
	`view_id` text NOT NULL,
	`camera_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`view_id`, `camera_id`),
	FOREIGN KEY (`view_id`) REFERENCES `views`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`camera_id`) REFERENCES `cameras`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `view_cameras_order` ON `view_cameras` (`view_id`,`position`);--> statement-breakpoint
CREATE TABLE `view_group_shares` (
	`view_id` text NOT NULL,
	`group_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`view_id`, `group_id`),
	FOREIGN KEY (`view_id`) REFERENCES `views`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `view_predicate_tags` (
	`view_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`view_id`, `tag_id`),
	FOREIGN KEY (`view_id`) REFERENCES `views`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `view_user_shares` (
	`view_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`view_id`, `user_id`),
	FOREIGN KEY (`view_id`) REFERENCES `views`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `views` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_id` text NOT NULL,
	`visibility` text NOT NULL,
	`type` text NOT NULL,
	`columns` integer DEFAULT 3 NOT NULL,
	`shared_with_all` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "views_columns" CHECK("views"."columns" in (2,3,4)),
	CONSTRAINT "views_type" CHECK("views"."type" in ('dynamic','static')),
	CONSTRAINT "views_visibility" CHECK("views"."visibility" in ('private','curated')),
	CONSTRAINT "views_private_unshared" CHECK("views"."visibility" = 'curated' or "views"."shared_with_all" = 0)
);
--> statement-breakpoint
CREATE INDEX `views_owner` ON `views` (`owner_id`);