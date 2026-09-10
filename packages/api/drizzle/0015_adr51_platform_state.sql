CREATE TABLE `platform_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
