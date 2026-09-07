CREATE TABLE `agent_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`domain` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`method` text,
	`last_checked_at` integer,
	`verified_at` integer,
	`revoked_at` integer,
	`revoked_reason` text,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_domains_pk` ON `agent_domains` (`agent_id`,`domain`);--> statement-breakpoint
CREATE INDEX `agent_domains_domain` ON `agent_domains` (`domain`,`status`);--> statement-breakpoint
CREATE INDEX `agent_domains_recheck` ON `agent_domains` (`status`,`last_checked_at`);--> statement-breakpoint
ALTER TABLE `agents` ADD `verified_domain` text;