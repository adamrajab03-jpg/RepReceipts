-- ============================================================================
--  CITATIONS — shareable quote "receipts".
-- ----------------------------------------------------------------------------
--  A reader selects a passage of testimony and shares a link (/q/:code). The
--  row written here is the RECEIPT: what was quoted, when it was said, and who
--  it was attributed to, as of the moment it was shared. Opening the link
--  re-locates that passage in the CURRENT transcript and says honestly whether
--  it still reads the same (see backend/src/utils/citationResolve.js).
--
--  THREE LAYERS PER ROW
--    Snapshot — quoted_text, prefix/suffix, speaker, trust tiers. What was
--               shared. Built by the SERVER from the database (the client
--               sends only a turn id and a char range), so a citation can never
--               carry words the transcript did not contain. Immutable.
--    Time     — anchor_start_ms/anchor_end_ms: the recording-clock times of
--               the first/last timed word inside the quote. word_times entries
--               are facts about the recording: text edits never touch them
--               (only clean_text is written) and split/merge only slice or
--               concatenate them verbatim, so the words carry their times
--               wherever structural edits move them. The primary re-location
--               anchor. Immutable.
--    Hints    — transcript_id, anchor_turn_id, char_start/char_end: where the
--               quote was. Turn ids die on merge, seq renumbers, offsets shift
--               under edits — so hints are a fast path, never trusted without
--               checking the text, and allowed to go stale (SET NULL).
--
--  APPEND-ONLY
--  A receipt must be unalterable once written — not by a reader, not by an
--  admin. The trigger below rejects any UPDATE that changes a snapshot, time or
--  speaker column. The one permitted UPDATE is a hint FK being CLEARED, because
--  ON DELETE SET NULL is itself an UPDATE (a merge deleting the quoted turn must
--  not be blocked by, or cascade into, its citations). Re-pointing a hint is
--  rejected too: a hint that has gone stale stays stale, and resolution works
--  from the snapshot. DELETE stays possible (an admin takedown), and every
--  column added later is immutable by default — the trigger compares whole rows.
--
--  WHY NOT comment_quotes
--  comment_quotes.turn_id is ON DELETE CASCADE: merging the quoted turn would
--  silently delete the quote. Right for a comment anchor, wrong for a receipt.
--
--  HEARING DELETION IS RESTRICTED
--  Deleting a hearing that has citations fails rather than silently destroying
--  receipts. ingestion/delete.js takes an explicit --with-citations to do it.
--
--  Single writer: nothing here ever writes speaker_turns. Citations are a layer
--  on top, like sections (012) and witnesses (013).
-- ============================================================================

CREATE TABLE citations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The URL id: 8 random base62 chars (~47 bits) — short enough to post, not
    -- enumerable. Generated server-side; a collision retries.
    code            text NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9]{8}$'),
    hearing_id      uuid NOT NULL REFERENCES hearings(id) ON DELETE RESTRICT,

    -- ── Hints: where it was (may go stale) ────────────────────────────────
    transcript_id   uuid REFERENCES transcripts(id)   ON DELETE SET NULL,
    anchor_turn_id  uuid REFERENCES speaker_turns(id) ON DELETE SET NULL,
    char_start      int  NOT NULL CHECK (char_start >= 0),
    char_end        int  NOT NULL,
    CHECK (char_end > char_start),

    -- ── Snapshot: what was shared ─────────────────────────────────────────
    -- Word-snapped, trimmed; exactly text.slice(char_start, char_end) of the
    -- turn's displayed text (clean_text ?? raw_text) at share time.
    quoted_text     text NOT NULL CHECK (char_length(quoted_text) BETWEEN 1 AND 1200),
    -- Up to 64 chars of that same text either side — disambiguating context for
    -- a phrase that occurs more than once ("Thank you, Mr. Chairman.").
    prefix          text NOT NULL,
    suffix          text NOT NULL,
    text_basis      text NOT NULL CHECK (text_basis IN ('clean', 'raw')),

    -- ── Time: when it was said (the clock turn.start_ms and Watch links use) ──
    anchor_start_ms int,        -- .s of the first TIMED word inside the quote
    anchor_end_ms   int,        -- .e of the last timed word inside the quote
    seek_ms         int,        -- where playback should start (before any lead-in)
    timing_basis    text NOT NULL CHECK (timing_basis IN ('word', 'nearby_word', 'turn', 'none')),
    CHECK ((anchor_start_ms IS NULL) = (anchor_end_ms IS NULL)),
    CHECK (anchor_end_ms IS NULL OR anchor_end_ms >= anchor_start_ms),

    -- ── Who was quoted, as attributed at share time ───────────────────────
    -- member_id is the foundation of a future "quotes by representative" view.
    member_id         uuid REFERENCES members(id) ON DELETE SET NULL,
    witness_id        uuid REFERENCES hearing_witnesses(id) ON DELETE SET NULL,
    speaker_name      text NOT NULL,   -- member full_name | witness name | "Speaker 2"
    speaker_label_raw text,            -- the diarization label, for unattributed speakers
    speaker_role      text,
    speaker_party     text,
    speaker_state     text,
    speaker_chamber   text,
    attribution_status text NOT NULL, -- the turn's review status then
    hearing_status     text NOT NULL, -- the hearing's trust tier then

    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,   -- NULL = shared anonymously
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_citations_hearing ON citations (hearing_id);
CREATE INDEX idx_citations_member  ON citations (member_id);
-- Merge deletes turns; without this the FK's SET NULL scans the whole table.
CREATE INDEX idx_citations_turn    ON citations (anchor_turn_id);

-- Sharing the same passage again returns the same link instead of a new row.
-- Keyed on the live turn and range PLUS the text, so re-sharing a passage after
-- it was edited is (correctly) a new citation. NULLs are distinct, so rows whose
-- anchor turn has since been deleted can never collide.
CREATE UNIQUE INDEX citations_dedupe
    ON citations (anchor_turn_id, char_start, char_end, md5(quoted_text));


-- ── Append-only enforcement ──────────────────────────────────────────────────
CREATE FUNCTION citations_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    -- The only columns an UPDATE may touch, and only by clearing them.
    hints constant text[] := ARRAY['transcript_id', 'anchor_turn_id', 'member_id', 'witness_id', 'created_by'];
    h text;
BEGIN
    IF (to_jsonb(NEW) - hints) IS DISTINCT FROM (to_jsonb(OLD) - hints) THEN
        RAISE EXCEPTION 'citations are append-only: a receipt cannot be altered once written (citation %)', OLD.code
            USING ERRCODE = 'restrict_violation';
    END IF;

    FOREACH h IN ARRAY hints LOOP
        IF (to_jsonb(NEW) -> h) IS DISTINCT FROM (to_jsonb(OLD) -> h)
           AND (to_jsonb(NEW) -> h) <> 'null'::jsonb THEN
            RAISE EXCEPTION 'citations.% may only be cleared (ON DELETE SET NULL), never re-pointed (citation %)', h, OLD.code
                USING ERRCODE = 'restrict_violation';
        END IF;
    END LOOP;

    RETURN NEW;
END $$;

CREATE TRIGGER citations_append_only
    BEFORE UPDATE ON citations
    FOR EACH ROW EXECUTE FUNCTION citations_append_only();
