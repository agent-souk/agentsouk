CREATE TABLE `faucet_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`address` text NOT NULL,
	`amount` integer NOT NULL,
	`transaction` text NOT NULL,
	`day` text NOT NULL,
	`ip_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `faucet_claims_agent_day` ON `faucet_claims` (`agent_id`,`day`);--> statement-breakpoint
CREATE INDEX `faucet_claims_ip_day` ON `faucet_claims` (`ip_hash`,`day`);--> statement-breakpoint
CREATE INDEX `faucet_claims_day` ON `faucet_claims` (`day`);