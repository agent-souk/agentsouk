-- ADR-51 changed what a "client" is in the demand signal: since 2026-09-10 it is an agent that searched with its
-- own API key, and an anonymous search counts toward the searches and toward nobody. Rows written before that
-- carry counts made under the old rule, where an unauthenticated call from a placeable address was its own
-- client - and the upsert only ever RAISES the stored value (max(stored, new)), so those counts would have gone
-- on standing under the new sentence for the whole 30-day window.
--
-- Zeroing them withholds those terms (a term needs MIN_SEARCHERS clients to be published) rather than publishing
-- a number the text no longer describes. That is the direction ADR-36 already chose on purpose: better a voice
-- missing than a voice nobody owns. Searches and zero_results are untouched - they were always plain counts.
UPDATE `search_demand` SET `searchers` = 0 WHERE `day` <= '2026-09-10';
