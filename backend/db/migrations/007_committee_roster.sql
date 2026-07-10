-- ============================================================================
--  Committee roster: real committee data foundation (for speaker attribution)
-- ----------------------------------------------------------------------------
--  Two things, run exactly ONCE (migrate.js records applied files in
--  schema_migrations and never re-runs them — so the destructive wipe below
--  can never fire again over the real roster that import-committees.js loads):
--
--    1. Schema — add committees.thomas_id, the stable external join key from
--       unitedstates/congress-legislators (e.g. 'SSCM' = Senate Committee on
--       Commerce, Science, and Transportation). UNIQUE so the importer can
--       upsert ON CONFLICT (thomas_id).
--
--    2. One-time reconciliation (DESTRUCTIVE, by design) — empty the three
--       placeholder-seed tables so the real roster can replace them. The seed
--       members carried fake bioguide_ids that cannot join real committee-
--       membership data, so they are wiped rather than reconciled.
--
--  Blast radius of the wipe (verified against the live DB before writing):
--    * committee_memberships — 6 fake rows, disposable.
--    * committees            — 3 fake rows; no subcommittees; the only hearing
--                              has committee_id NULL, so nothing is orphaned.
--    * members               — 6 placeholder rows. DELETE (not TRUNCATE) is used
--                              so FK actions are honored: approval_ratings /
--                              follows / notification_subscriptions on those
--                              members CASCADE away (the demo approval-grid data
--                              — expected to vanish), and speaker_turns.member_id
--                              is SET NULL. The one real ingested hearing's turns
--                              are already unattributed (member_id NULL), so no
--                              real transcript content is touched.
--
--  NOTE: do NOT use TRUNCATE ... CASCADE on members here — TRUNCATE CASCADE
--  would truncate speaker_turns wholesale (ignoring its ON DELETE SET NULL),
--  destroying the real hearing's turns. Plain DELETE respects SET NULL.
-- ============================================================================

ALTER TABLE committees ADD COLUMN IF NOT EXISTS thomas_id text UNIQUE;

-- One-time wipe of placeholder seed data. Order is explicit for readability;
-- the FKs (committee_memberships -> members/committees ON DELETE CASCADE) would
-- clear the memberships regardless.
DELETE FROM committee_memberships;
DELETE FROM committees;
DELETE FROM members;
