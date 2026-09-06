CREATE TABLE `agent_memory` (
	`agent_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`size` integer NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_memory_pk` ON `agent_memory` (`agent_id`,`key`);--> statement-breakpoint
CREATE INDEX `agent_memory_expires` ON `agent_memory` (`expires_at`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`env` text NOT NULL,
	`agent_id` text NOT NULL,
	`name` text,
	`run_at` integer NOT NULL,
	`interval_seconds` integer,
	`payload` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`run_count` integer DEFAULT 0 NOT NULL,
	`max_runs` integer,
	`last_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `schedules_due` ON `schedules` (`status`,`run_at`);--> statement-breakpoint
CREATE INDEX `schedules_agent` ON `schedules` (`agent_id`);