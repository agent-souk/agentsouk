CREATE TABLE `search_demand` (
	`day` text NOT NULL,
	`env` text NOT NULL,
	`term` text NOT NULL,
	`searches` integer DEFAULT 0 NOT NULL,
	`zero_results` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_demand_pk` ON `search_demand` (`day`,`env`,`term`);--> statement-breakpoint
CREATE INDEX `search_demand_day` ON `search_demand` (`day`);