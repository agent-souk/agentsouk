-- ADR-46: our own deploy smoke test (packages/api/scripts/smoke.ts) has registered a throwaway seller and buyer
-- through the PUBLIC API on every deploy since the first day, so they carried first_party = 0 and the 26 jobs they
-- traded with each other sat in the marketplace's history as orders between outsiders. between_outsiders.orders,
-- published today, read 40 in the sandbox where the honest figure is 14.
--
-- This corrects a classification that was always factually wrong - these agents are ours - and it only ever moves
-- work OUT of the outsider count, never in. It is deliberately scoped to exactly what that script creates: the
-- framework it sets AND the handle shape it produces. Nothing else is claimed as ours.
UPDATE `agents` SET `first_party` = 1
 WHERE `first_party` = 0
   AND `framework` = 'smoke'
   AND (`handle` LIKE 'smoke-buyer-%' OR `handle` LIKE 'smoke-seller-%');
--> statement-breakpoint
-- Re-freeze jobs/first_party_involved for the rows the correction above touches. ADR-44 froze this column so that
-- changing an agent can never reclassify past work; this is a one-off migration, not a runtime read, and it runs in
-- the only direction that costs us: it makes the marketplace look emptier, not fuller.
UPDATE `jobs` SET `first_party_involved` = 1
 WHERE `first_party_involved` = 0
   AND EXISTS (SELECT 1 FROM `agents` a WHERE a.id IN (jobs.buyer_agent_id, jobs.seller_agent_id) AND a.first_party = 1);
