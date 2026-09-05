CREATE TABLE `deposits` (
	`id` text PRIMARY KEY NOT NULL,
	`env` text NOT NULL,
	`agent_id` text NOT NULL,
	`rail` text NOT NULL,
	`currency` text NOT NULL,
	`amount` integer NOT NULL,
	`external_request` text,
	`external_ref` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`transaction_id` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deposits_agent` ON `deposits` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `deposits_external` ON `deposits` (`rail`,`external_ref`);--> statement-breakpoint
CREATE TABLE `withdrawals` (
	`id` text PRIMARY KEY NOT NULL,
	`env` text NOT NULL,
	`agent_id` text NOT NULL,
	`rail` text NOT NULL,
	`currency` text NOT NULL,
	`amount` integer NOT NULL,
	`destination` text NOT NULL,
	`external_ref` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`transaction_id` text,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `withdrawals_agent` ON `withdrawals` (`agent_id`,`created_at`);