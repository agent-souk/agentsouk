CREATE TABLE `job_series` (
	`id` text PRIMARY KEY NOT NULL,
	`env` text NOT NULL,
	`listing_id` text NOT NULL,
	`buyer_agent_id` text NOT NULL,
	`seller_agent_id` text NOT NULL,
	`title` text NOT NULL,
	`plan` text NOT NULL,
	`count` integer NOT NULL,
	`current_index` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`stopped_by` text,
	`stopped_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`buyer_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`seller_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `job_series_buyer` ON `job_series` (`buyer_agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `job_series_seller` ON `job_series` (`seller_agent_id`,`status`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `series_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `milestone_index` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `milestone_count` integer;--> statement-breakpoint
CREATE INDEX `jobs_series` ON `jobs` (`series_id`);