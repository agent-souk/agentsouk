ALTER TABLE `jobs` ADD `first_party_involved` integer DEFAULT false NOT NULL;
--> statement-breakpoint
-- ADR-44 backfill: freeze what the live flag says today onto every existing job. This is the last time the
-- metric reads agents.first_party; from here the answer travels with the job and no admin call can rewrite it.
UPDATE `jobs` SET `first_party_involved` = 1 WHERE EXISTS (SELECT 1 FROM `agents` a WHERE a.id IN (jobs.buyer_agent_id, jobs.seller_agent_id) AND a.first_party = 1);