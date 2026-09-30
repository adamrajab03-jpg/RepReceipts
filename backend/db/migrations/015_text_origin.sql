-- ============================================================================
--  TEXT ORIGIN — where a turn's words came from: the audio, or a reviewer.
-- ----------------------------------------------------------------------------
--  THE INVARIANT, RESTATED
--  raw_text is a turn's FIRST TRANSCRIPTION, whatever its source:
--    'asr'   — Deepgram's transcription of the audio (every diarized turn)
--    'human' — a reviewer's transcription, typed into an admin-inserted turn
--              that the diarization never produced
--  It is written once. After that only split/merge partition or concatenate it
--  (turnText.js), and every edit layers in clean_text exactly as before.
--
--  WHY a reviewer's text belongs in raw_text (and not as an "edit of nothing")
--  Before this migration, typing into an inserted turn stored the words as a
--  single insertion edit over raw_text = '', so clean_text held the ONLY copy.
--  Everything that reads raw_text then treated real content as absent: the
--  public page hid the turn, citations couldn't reach it, the tier-2 review
--  gate skipped it — and mergeTurn, which concatenates raw_text and resets
--  clean_text, silently DELETED the words. An inserted turn has no machine
--  original for an edit to be an edit of; what the reviewer first typed IS its
--  original transcription.
--
--  WHY RECORD THE ORIGIN
--  A passage transcribed from the audio and a passage typed by a reviewer are
--  different grades of evidence — the first is anchored to the recording word
--  by word, the second to a person's judgement. The public page says which, and
--  a citation snapshots it, so a receipt states the weight of its own words.
--  Propagation (adminController): split halves inherit their turn's origin; a
--  merge of two different origins is 'mixed'. LLM cleanup touches only 'asr'
--  turns — it exists to fix ASR errors, not to rewrite a reviewer's text.
--
--  ORDER OF OPERATIONS for an inserted-then-typed turn that DUPLICATES words
--  still present in a neighbour's raw_text (a hand-made split — e.g. seq 80 of
--  hearing 838a4b06): repair it with the workbench tools BEFORE running this
--  migration. Once its text is backfilled into raw_text below (and once merge
--  preserves every word), a delete-merge would keep the typed copy and
--  duplicate the words. Run the pre-check in the hand-off notes first.
-- ============================================================================

-- ── speaker_turns.text_origin ────────────────────────────────────────────────
-- DEFAULT 'asr': every row that exists today with text got it from ingestion or
-- from split/merge of ingested text (raw_text had no other writer), and
-- ingestion keeps inserting without naming this column. Admin inserts and
-- splits set it explicitly.
ALTER TABLE speaker_turns
    ADD COLUMN text_origin text NOT NULL DEFAULT 'asr'
        CHECK (text_origin IN ('asr', 'human', 'mixed'));

-- Admin-inserted turns are the only turns with raw_text = ''. Whatever is (or
-- will be) typed into them is a reviewer's transcription.
UPDATE speaker_turns SET text_origin = 'human' WHERE raw_text = '';

-- ── Backfill: a reviewer's words stored only in clean_text move to raw_text ──
-- For raw_text = '' every text edit is an insertion at 0 — the whole displayed
-- text IS the typed content, so it becomes the original and the edit stack is
-- cleared. text_review is kept: the reviewer did review what they typed.
DO $$
DECLARE
    moved int;
BEGIN
    UPDATE speaker_turns
       SET raw_text    = clean_text,
           clean_text  = NULL,
           is_edited   = false,
           suggestions = coalesce(suggestions, '{}'::jsonb) - 'text_edits',
           updated_at  = now()
     WHERE raw_text = ''
       AND btrim(coalesce(clean_text, '')) <> '';
    GET DIAGNOSTICS moved = ROW_COUNT;
    RAISE NOTICE '015_text_origin: moved % reviewer-typed turn(s) from clean_text to raw_text', moved;
END $$;

-- ── citations.text_origin ────────────────────────────────────────────────────
-- Snapshotted at share time: did the quoted words come from the audio or from a
-- reviewer? Existing receipts are provably 'asr' — before this migration a
-- citation required raw_text <> '', and raw_text held nothing but ASR — so the
-- column is added with that value (ADD COLUMN ... DEFAULT fills existing rows
-- without an UPDATE, so the append-only trigger is not involved), then the
-- default is dropped: every future citation must state its origin explicitly.
ALTER TABLE citations
    ADD COLUMN text_origin text NOT NULL DEFAULT 'asr'
        CHECK (text_origin IN ('asr', 'human', 'mixed'));
ALTER TABLE citations ALTER COLUMN text_origin DROP DEFAULT;
