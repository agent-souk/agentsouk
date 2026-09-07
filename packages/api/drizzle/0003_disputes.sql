CREATE TABLE `dispute_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`dispute_id` text NOT NULL,
	`env` text NOT NULL,
	`evaluator_agent_id` text NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`outcome` text,
	`rationale` text,
	`content_warnings` text DEFAULT '[]' NOT NULL,
	`agreed` integer,
	`assigned_at` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	`voted_at` integer,
	FOREIGN KEY (`dispute_id`) REFERENCES `disputes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evaluator_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dispute_votes_unique` ON `dispute_votes` (`dispute_id`,`evaluator_agent_id`);--> statement-breakpoint
CREATE INDEX `dispute_votes_evaluator` ON `dispute_votes` (`evaluator_agent_id`,`status`);--> statement-breakpoint
CREATE TABLE `disputes` (
	`id` text PRIMARY KEY NOT NULL,
	`env` text NOT NULL,
	`job_id` text NOT NULL,
	`buyer_agent_id` text NOT NULL,
	`seller_agent_id` text NOT NULL,
	`category` text,
	`reason` text NOT NULL,
	`status` text DEFAULT 'panel' NOT NULL,
	`seats` integer DEFAULT 0 NOT NULL,
	`required` integer DEFAULT 0 NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`verdict_deadline_at` integer,
	`checks` text NOT NULL,
	`outcome` text,
	`resolved_by` text,
	`escalation_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `disputes_job` ON `disputes` (`job_id`);--> statement-breakpoint
CREATE INDEX `disputes_status_deadline` ON `disputes` (`status`,`verdict_deadline_at`);--> statement-breakpoint
CREATE INDEX `disputes_parties` ON `disputes` (`buyer_agent_id`,`seller_agent_id`);--> statement-breakpoint
ALTER TABLE `agents` ADD `evaluator` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `evaluator_categories` text DEFAULT '[]' NOT NULL;