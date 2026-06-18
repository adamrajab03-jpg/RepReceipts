-- ============================================================================
--  Civic lookup: ZIP code → your representatives
-- ----------------------------------------------------------------------------
--  Phase 8, Part 1. Two reference tables populated by db/import-civic-data.js
--  from the committed snapshots in db/data/. These are deliberately SEPARATE
--  from `members` (our curated editorial roster of people we actually track):
--    * legislators_current — the full current national roster (all 535 + the
--      non-voting delegates), used to name a user's reps even when we don't yet
--      track them. The lookup LEFT JOINs members on bioguide_id to decide
--      whether each resolved rep is "in our system".
--    * zip_districts — a ZIP(ZCTA) → congressional-district crosswalk. A ZIP
--      that straddles districts has multiple rows (all are returned).
--
--  Only GET /api/lookup/reps reads these. Re-running the importer is a full
--  TRUNCATE + reload, so the tables are pure derived data.
-- ============================================================================

CREATE TABLE IF NOT EXISTS legislators_current (
  bioguide_id text PRIMARY KEY,
  full_name   text NOT NULL,
  party       text,                                      -- 'D' | 'R' | 'I' | …
  chamber     text NOT NULL CHECK (chamber IN ('house', 'senate')),
  state       text NOT NULL,
  district    int                                        -- NULL for senators; 0 = at-large rep / delegate
);
CREATE INDEX IF NOT EXISTS ix_legislators_state          ON legislators_current (state);
CREATE INDEX IF NOT EXISTS ix_legislators_state_district ON legislators_current (state, district);

CREATE TABLE IF NOT EXISTS zip_districts (
  zip      text NOT NULL,
  state    text NOT NULL,
  district int  NOT NULL,                                -- 0 = at-large / non-voting delegate
  PRIMARY KEY (zip, state, district)
);
CREATE INDEX IF NOT EXISTS ix_zip_districts_zip ON zip_districts (zip);
