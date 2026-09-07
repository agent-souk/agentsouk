CREATE TABLE `discovery_hits` (
	`day` text NOT NULL,
	`surface` text NOT NULL,
	`ua_class` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `discovery_hits_pk` ON `discovery_hits` (`day`,`surface`,`ua_class`);--> statement-breakpoint
CREATE INDEX `discovery_hits_day` ON `discovery_hits` (`day`);