CREATE TABLE `operator_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`env` text NOT NULL,
	`tier` text NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`results` text,
	`last_error` text,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operator_alerts_key` ON `operator_alerts` (`key`);--> statement-breakpoint
CREATE INDEX `operator_alerts_due` ON `operator_alerts` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `operator_alerts_created` ON `operator_alerts` (`created_at`);