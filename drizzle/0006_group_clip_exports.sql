ALTER TABLE `groups` ADD `can_export_clips` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Everyone could save clips before this setting existed. Keep that: make sure the built-in
-- "Everyone" group exists (only the demo seed used to create one) and let it save clips.
INSERT INTO `groups` (`id`, `name`, `default_priority`, `is_all_staff`, `provider_values`, `can_export_clips`, `created_at`, `version`)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  CASE WHEN EXISTS (SELECT 1 FROM `groups` WHERE `name` = 'Everyone') THEN 'Everybody' ELSE 'Everyone' END,
  0, 1, '[]', 1, CAST(strftime('%s', 'now') AS integer) * 1000, 1
WHERE NOT EXISTS (SELECT 1 FROM `groups` WHERE `is_all_staff` = 1);--> statement-breakpoint
UPDATE `groups` SET `can_export_clips` = 1 WHERE `is_all_staff` = 1;--> statement-breakpoint
-- The demo seed called it "All Staff"; it is now "Everyone", unless that name is taken.
UPDATE `groups` SET `name` = 'Everyone' WHERE `is_all_staff` = 1 AND `name` = 'All Staff' AND NOT EXISTS (SELECT 1 FROM `groups` WHERE `name` = 'Everyone');
