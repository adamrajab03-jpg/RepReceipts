// ============================================================================
//  The PUBLIC transcript — exactly what a reader of /hearings/:id sees.
// ----------------------------------------------------------------------------
//  One definition, shared by the public transcript endpoint and by citations.
//  A citation must be snapshotted from, and re-located against, the very text
//  on the reader's page; if the two ever picked a different transcript or a
//  different set of turns, a receipt could point at words no reader can see.
//
//  Note the admin workbench edits the latest *deepgram_batch* transcript
//  (adminController.primaryTranscriptId), which is normally this one too.
// ============================================================================
const { displayableSql } = require('./turnContent');

/** The transcript the public page shows for a hearing, or null. */
async function publicTranscript(runner, hearingId) {
  const { rows } = await runner.query(`
    SELECT * FROM transcripts
     WHERE hearing_id = $1
     ORDER BY is_primary DESC, created_at DESC
     LIMIT 1
  `, [hearingId]);
  return rows[0] ?? null;
}

/**
 * Turns a reader can see: those that would display words (clean_text ??
 * raw_text non-blank — see turnContent). Only an inserted slot nobody has
 * filled in is hidden. Aliased `st` in every query that uses it.
 */
const PUBLIC_TURN_FILTER = displayableSql('st');

/** Turns with what citations need to snapshot a quote and resolve one: text,
 *  timing, origin, and the speaker as displayed. */
async function publicCitationTurns(runner, transcriptId) {
  const { rows } = await runner.query(`
    SELECT st.id, st.seq, st.raw_text, st.clean_text, st.word_times, st.start_ms, st.text_origin,
           st.member_id, st.speaker_name, st.speaker_label_raw, st.speaker_role,
           st.attribution_status,
           m.full_name AS member_full_name, m.party, m.state, m.chamber
      FROM speaker_turns st
      LEFT JOIN members m ON m.id = st.member_id
     WHERE st.transcript_id = $1 AND ${PUBLIC_TURN_FILTER}
     ORDER BY st.seq
  `, [transcriptId]);
  return rows;
}

module.exports = { publicTranscript, publicCitationTurns, PUBLIC_TURN_FILTER };
