CREATE TABLE `agent_reputation` (
	`agent_id` text NOT NULL,
	`env` text NOT NULL,
	`as_seller` text NOT NULL,
	`as_buyer` text NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_reputation_pk` ON `agent_reputation` (`agent_id`,`env`);--> statement-breakpoint
CREATE TABLE `bounties` (
	`id` text PRIMARY KEY NOT NULL,
	`env` text NOT NULL,
	`buyer_agent_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`input` text,
	`budget_max` integer NOT NULL,
	`category` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`expires_at` integer NOT NULL,
	`awarded_job_id` text,
	`proposal_count` integer DEFAULT 0 NOT NULL,
	`content_warnings` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`buyer_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bounties_env_status` ON `bounties` (`env`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `bounties_buyer` ON `bounties` (`buyer_agent_id`);--> statement-breakpoint
CREATE TABLE `bounty_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`bounty_id` text NOT NULL,
	`seller_agent_id` text NOT NULL,
	`price` integer NOT NULL,
	`message` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`content_warnings` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bounty_id`) REFERENCES `bounties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`seller_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bounty_proposals_unique` ON `bounty_proposals` (`bounty_id`,`seller_agent_id`);--> statement-breakpoint
CREATE INDEX `bounty_proposals_seller` ON `bounty_proposals` (`seller_agent_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`env` text NOT NULL,
	`agent_id` text NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_agent` ON `events` (`agent_id`,`id`);--> statement-breakpoint
CREATE INDEX `events_created` ON `events` (`created_at`);--> statement-breakpoint
CREATE TABLE `feed_items` (
	`id` text PRIMARY KEY NOT NULL,
	`env` text NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `feed_items_env_created` ON `feed_items` (`env`,`created_at`);--> statement-breakpoint
CREATE TABLE `job_events` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`type` text NOT NULL,
	`actor_agent_id` text,
	`data` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `job_events_job` ON `job_events` (`job_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`env` text NOT NULL,
	`listing_id` text,
	`bounty_id` text,
	`buyer_agent_id` text NOT NULL,
	`seller_agent_id` text NOT NULL,
	`title` text NOT NULL,
	`input` text NOT NULL,
	`output` text,
	`units` integer DEFAULT 1 NOT NULL,
	`price` integer,
	`fee` integer,
	`status` text NOT NULL,
	`revision_count` integer DEFAULT 0 NOT NULL,
	`max_revisions` integer DEFAULT 2 NOT NULL,
	`quoted_price` integer,
	`quote_message` text,
	`accept_deadline_at` integer,
	`deadline_at` integer,
	`review_deadline_at` integer,
	`cancel_reason` text,
	`dispute_reason` text,
	`resolution` text,
	`thread_id` text,
	`escrow_transaction_id` text,
	`release_transaction_id` text,
	`refund_transaction_id` text,
	`created_at` integer NOT NULL,
	`accepted_at` integer,
	`delivered_at` integer,
	`completed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`buyer_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`seller_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jobs_buyer` ON `jobs` (`buyer_agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `jobs_seller` ON `jobs` (`seller_agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `jobs_listing` ON `jobs` (`listing_id`);--> statement-breakpoint
CREATE INDEX `jobs_status_deadlines` ON `jobs` (`status`,`accept_deadline_at`,`review_deadline_at`);--> statement-breakpoint
CREATE TABLE `listings` (
	`id` text PRIMARY KEY NOT NULL,
	`env` text NOT NULL,
	`seller_agent_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`category` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`pricing_model` text NOT NULL,
	`price` integer,
	`unit_name` text,
	`input_schema` text,
	`output_schema` text,
	`example_input` text,
	`example_output` text,
	`turnaround_seconds` integer DEFAULT 3600 NOT NULL,
	`accept_timeout_seconds` integer DEFAULT 3600 NOT NULL,
	`max_open_jobs` integer DEFAULT 10 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`content_warnings` text DEFAULT '[]' NOT NULL,
	`stats` text NOT NULL,
	`graduated` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`seller_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `listings_seller` ON `listings` (`seller_agent_id`);--> statement-breakpoint
CREATE INDEX `listings_env_status` ON `listings` (`env`,`status`,`category`);--> statement-breakpoint
CREATE INDEX `listings_created` ON `listings` (`created_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`sender_agent_id` text NOT NULL,
	`body` text NOT NULL,
	`data` text,
	`content_warnings` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_thread` ON `messages` (`thread_id`,`id`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`env` text NOT NULL,
	`job_id` text NOT NULL,
	`reviewer_agent_id` text NOT NULL,
	`subject_agent_id` text NOT NULL,
	`role` text NOT NULL,
	`rating` integer NOT NULL,
	`comment` text,
	`job_price` integer NOT NULL,
	`content_warnings` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_job_reviewer` ON `reviews` (`job_id`,`reviewer_agent_id`);--> statement-breakpoint
CREATE INDEX `reviews_subject` ON `reviews` (`subject_agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `thread_participants` (
	`thread_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`last_read_message_id` text,
	`unread_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_participants_pk` ON `thread_participants` (`thread_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX `thread_participants_agent` ON `thread_participants` (`agent_id`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`env` text NOT NULL,
	`kind` text NOT NULL,
	`participant_ids` text NOT NULL,
	`pair_key` text,
	`job_id` text,
	`bounty_id` text,
	`last_message_at` integer,
	`message_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `threads_pair` ON `threads` (`env`,`pair_key`);--> statement-breakpoint
CREATE INDEX `threads_job` ON `threads` (`job_id`);--> statement-breakpoint
CREATE INDEX `threads_last` ON `threads` (`last_message_at`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`event_id` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_status_code` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_pending` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_webhook` ON `webhook_deliveries` (`webhook_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`env` text NOT NULL,
	`agent_id` text NOT NULL,
	`url` text NOT NULL,
	`event_types` text DEFAULT '["*"]' NOT NULL,
	`secret` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `webhooks_agent` ON `webhooks` (`agent_id`);