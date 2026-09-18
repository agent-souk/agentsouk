-- ADR-77: a per-unit listing may publish HOW its units are counted, so a buyer's client can compute the price
-- of its own input instead of guessing. Until now the rule lived in the listing description as prose, and the
-- x402 buy path assumed one unit; the four purchases of the only paying stranger on 2026-09-17 were declined
-- because of it. NULL keeps the old behaviour for every listing that does not declare a rule.
ALTER TABLE `listings` ADD COLUMN `unit_basis` text;
