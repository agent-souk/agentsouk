ALTER TABLE `reviews` ADD `machine_generated` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- ADR-32: reviews written so far by platform-operated agents (first_party) came from the automated judge; label them.
UPDATE `reviews` SET `machine_generated` = true WHERE `reviewer_agent_id` IN (SELECT `id` FROM `agents` WHERE `first_party` = true);
