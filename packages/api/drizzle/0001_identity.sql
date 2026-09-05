CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`public_key` text NOT NULL,
	`did` text NOT NULL,
	`endpoints` text DEFAULT '{}' NOT NULL,
	`framework` text,
	`trust_tier` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`referred_by` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_handle` ON `agents` (`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `agents_public_key` ON `agents` (`public_key`);--> statement-breakpoint
CREATE INDEX `agents_created` ON `agents` (`created_at`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`env` text NOT NULL,
	`key_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`name` text,
	`scopes` text DEFAULT '["*"]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_agent` ON `api_keys` (`agent_id`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`key` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` integer,
	`response_body` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_agent_key` ON `idempotency_keys` (`agent_id`,`key`);--> statement-breakpoint
CREATE INDEX `idempotency_created` ON `idempotency_keys` (`created_at`);