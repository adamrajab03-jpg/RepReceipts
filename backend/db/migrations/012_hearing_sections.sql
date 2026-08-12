-- ============================================================================
--  HEARING SECTIONING — navigable structure over an existing transcript.
-- ----------------------------------------------------------------------------
--  A section is a RANGE over speaker_turns. Sectioning is a layer ON TOP of the
--  transcript, exactly like attribution and cleanup: nothing in this feature
--  ever writes speaker_turns.raw_text, clean_text, member_id, speaker_key,
--  attribution_status or suggestions. Detection reads turns and writes only
--  hearing_sections.
--
--  CUT-POINT MODEL
--  Each row stores only where a section STARTS (start_turn_id). Its end is
--  implicitly the turn before the next section's start, and the last section
--  runs to the end of the transcript. Sections are therefore contiguous and
--  exhaustive BY CONSTRUCTION — gaps and overlaps are not merely invalid, they
--  are unrepresentable. The four admin operations reduce to anchor arithmetic:
--    adjust boundary → UPDATE start_turn_id      merge adjacent → DELETE a row
--    split           → INSERT a row              assign unassigned → retype/DELETE
--
--  WHY start_turn_id AND NOT start_turn_seq
--  speaker_turns.seq is NOT stable: adminController renumbers it on every
--  structural edit (split does `seq = seq + 1 WHERE seq > n`, merge `seq - 1`,
--  insert `seq + 1`). Anchoring on seq would let one admin split silently shift
--  every later section boundary with nothing to detect the drift. Turn ids are
--  stable, so ordering is derived by joining to the turn's CURRENT seq.
--
--  ON DELETE RESTRICT on start_turn_id is deliberate: delete-merge must not be
--  able to orphan a section. mergeTurn re-points any section anchored on the
--  victim turn at the surviving neighbour before deleting it.
--
--  WHY transcript_id AND NOT ONLY hearing_id
--  Turn seqs are per-transcript and a hearing may hold several transcripts
--  (deepgram_live | whisper | gpo_official | manual, see `transcripts`).
--  transcript_id is the correctness key; hearing_id is denormalised so the
--  public page can fetch sections in one indexed lookup.
--
--  PROVENANCE (source)
--    'auto'  — produced by ingestion/sections.js; re-detection may replace it.
--    'human' — an admin adjusted, renamed, merged or split it. Re-detection
--              NEVER overwrites these, and never inserts a cut inside their
--              span. Same two-tier discipline as attribution and cleanup.
--  A boundary move changes the extent of TWO sections, so the admin API must
--  mark both adjacent rows 'human' — otherwise re-detection would legitimately
--  re-cut the untouched-looking neighbour and undo the move.
-- ============================================================================

CREATE TABLE hearing_sections (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    hearing_id     uuid NOT NULL REFERENCES hearings(id)    ON DELETE CASCADE,
    transcript_id  uuid NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,

    -- Ordinal position within the transcript (0-based, contiguous).
    order_index    int  NOT NULL,

    type           text NOT NULL CHECK (type IN (
                       'chair_opening',
                       'ranking_opening',
                       'witness_statement',
                       'questioning',
                       'closing',
                       'unassigned')),

    -- Display label: "Sen. Blackburn", "Gene Kimmelman", "Witness Statements".
    label          text,
    -- Set when the section's person resolved to a tracked member.
    member_id      uuid REFERENCES members(id) ON DELETE SET NULL,

    -- The first turn of this section. End = the turn before the next section.
    start_turn_id  uuid NOT NULL REFERENCES speaker_turns(id) ON DELETE RESTRICT,

    -- ── Honesty about how this boundary was arrived at ──────────────────────
    source         text NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','human')),
    confidence     numeric(4,3),   -- null for human-set sections
    method         text CHECK (method IN (
                       'recognition_chair',   -- chair bucket said "I recognize X"  (highest)
                       'recognition_other',   -- recognition from a non-chair bucket
                       'round_open',          -- speaker opened with "thank you, mister chairman"
                       'yield_back',          -- previous speaker yielded, speaker changed
                       'opening_cue',         -- "deliver his opening statement"
                       'closing_cue',         -- "before we close" / "adjourned"
                       'transcript_start',    -- the implicit first boundary
                       'inferred')),          -- everything else — always low confidence
    detection_note text,           -- why this is soft, shown to the reviewing admin

    edited_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    edited_at      timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    -- Deferrable so a whole partition can be renumbered inside one transaction
    -- (same pattern as speaker_turns_transcript_seq_uniq in migration 010).
    CONSTRAINT hearing_sections_order_uniq
        UNIQUE (transcript_id, order_index) DEFERRABLE INITIALLY IMMEDIATE,
    -- One section may start at a given turn.
    CONSTRAINT hearing_sections_anchor_uniq
        UNIQUE (transcript_id, start_turn_id)
);

CREATE INDEX hearing_sections_hearing_idx    ON hearing_sections (hearing_id, order_index);
CREATE INDEX hearing_sections_transcript_idx ON hearing_sections (transcript_id, order_index);
CREATE INDEX hearing_sections_source_idx     ON hearing_sections (transcript_id, source);
