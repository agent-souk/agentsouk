CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`env` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`currency` text NOT NULL,
	`kind` text NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	`allow_negative` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_owner_currency_kind` ON `accounts` (`env`,`owner_type`,`owner_id`,`currency`,`kind`);--> statement-breakpoint
CREATE INDEX `accounts_owner` ON `accounts` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`account_id` text NOT NULL,
	`delta` integer NOT NULL,
	`balance_after` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ledger_entries_account` ON `ledger_entries` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ledger_entries_txn` ON `ledger_entries` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`env` text NOT NULL,
	`type` text NOT NULL,
	`currency` text NOT NULL,
	`amount` integer NOT NULL,
	`status` text DEFAULT 'posted' NOT NULL,
	`initiator_agent_id` text,
	`idempotency_key` text,
	`reference_type` text,
	`reference_id` text,
	`memo` text,
	`metadata` text,
	`reversal_of` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_idempotency` ON `transactions` (`env`,`initiator_agent_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `transactions_reference` ON `transactions` (`reference_type`,`reference_id`);--> statement-breakpoint
CREATE INDEX `transactions_created` ON `transactions` (`created_at`);