// ============================================================================
//  Citations — shareable quote receipts (migration 014).
//
//    POST /api/citations        create (anyone; rate-limited) → { code, url }
//    GET  /api/citations/:code  the receipt + where it is in the transcript now
//
//  Creation trusts the client for exactly two things: WHICH turn and WHICH
//  char range. Every word, every timestamp and the speaker are read from the
//  database (citationSnapshot), so an anonymous request cannot mint a receipt
//  for words the transcript never contained. The client also sends the text it
//  saw; if that no longer matches the stored turn (edited between page load and
//  click) the request is refused rather than citing text the reader never saw.
//
//  Resolution runs on every GET against the current public transcript, always
//  from the ORIGINAL snapshot (citationResolve) — nothing is cached or written,
//  so a later edit can never be baked into a receipt.
// ============================================================================
const crypto = require('crypto');
const { z } = require('zod');
const db = require('../utils/db');
const { snapshotQuote, speakerSnapshot } = require('../utils/citationSnapshot');
const { displayText, hasDisplayableText } = require('../utils/turnContent');
const { resolveCitation } = require('../utils/citationResolve');
const { publicTranscript, publicCitationTurns } = require('../utils/publicTranscript');

const createSchema = z.object({
  turn_id:       z.string().uuid(),
  char_start:    z.number().int().min(0),
  char_end:      z.number().int().min(1),
  expected_text: z.string().min(1).max(5000),
});

const CODE_RE = /^[A-Za-z0-9]{8}$/;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** 8 base62 chars from a CSPRNG (~47.6 bits): short to post, not guessable. */
const newCode = () => Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

// Columns a reader may see. created_by is deliberately absent: who shared a
// quote is not part of the receipt.
const PUBLIC_COLUMNS = `
  c.code, c.hearing_id, c.anchor_turn_id, c.char_start, c.char_end,
  c.quoted_text, c.prefix, c.suffix, c.text_basis,
  c.anchor_start_ms, c.anchor_end_ms, c.seek_ms, c.timing_basis,
  c.member_id, c.witness_id, c.speaker_name, c.speaker_label_raw, c.speaker_role,
  c.speaker_party, c.speaker_state, c.speaker_chamber,
  c.attribution_status, c.hearing_status, c.text_origin, c.created_at`;

// ── POST /api/citations ──────────────────────────────────────────────────────
async function createCitation(req, res) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { turn_id, char_start, char_end, expected_text } = parsed.data;

  const { rows: tRows } = await db.query(`
    SELECT st.*, t.hearing_id, h.status AS hearing_status,
           m.full_name AS member_full_name, m.party, m.state, m.chamber
      FROM speaker_turns st
      JOIN transcripts t ON t.id = st.transcript_id
      JOIN hearings h    ON h.id = t.hearing_id
      LEFT JOIN members m ON m.id = st.member_id
     WHERE st.id = $1
  `, [turn_id]);
  const turn = tRows[0];
  if (!turn || !hasDisplayableText(turn)) return res.status(404).json({ error: 'That passage is not in a public transcript' });

  // Only quotes readers can actually see: the turn must be in the transcript
  // the public page shows.
  const pub = await publicTranscript(db, turn.hearing_id);
  if (!pub || pub.id !== turn.transcript_id) {
    return res.status(404).json({ error: 'That passage is not in a public transcript' });
  }

  // The reader's view must still be the stored text — otherwise we would cite
  // words they never saw.
  if (displayText(turn).slice(char_start, char_end) !== expected_text) {
    return res.status(409).json({ error: 'This passage was just updated — reload the page and select it again' });
  }

  let snap;
  try {
    snap = snapshotQuote(turn, char_start, char_end);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  const speaker = speakerSnapshot(turn);

  // A witness's record, when the admin has entered one — linked the same way
  // the public page links them: by the exact speaker_name (see migration 013).
  let witnessId = null;
  if (!turn.member_id && turn.speaker_name) {
    const { rows } = await db.query(
      `SELECT id FROM hearing_witnesses WHERE hearing_id = $1 AND speaker_name = $2 ORDER BY display_order LIMIT 1`,
      [turn.hearing_id, turn.speaker_name],
    );
    witnessId = rows[0]?.id ?? null;
  }

  const values = [
    turn.hearing_id, turn.transcript_id, turn.id, snap.char_start, snap.char_end,
    snap.quoted_text, snap.prefix, snap.suffix, snap.text_basis,
    snap.anchor_start_ms, snap.anchor_end_ms, snap.seek_ms, snap.timing_basis,
    speaker.member_id, witnessId, speaker.speaker_name, speaker.speaker_label_raw, speaker.speaker_role,
    speaker.speaker_party, speaker.speaker_state, speaker.speaker_chamber,
    turn.attribution_status, turn.hearing_status, req.user?.id ?? null,
    // Audio or reviewer: the evidentiary weight of the quoted words.
    turn.text_origin,
  ];

  // Insert, or return the existing link for this exact passage (dedupe index).
  // A code collision (vanishingly rare) just retries with a fresh code.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { rows } = await db.query(`
        INSERT INTO citations (
          code, hearing_id, transcript_id, anchor_turn_id, char_start, char_end,
          quoted_text, prefix, suffix, text_basis,
          anchor_start_ms, anchor_end_ms, seek_ms, timing_basis,
          member_id, witness_id, speaker_name, speaker_label_raw, speaker_role,
          speaker_party, speaker_state, speaker_chamber,
          attribution_status, hearing_status, created_by, text_origin)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
        ON CONFLICT (anchor_turn_id, char_start, char_end, md5(quoted_text)) DO NOTHING
        RETURNING code
      `, [newCode(), ...values]);

      let code = rows[0]?.code;
      const created = !!code;
      if (!code) {
        const { rows: existing } = await db.query(`
          SELECT code FROM citations
           WHERE anchor_turn_id = $1 AND char_start = $2 AND char_end = $3 AND md5(quoted_text) = md5($4)
        `, [turn.id, snap.char_start, snap.char_end, snap.quoted_text]);
        code = existing[0].code;
      }
      return res.status(created ? 201 : 200).json({
        data: { code, url: `/q/${code}`, quoted_text: snap.quoted_text, created },
      });
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'citations_code_key') continue;
      throw err;
    }
  }
  throw new Error('Could not allocate a citation code');
}

// ── GET /api/citations/:code ─────────────────────────────────────────────────
async function getCitation(req, res) {
  const { code } = req.params;
  if (!CODE_RE.test(code)) return res.status(404).json({ error: 'No such quote link' });

  const { rows } = await db.query(`
    SELECT ${PUBLIC_COLUMNS}, h.title AS hearing_title, h.held_on AS hearing_held_on
      FROM citations c
      JOIN hearings h ON h.id = c.hearing_id
     WHERE c.code = $1
  `, [code]);
  const citation = rows[0];
  if (!citation) return res.status(404).json({ error: 'No such quote link' });

  const transcript = await publicTranscript(db, citation.hearing_id);
  const turns = transcript ? await publicCitationTurns(db, transcript.id) : [];
  const resolution = resolveCitation(citation, turns);

  res.json({ data: { citation, resolution } });
}

module.exports = { createCitation, getCitation };
