-- ============================================================================
--  Deepgram batch ingestion (Slice 1: diarization only, no attribution)
-- ----------------------------------------------------------------------------
--  Two additive CHECK swaps so the batch pipeline can label its rows. Nothing
--  is renamed — existing values ('published' etc.) are preserved.
--
--    * transcripts.source  += 'deepgram_batch'
--        A pre-recorded file/URL run through Deepgram's Nova-3 batch API, as
--        opposed to the existing 'deepgram_live' realtime stream.
--
--    * hearings.status      += 'transcribing', 'draft'
--        transcribing — batch job in flight (rows not written yet).
--        draft        — transcript exists but speakers are only auto-diarized
--                       ("Speaker N"), not yet attributed to real members.
--
--  The UNIQUE (transcript_id, seq) constraint already exists on speaker_turns
--  (migration 001), so it is intentionally NOT re-created here.
-- ============================================================================

ALTER TABLE transcripts DROP CONSTRAINT IF EXISTS transcripts_source_check;
ALTER TABLE transcripts ADD  CONSTRAINT transcripts_source_check
    CHECK (source IN ('deepgram_live','deepgram_batch','whisper','gpo_official','manual'));

ALTER TABLE hearings DROP CONSTRAINT IF EXISTS hearings_status_check;
ALTER TABLE hearings ADD  CONSTRAINT hearings_status_check
    CHECK (status IN ('scheduled','live','processing','published','transcribing','draft'));
