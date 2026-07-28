-- ============================================================================
--  Speaker buckets + structural-edit groundwork
-- ----------------------------------------------------------------------------
--  1. speaker_key — the EDITABLE speaker-grouping layer.
--     speaker_label_raw stays the immutable Deepgram diarization artifact and is
--     never written again by anything after this migration. speaker_key starts
--     equal to it; per-turn reassignment moves a turn between buckets by
--     rewriting speaker_key alone. The displayed "Speaker N" ordinal is DERIVED
--     at read time (dense_rank over each bucket's first appearance by seq) and
--     never stored, so renumbering after any edit is automatic.
--
--  2. The (transcript_id, seq) uniqueness constraint becomes DEFERRABLE so
--     structural edits (split / merge / insert) can renumber a contiguous block
--     of turns with `seq = seq ± 1` inside one transaction without transient
--     collisions. Handlers run
--       SET CONSTRAINTS speaker_turns_transcript_seq_uniq DEFERRED
--     inside their txn; the constraint is still enforced at COMMIT.
-- ============================================================================

ALTER TABLE speaker_turns ADD COLUMN speaker_key text;

-- Backfill: every existing turn's bucket is its raw diarization label. The
-- COALESCE fallback (rows with a NULL raw label should not exist in practice)
-- gives any such row its own single-turn bucket rather than lumping them.
UPDATE speaker_turns SET speaker_key = COALESCE(speaker_label_raw, id::text);

ALTER TABLE speaker_turns ALTER COLUMN speaker_key SET NOT NULL;

CREATE INDEX idx_speaker_turns_key ON speaker_turns (transcript_id, speaker_key);

-- Recreate the seq uniqueness as a named, deferrable constraint.
-- (speaker_turns_transcript_id_seq_key is the auto-generated name of the inline
-- UNIQUE (transcript_id, seq) from 001_initial_schema.sql.)
ALTER TABLE speaker_turns DROP CONSTRAINT IF EXISTS speaker_turns_transcript_id_seq_key;
ALTER TABLE speaker_turns ADD CONSTRAINT speaker_turns_transcript_seq_uniq
    UNIQUE (transcript_id, seq) DEFERRABLE INITIALLY IMMEDIATE;
