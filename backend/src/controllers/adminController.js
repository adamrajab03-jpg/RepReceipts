const crypto = require('crypto');
const db = require('../utils/db');
const { splitAtWord, splitAtChar, mergeTexts, meanConfidence } = require('../utils/turnText');
const { classifyEdit, applyEdits, isBulkAcceptable, anchorEdit, normalizeSpanWhitespace, spanLimits } = require('../utils/cleanupValidate');
const { composeEdits } = require('../utils/textDiff');
const { detectSections, loadSectionTurns, writeSections, turnsFingerprint, assertTiling } = require('../utils/sectionDetect');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const spansOverlap = (a, b) => a.raw_start < b.raw_end && b.raw_start < a.raw_end;

// clean_text is ALWAYS derived from the applied text_edits — never free-stored.
// null when there are no edits (public read falls back to raw_text via COALESCE).
function deriveCleanText(rawText, textEdits) {
  if (!Array.isArray(textEdits) || !textEdits.length) return null;
  return applyEdits(rawText, textEdits); // throws on overlap / non-reconstruction
}

async function loadTurn(runner, transcriptId, turnId) {
  const { rows } = await runner.query(
    `SELECT id, raw_text, suggestions FROM speaker_turns WHERE id = $1 AND transcript_id = $2`,
    [turnId, transcriptId]
  );
  return rows[0] ?? null;
}

// Persist a turn's derived text state in one UPDATE. clean_text is recomputed
// from textEdits (never trusted from the client). Always stamps text_review —
// touching the text IS reviewing it. Pass cleanup=undefined to leave it as-is.
async function persistTurnText(runner, turn, { textEdits, cleanup, reviewedBy }) {
  const clean = deriveCleanText(turn.raw_text, textEdits);
  const sugg = { ...(turn.suggestions || {}) };
  if (Array.isArray(textEdits) && textEdits.length) sugg.text_edits = textEdits;
  else delete sugg.text_edits;
  if (cleanup !== undefined) { if (cleanup) sugg.cleanup = cleanup; else delete sugg.cleanup; }
  sugg.text_review = { reviewed_at: new Date().toISOString(), by: reviewedBy ?? null };
  await runner.query(
    `UPDATE speaker_turns
        SET clean_text = $2, is_edited = $3, edited_by = $4, suggestions = $5::jsonb, updated_at = now()
      WHERE id = $1`,
    [turn.id, clean, Array.isArray(textEdits) && textEdits.length > 0, reviewedBy ?? null, JSON.stringify(sugg)]
  );
}

// ============================================================================
//  Admin: attribution review, structural editing + two-tier publish.
// ----------------------------------------------------------------------------
//  SPEAKER BUCKETS — speaker_key is the editable grouping layer; every
//  speaker-level operation scopes by it. speaker_label_raw is the immutable
//  Deepgram diarization artifact and is NEVER written here. Per-turn
//  reassignment MOVES a turn between buckets (rewrites speaker_key + copies the
//  bucket's identity), so an individual fix is structurally isolated from bulk
//  actions on the old bucket — no write-guard needed. Bucket identity is kept
//  uniform: a per-turn identity decision always resolves to a bucket (an
//  existing one with that exact identity, else a fresh `manual-*` bucket).
//
//  ORDINALS — the displayed "Speaker N" is derived at read time (dense_rank
//  over each bucket's first appearance by seq) and never stored, so
//  renumbering after any edit is automatic and cannot drift.
//
//  STRUCTURE — split/merge/insert hold a hard no-lost-word invariant: splits
//  are exact string partitions and merges exact concatenations (see
//  utils/turnText.js), asserted server-side before commit. word_times arrays
//  are only sliced/concatenated, never rebuilt. Seq renumbering relies on the
//  deferrable speaker_turns_transcript_seq_uniq constraint (migration 010).
//
//  Trust tiers live on hearings.status: draft → attributed → verified. Any
//  identity or structural edit on a verified hearing demotes it back to
//  'attributed' (surfaced as `demoted: true`) so we never silently over-claim.
//
//  suggestions jsonb keys per turn:
//    attribution   — LLM speaker suggestion (written by ingestion/attribute.js)
//    turn_override — provenance of a per-turn move (badge + reset affordance)
//    structural    — last structural op on this turn (split/merge/insert),
//                    incl. the recorded joiner (split) and seam_offset (merge)
// ============================================================================

const ORDINALS_SQL = `
  SELECT speaker_key, dense_rank() OVER (ORDER BY min(seq))::int AS speaker_ordinal
    FROM speaker_turns
   WHERE transcript_id = $1
   GROUP BY speaker_key`;

async function primaryTranscriptId(runner, hearingId) {
  const { rows } = await runner.query(
    `SELECT id FROM transcripts
      WHERE hearing_id = $1 AND source = 'deepgram_batch'
      ORDER BY is_primary DESC, created_at DESC
      LIMIT 1`,
    [hearingId]
  );
  return rows[0]?.id ?? null;
}

// members is the tracked roster. role (chair|ranking_member|member) sets speaker_role.
async function loadRoster(runner) {
  const { rows } = await runner.query(`
    SELECT m.id, m.full_name, m.party, m.state, m.bioguide_id,
           (SELECT cm.role FROM committee_memberships cm
             WHERE cm.member_id = m.id
             ORDER BY cm.congress DESC NULLS LAST
             LIMIT 1) AS role
      FROM members m
     ORDER BY m.full_name
  `);
  return rows;
}

function roleForMember(committeeRole) {
  return committeeRole === 'chair' ? 'chair' : 'member';
}

// Validate a member id against the tracked roster; returns its speaker_role or null.
async function rosterRole(runner, memberId) {
  const { rows } = await runner.query(
    `SELECT (SELECT cm.role FROM committee_memberships cm
              WHERE cm.member_id = m.id ORDER BY cm.congress DESC NULLS LAST LIMIT 1) AS role
       FROM members m WHERE m.id = $1`,
    [memberId]
  );
  return rows.length ? roleForMember(rows[0].role) : null;
}

// Accepting the suggestion as-is → 'attributed'; changing it → 'edited'. No
// suggestion to accept → 'edited' (a purely manual attribution).
function statusFor(applied, suggestion) {
  const s = suggestion?.suggested_identity;
  if (!s) return 'edited';
  if (applied.type !== s.type) return 'edited';
  if (applied.type === 'member')  return applied.member_id === s.member_id ? 'attributed' : 'edited';
  if (applied.type === 'witness') {
    const a = (applied.speaker_name || '').trim().toLowerCase();
    const b = (s.display_name || '').trim().toLowerCase();
    return a && a === b ? 'attributed' : 'edited';
  }
  return 'attributed'; // both unknown
}

// Apply one identity to every turn of a bucket. Bucket membership IS the
// scoping — moved-in turns follow their new bucket's changes. Caller owns txn.
async function applyToSpeaker(runner, transcriptId, speakerKey, applied, status) {
  const memberId    = applied.type === 'member'  ? applied.member_id   : null;
  const speakerName = applied.type === 'witness' ? applied.speaker_name : null;
  const role        = applied.type === 'member'  ? applied.role
                    : applied.type === 'witness' ? 'witness'
                    : 'unknown';
  const { rowCount } = await runner.query(
    `UPDATE speaker_turns
        SET member_id = $3, speaker_name = $4, speaker_role = $5, attribution_status = $6
      WHERE transcript_id = $1 AND speaker_key = $2`,
    [transcriptId, speakerKey, memberId, speakerName, role, status]
  );
  return rowCount;
}

// Editing a verified hearing returns it to 'attributed' — the safe
// under-claiming direction. Returns true when a demotion actually happened.
async function maybeDemote(runner, hearingId) {
  const { rows } = await runner.query(
    `UPDATE hearings SET status = 'attributed' WHERE id = $1 AND status = 'verified' RETURNING id`,
    [hearingId]
  );
  return rows.length > 0;
}

// A bucket's current identity, read from its earliest turn (identity is
// uniform across a bucket by construction). Null when the bucket is empty.
async function bucketRep(runner, transcriptId, speakerKey) {
  const { rows } = await runner.query(
    `SELECT member_id, speaker_name, speaker_role, attribution_status
       FROM speaker_turns
      WHERE transcript_id = $1 AND speaker_key = $2
      ORDER BY seq LIMIT 1`,
    [transcriptId, speakerKey]
  );
  return rows[0] ?? null;
}

// Joining a pending bucket keeps the turn pending (acceptAll will fill it with
// the rest of the bucket); joining an identified bucket is a human edit.
function joinStatus(rep) {
  return rep.attribution_status === 'unverified' ? 'unverified' : 'edited';
}

function newSpeakerKey() {
  return `manual-${crypto.randomBytes(4).toString('hex')}`;
}

// Resolve a per-turn identity decision to a bucket, keeping bucket identity
// uniform. Reuses the earliest-appearing bucket that already has this exact
// identity; 'unknown' and new_speaker always get a fresh bucket (two unknown
// voices are not the same person).
async function resolveIdentityBucket(runner, transcriptId, decision, memberId, witnessName, forceNew) {
  if (!forceNew) {
    let match = null;
    if (decision === 'member') {
      match = await runner.query(
        `SELECT speaker_key FROM speaker_turns
          WHERE transcript_id = $1 AND member_id = $2
          GROUP BY speaker_key ORDER BY min(seq) LIMIT 1`,
        [transcriptId, memberId]
      );
    } else if (decision === 'witness') {
      match = await runner.query(
        `SELECT speaker_key FROM speaker_turns
          WHERE transcript_id = $1 AND speaker_role = 'witness' AND speaker_name = $2
          GROUP BY speaker_key ORDER BY min(seq) LIMIT 1`,
        [transcriptId, witnessName]
      );
    }
    if (match?.rows.length) return match.rows[0].speaker_key;
  }
  return newSpeakerKey();
}

function overrideMarker(fields) {
  return JSON.stringify({ ...fields, at: new Date().toISOString() });
}

// ── GET /api/admin/hearings ─────────────────────────────────────────────────
async function listAdminHearings(_req, res) {
  try {
    const { rows } = await db.query(`
      SELECT
        h.id, h.title, h.status, h.held_on, h.created_at,
        c.name AS committee_name,
        count(st.id)::int AS turn_count,
        count(DISTINCT st.speaker_key)::int AS speaker_count,
        count(DISTINCT st.speaker_key)
          FILTER (WHERE st.attribution_status = 'unverified')::int AS pending_count
      FROM hearings h
      LEFT JOIN committees c    ON c.id = h.committee_id
      LEFT JOIN transcripts t   ON t.hearing_id = h.id AND t.source = 'deepgram_batch'
      LEFT JOIN speaker_turns st ON st.transcript_id = t.id
      GROUP BY h.id, c.name
      ORDER BY h.created_at DESC
    `);
    const data = rows.map((r) => ({ ...r, reviewed_count: r.speaker_count - r.pending_count }));
    res.json({ data, count: data.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── GET /api/admin/hearings/:id/review ──────────────────────────────────────
//  Full chronological transcript + roster. speaker_ordinal is the derived
//  "Speaker N" (appearance order of buckets); word_times feed the split UI.
async function getReview(req, res) {
  try {
    const { rows: hRows } = await db.query(
      `SELECT h.id, h.title, h.status, h.held_on, h.committee_id, c.name AS committee_name
         FROM hearings h
         LEFT JOIN committees c ON c.id = h.committee_id
        WHERE h.id = $1`,
      [req.params.id]
    );
    if (!hRows.length) return res.status(404).json({ error: 'Hearing not found' });

    const transcriptId = await primaryTranscriptId(db, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No deepgram_batch transcript for this hearing' });

    const { rows: turns } = await db.query(`
      SELECT
        st.id, st.seq, st.start_ms, st.speaker_label_raw, st.speaker_key,
        f.speaker_ordinal,
        st.member_id, st.speaker_name, st.speaker_role, st.attribution_status,
        st.raw_text, st.clean_text, st.word_times,
        m.full_name AS member_full_name,
        st.suggestions -> 'attribution' AS suggestion,
        (st.suggestions ? 'turn_override') AS pinned,
        st.suggestions -> 'structural' AS structural,
        st.suggestions -> 'cleanup' AS cleanup,
        st.suggestions -> 'text_edits' AS text_edits,
        (st.suggestions ? 'text_review') AS text_reviewed
      FROM speaker_turns st
      JOIN (${ORDINALS_SQL}) f ON f.speaker_key = st.speaker_key
      LEFT JOIN members m ON m.id = st.member_id
      WHERE st.transcript_id = $1
      ORDER BY st.seq
    `, [transcriptId]);

    const roster = await loadRoster(db);
    // Sectioning is optional: a hearing that has never been through the
    // detection pass simply has none, and the workbench renders as before.
    const sections = await loadSections(db, transcriptId).catch(() => []);

    res.json({ data: { hearing: hRows[0], transcript_id: transcriptId, roster, turns, sections } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── PATCH /api/admin/hearings/:id/speakers ──────────────────────────────────
//  Attribute (or correct) every turn of one bucket.
async function applySpeaker(req, res) {
  const { speaker_key, decision, member_id, witness_name } = req.body || {};
  if (!speaker_key || !['member', 'witness', 'unknown'].includes(decision)) {
    return res.status(400).json({ error: 'speaker_key and a valid decision (member|witness|unknown) are required' });
  }

  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No deepgram_batch transcript for this hearing' });

    let applied;
    if (decision === 'member') {
      if (!member_id) return res.status(400).json({ error: 'member_id is required for a member decision' });
      const role = await rosterRole(client, member_id);
      if (!role) return res.status(400).json({ error: 'member_id is not a tracked roster member' });
      applied = { type: 'member', member_id, role };
    } else if (decision === 'witness') {
      const name = (witness_name || '').trim();
      if (!name) return res.status(400).json({ error: 'witness_name is required for a witness decision' });
      applied = { type: 'witness', speaker_name: name };
    } else {
      applied = { type: 'unknown' };
    }

    // The representative suggestion comes from HOME turns only (raw label =
    // key), so a moved-in turn's foreign suggestion can't decide accepted-vs-
    // edited for this bucket.
    const { rows: sug } = await client.query(
      `SELECT suggestions -> 'attribution' AS attribution
         FROM speaker_turns
        WHERE transcript_id = $1 AND speaker_key = $2
          AND speaker_key = speaker_label_raw AND suggestions ? 'attribution'
        LIMIT 1`,
      [transcriptId, speaker_key]
    );
    const status = statusFor(applied, sug[0]?.attribution);

    await client.query('BEGIN');
    const updated = await applyToSpeaker(client, transcriptId, speaker_key, applied, status);
    const demoted = updated ? await maybeDemote(client, req.params.id) : false;
    await client.query('COMMIT');

    if (!updated) return res.status(404).json({ error: 'No turns matched that speaker' });
    res.json({ data: { speaker_key, attribution_status: status, turns_updated: updated, demoted } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

// ── PATCH /api/admin/hearings/:id/turns/:turnId ─────────────────────────────
//  Move ONE turn to another bucket (the per-turn reassign). Payloads:
//    { target_speaker_key }                      join an existing bucket
//    { decision, member_id|witness_name,
//      new_speaker? }                            resolve/create a bucket
//    { decision: 'reset' }                       return to the home bucket
async function overrideTurn(req, res) {
  const { decision, member_id, witness_name, target_speaker_key, new_speaker } = req.body || {};
  const hasTarget = typeof target_speaker_key === 'string' && target_speaker_key.length > 0;
  if (!hasTarget && !['member', 'witness', 'unknown', 'reset'].includes(decision)) {
    return res.status(400).json({ error: 'Provide target_speaker_key or decision (member|witness|unknown|reset)' });
  }

  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No deepgram_batch transcript for this hearing' });

    const { rows: tRows } = await client.query(
      `SELECT id, speaker_label_raw, speaker_key FROM speaker_turns
        WHERE id = $1 AND transcript_id = $2`,
      [req.params.turnId, transcriptId]
    );
    if (!tRows.length) return res.status(404).json({ error: 'Turn not found in this hearing' });
    const turn = tRows[0];

    await client.query('BEGIN');

    if (!hasTarget && decision === 'reset') {
      // Return to the home bucket (raw label) and re-inherit its identity.
      if (!turn.speaker_label_raw) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'This turn has no diarization label to reset to' });
      }
      const { rows: sib } = await client.query(
        `SELECT member_id, speaker_name, speaker_role, attribution_status
           FROM speaker_turns
          WHERE transcript_id = $1 AND speaker_key = $2 AND id <> $3
            AND NOT (suggestions ? 'turn_override')
          LIMIT 1`,
        [transcriptId, turn.speaker_label_raw, turn.id]
      );
      const s = sib[0] || { member_id: null, speaker_name: null, speaker_role: null, attribution_status: 'unverified' };
      await client.query(
        `UPDATE speaker_turns
            SET speaker_key = speaker_label_raw,
                member_id = $2, speaker_name = $3, speaker_role = $4, attribution_status = $5,
                suggestions = suggestions - 'turn_override'
          WHERE id = $1`,
        [turn.id, s.member_id, s.speaker_name, s.speaker_role, s.attribution_status]
      );
    } else {
      let key, identity, status;
      if (hasTarget) {
        const rep = await bucketRep(client, transcriptId, target_speaker_key);
        if (!rep) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'target_speaker_key does not exist in this transcript' });
        }
        key = target_speaker_key;
        identity = rep;
        status = joinStatus(rep);
      } else {
        let memberId = null, speakerName = null, role;
        if (decision === 'member') {
          if (!member_id) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'member_id is required' }); }
          role = await rosterRole(client, member_id);
          if (!role) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'member_id is not a tracked roster member' }); }
          memberId = member_id;
        } else if (decision === 'witness') {
          speakerName = (witness_name || '').trim();
          if (!speakerName) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'witness_name is required' }); }
          role = 'witness';
        } else {
          role = 'unknown';
        }
        key = await resolveIdentityBucket(client, transcriptId, decision, memberId, speakerName,
          new_speaker === true || decision === 'unknown');
        identity = { member_id: memberId, speaker_name: speakerName, speaker_role: role };
        status = 'edited';
      }

      const marker = overrideMarker({
        moved_from: turn.speaker_key,
        target_speaker_key: key,
        decision: hasTarget ? 'existing' : decision,
      });
      await client.query(
        `UPDATE speaker_turns
            SET speaker_key = $2, member_id = $3, speaker_name = $4, speaker_role = $5,
                attribution_status = $6,
                suggestions = jsonb_set(coalesce(suggestions, '{}'::jsonb), '{turn_override}', $7::jsonb, true)
          WHERE id = $1`,
        [turn.id, key, identity.member_id, identity.speaker_name, identity.speaker_role, status, marker]
      );
    }

    const demoted = await maybeDemote(client, req.params.id);
    await client.query('COMMIT');

    res.json({ data: { turn_id: turn.id, demoted } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

// ── POST /api/admin/hearings/:id/accept-all ─────────────────────────────────
//  Fill every pending bucket's suggestion in one shot: still-unverified turns
//  only — never overwrites prior work. Suggestions are read from home turns.
async function acceptAll(req, res) {
  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No deepgram_batch transcript for this hearing' });

    const { rows: speakers } = await client.query(`
      SELECT st.speaker_key AS key,
             (array_agg(st.suggestions -> 'attribution')
                FILTER (WHERE st.suggestions ? 'attribution'
                          AND st.speaker_key = st.speaker_label_raw))[1] AS suggestion
        FROM speaker_turns st
       WHERE st.transcript_id = $1
       GROUP BY st.speaker_key
    `, [transcriptId]);
    const { rows: ordRows } = await client.query(ORDINALS_SQL, [transcriptId]);
    const labelOf = new Map(ordRows.map((r) => [r.speaker_key, `Speaker ${r.speaker_ordinal}`]));

    const roster = await loadRoster(client);
    const roleById = new Map(roster.map((m) => [m.id, roleForMember(m.role)]));

    const applied = [];
    const skipped = [];

    await client.query('BEGIN');
    for (const s of speakers) {
      const label = labelOf.get(s.key) ?? s.key;
      const sug = s.suggestion?.suggested_identity;
      if (!sug) { skipped.push({ label, reason: 'no_suggestion' }); continue; }

      let identity;
      if (sug.type === 'member') {
        if (!sug.member_id || !roleById.has(sug.member_id)) {
          skipped.push({ label, reason: 'suggested_member_not_in_roster' });
          continue;
        }
        identity = { type: 'member', member_id: sug.member_id, role: roleById.get(sug.member_id) };
      } else if (sug.type === 'witness') {
        if (!sug.display_name) { skipped.push({ label, reason: 'witness_without_name' }); continue; }
        identity = { type: 'witness', speaker_name: sug.display_name };
      } else {
        identity = { type: 'unknown' };
      }

      // Only fill still-pending (unverified) turns; accepting a suggestion → 'attributed'.
      const { rowCount } = await client.query(
        `UPDATE speaker_turns
            SET member_id = $3, speaker_name = $4, speaker_role = $5, attribution_status = 'attributed'
          WHERE transcript_id = $1 AND speaker_key = $2 AND attribution_status = 'unverified'`,
        [
          transcriptId, s.key,
          identity.type === 'member' ? identity.member_id : null,
          identity.type === 'witness' ? identity.speaker_name : null,
          identity.type === 'member' ? identity.role : identity.type === 'witness' ? 'witness' : 'unknown',
        ]
      );
      if (rowCount > 0) applied.push({ label, type: identity.type, turns: rowCount });
    }
    const demoted = applied.length ? await maybeDemote(client, req.params.id) : false;
    await client.query('COMMIT');

    res.json({ data: { applied_count: applied.length, applied, skipped, demoted } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

// ── POST /api/admin/hearings/:id/turns/:turnId/split ────────────────────────
//  Cut one turn into two at a word boundary. The two halves plus the recorded
//  joiner are exact complementary slices of raw_text (asserted, never
//  assumed); word_times are partitioned as arrays. Half B's bucket comes from
//  `assign`: inherit (default) | existing bucket | new speaker.
async function splitTurn(req, res) {
  const { word_index, char_offset } = req.body || {};
  const assign = req.body?.assign || { mode: 'inherit' };
  if (!['inherit', 'existing', 'new'].includes(assign.mode)) {
    return res.status(400).json({ error: "assign.mode must be inherit|existing|new" });
  }

  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No deepgram_batch transcript for this hearing' });

    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS speaker_turns_transcript_seq_uniq DEFERRED');

    const { rows: tRows } = await client.query(
      `SELECT * FROM speaker_turns WHERE id = $1 AND transcript_id = $2 FOR UPDATE`,
      [req.params.turnId, transcriptId]
    );
    if (!tRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Turn not found in this hearing' }); }
    const orig = tRows[0];

    // Partition. Throws { status, message } on any violation — nothing written.
    let part;
    try {
      if (Array.isArray(orig.word_times) && orig.word_times.length) {
        // A timed turn must split at a word boundary — a char split would
        // orphan its word_times and silently lose timing.
        if (!Number.isInteger(word_index)) throw { status: 400, message: 'word_index is required for a timed turn' };
        part = splitAtWord(orig.raw_text, orig.word_times, word_index);
      } else if (Number.isInteger(char_offset)) {
        part = splitAtChar(orig.raw_text, char_offset);
      } else {
        throw { status: 400, message: 'char_offset is required for an untimed turn' };
      }
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    }
    const { textA, joiner, textB, wtA, wtB } = part;

    // Resolve half B's bucket + identity.
    let bKey, bIdentity, bStatus, bMarker = null;
    if (assign.mode === 'inherit') {
      bKey = orig.speaker_key;
      bIdentity = { member_id: orig.member_id, speaker_name: orig.speaker_name, speaker_role: orig.speaker_role };
      bStatus = orig.attribution_status;
    } else if (assign.mode === 'existing') {
      const rep = await bucketRep(client, transcriptId, assign.speaker_key);
      if (!rep) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'assign.speaker_key does not exist in this transcript' }); }
      bKey = assign.speaker_key;
      bIdentity = rep;
      bStatus = joinStatus(rep);
      bMarker = overrideMarker({ moved_from: orig.speaker_key, target_speaker_key: bKey, decision: 'existing' });
    } else {
      let memberId = null, speakerName = null, role = null;
      if (assign.decision === 'member') {
        role = await rosterRole(client, assign.member_id);
        if (!role) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'assign.member_id is not a tracked roster member' }); }
        memberId = assign.member_id;
      } else if (assign.decision === 'witness') {
        speakerName = (assign.witness_name || '').trim();
        if (!speakerName) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'assign.witness_name is required' }); }
        role = 'witness';
      } else if (assign.decision === 'unknown') {
        role = 'unknown';
      } // no decision → unidentified new speaker, stays pending
      bKey = newSpeakerKey();
      bIdentity = { member_id: memberId, speaker_name: speakerName, speaker_role: role };
      bStatus = assign.decision ? 'edited' : 'unverified';
      bMarker = overrideMarker({ moved_from: orig.speaker_key, target_speaker_key: bKey, decision: assign.decision ?? 'new' });
    }

    // Make room, insert half B, then stamp both structural markers.
    await client.query(
      `UPDATE speaker_turns SET seq = seq + 1 WHERE transcript_id = $1 AND seq > $2`,
      [transcriptId, orig.seq]
    );

    const bSuggestions = {};
    if (assign.mode === 'inherit' && orig.suggestions?.attribution) bSuggestions.attribution = orig.suggestions.attribution;
    if (bMarker) bSuggestions.turn_override = JSON.parse(bMarker);
    bSuggestions.structural = { op: 'split', sibling: orig.id, joiner, at: new Date().toISOString() };

    const { rows: bRows } = await client.query(
      `INSERT INTO speaker_turns
         (transcript_id, seq, speaker_label_raw, speaker_key, start_ms, end_ms,
          confidence, attribution_status, raw_text, word_times, suggestions,
          member_id, speaker_name, speaker_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14)
       RETURNING id`,
      [
        transcriptId, orig.seq + 1, orig.speaker_label_raw, bKey,
        wtB ? wtB[0].s : null, orig.end_ms,
        meanConfidence(wtB) ?? (wtB ? null : orig.confidence),
        bStatus, textB, wtB ? JSON.stringify(wtB) : null, JSON.stringify(bSuggestions),
        bIdentity.member_id, bIdentity.speaker_name, bIdentity.speaker_role,
      ]
    );
    const newId = bRows[0].id;

    await client.query(
      `UPDATE speaker_turns
          SET raw_text = $2, word_times = $3::jsonb, end_ms = $4, confidence = $5,
              clean_text = NULL,
              suggestions = jsonb_set(coalesce(suggestions, '{}'::jsonb) - 'cleanup' - 'text_edits', '{structural}', $6::jsonb, true)
        WHERE id = $1`,
      [
        orig.id, textA, wtA ? JSON.stringify(wtA) : null,
        // Untimed split: half A's true end time is unknown (the cut is mid-turn).
        wtA ? wtA[wtA.length - 1].e : null,
        meanConfidence(wtA) ?? (wtA ? null : orig.confidence),
        JSON.stringify({ op: 'split', sibling: newId, joiner, at: new Date().toISOString() }),
      ]
    );

    const demoted = await maybeDemote(client, req.params.id);
    await client.query('COMMIT');

    res.json({ data: { turn_id: orig.id, new_turn_id: newId, demoted } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

// ── POST /api/admin/hearings/:id/turns/:turnId/merge ────────────────────────
//  Delete-a-turn-without-losing-a-word: the victim's text merges into the
//  adjacent turn ('up' = previous, default; 'down' = next). The surviving turn
//  keeps ITS identity; a seam marker records where the absorbed text begins.
async function mergeTurn(req, res) {
  const direction = req.body?.direction ?? 'up';
  if (!['up', 'down'].includes(direction)) {
    return res.status(400).json({ error: "direction must be 'up' or 'down'" });
  }

  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No deepgram_batch transcript for this hearing' });

    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS speaker_turns_transcript_seq_uniq DEFERRED');

    const { rows: vRows } = await client.query(
      `SELECT * FROM speaker_turns WHERE id = $1 AND transcript_id = $2 FOR UPDATE`,
      [req.params.turnId, transcriptId]
    );
    if (!vRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Turn not found in this hearing' }); }
    const victim = vRows[0];

    const targetSeq = direction === 'up' ? victim.seq - 1 : victim.seq + 1;
    const { rows: gRows } = await client.query(
      `SELECT * FROM speaker_turns WHERE transcript_id = $1 AND seq = $2 FOR UPDATE`,
      [transcriptId, targetSeq]
    );
    if (!gRows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: direction === 'up'
          ? 'No previous turn to merge into — use direction "down" for the first turn'
          : 'No next turn to merge into — use direction "up" for the last turn',
      });
    }
    const target = gRows[0];

    // Reading order: first + joiner + second.
    const first  = direction === 'up' ? target : victim;
    const second = direction === 'up' ? victim : target;

    // Re-merging split siblings uses the recorded joiner → byte-identical
    // round trip. Otherwise the canonical single space (ingestion's own
    // boundary), omitted when either side is empty.
    const sibJoiner =
      (victim.suggestions?.structural?.op === 'split' && victim.suggestions.structural.sibling === target.id)
        ? victim.suggestions.structural.joiner
        : (target.suggestions?.structural?.op === 'split' && target.suggestions.structural.sibling === victim.id)
          ? target.suggestions.structural.joiner
          : ' ';
    const { merged, joinerUsed, seamOffset } = mergeTexts(first.raw_text, second.raw_text, sibJoiner);

    // word_times: concat in reading order. An empty-text side contributes
    // nothing; a non-empty side with missing word_times poisons the merge
    // (timing can no longer be trusted) → NULL + warning, text untouched.
    let mergedWt, wtLost = false;
    const firstWt  = first.raw_text.length  ? first.word_times  : [];
    const secondWt = second.raw_text.length ? second.word_times : [];
    if (firstWt === null || secondWt === null) {
      mergedWt = null;
      wtLost = (first.raw_text.length && Array.isArray(first.word_times)) ||
               (second.raw_text.length && Array.isArray(second.word_times));
    } else {
      mergedWt = [...firstWt, ...secondWt];
      if (!mergedWt.length) mergedWt = null;
    }

    const structural = {
      op: 'merge',
      at: new Date().toISOString(),
      seam_offset: seamOffset,
      absorbed_side: direction === 'up' ? 'after' : 'before',
      absorbed_key: victim.speaker_key,
      absorbed_distinct: victim.speaker_key !== target.speaker_key,
      absorbed_name: null,
    };
    if (victim.member_id) {
      const { rows: mRows } = await client.query(`SELECT full_name FROM members WHERE id = $1`, [victim.member_id]);
      structural.absorbed_name = mRows[0]?.full_name ?? null;
    } else if (victim.speaker_name) {
      structural.absorbed_name = victim.speaker_name;
    }

    await client.query(
      `UPDATE speaker_turns
          SET raw_text = $2, word_times = $3::jsonb, clean_text = NULL,
              start_ms = $4, end_ms = $5, confidence = $6, attribution_status = 'edited',
              suggestions = jsonb_set(coalesce(suggestions, '{}'::jsonb) - 'cleanup' - 'text_edits', '{structural}', $7::jsonb, true)
        WHERE id = $1`,
      [
        target.id, merged, mergedWt ? JSON.stringify(mergedWt) : null,
        first.start_ms ?? second.start_ms, second.end_ms ?? first.end_ms,
        meanConfidence(mergedWt) ?? target.confidence,
        JSON.stringify(structural),
      ]
    );
    // A section may be anchored on the turn we are about to delete. Its words
    // survive inside `target`, so the section survives too — re-point it there
    // rather than letting ON DELETE RESTRICT block the merge. If that would
    // collide with the section already anchored on `target`, drop the duplicate
    // anchor (two sections cannot start at the same turn).
    await client.query(
      `DELETE FROM hearing_sections
        WHERE start_turn_id = $1
          AND EXISTS (SELECT 1 FROM hearing_sections o
                       WHERE o.transcript_id = hearing_sections.transcript_id
                         AND o.start_turn_id = $2)`,
      [victim.id, target.id]
    );
    await client.query(
      `UPDATE hearing_sections SET start_turn_id = $2, updated_at = now() WHERE start_turn_id = $1`,
      [victim.id, target.id]
    );
    await client.query(`DELETE FROM speaker_turns WHERE id = $1`, [victim.id]);
    await client.query(
      `UPDATE speaker_turns SET seq = seq - 1 WHERE transcript_id = $1 AND seq > $2`,
      [transcriptId, victim.seq]
    );

    const demoted = await maybeDemote(client, req.params.id);
    await client.query('COMMIT');

    res.json({ data: { merged_into: target.id, deleted_turn_id: victim.id, word_times_lost: !!wtLost, demoted } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

// ── POST /api/admin/hearings/:id/turns/:turnId/insert ───────────────────────
//  Insert a blank turn before/after the anchor. It gets a fresh, pending
//  bucket (blocks tier promotion until identified) and empty text — filling
//  in words is the next slice's content editing.
async function insertTurn(req, res) {
  const position = req.body?.position;
  if (!['before', 'after'].includes(position)) {
    return res.status(400).json({ error: "position must be 'before' or 'after'" });
  }

  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No deepgram_batch transcript for this hearing' });

    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS speaker_turns_transcript_seq_uniq DEFERRED');

    const { rows: aRows } = await client.query(
      `SELECT id, seq FROM speaker_turns WHERE id = $1 AND transcript_id = $2 FOR UPDATE`,
      [req.params.turnId, transcriptId]
    );
    if (!aRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Turn not found in this hearing' }); }

    const newSeq = position === 'before' ? aRows[0].seq : aRows[0].seq + 1;
    await client.query(
      `UPDATE speaker_turns SET seq = seq + 1 WHERE transcript_id = $1 AND seq >= $2`,
      [transcriptId, newSeq]
    );

    const { rows: nRows } = await client.query(
      `INSERT INTO speaker_turns
         (transcript_id, seq, speaker_key, attribution_status, raw_text, suggestions)
       VALUES ($1, $2, $3, 'unverified', '', $4::jsonb)
       RETURNING id`,
      [transcriptId, newSeq, newSpeakerKey(),
       JSON.stringify({ structural: { op: 'insert', at: new Date().toISOString() } })]
    );

    const demoted = await maybeDemote(client, req.params.id);
    await client.query('COMMIT');

    res.json({ data: { new_turn_id: nRows[0].id, demoted } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

// ── POST /api/admin/hearings/:id/turns/:turnId/cleanup/accept ───────────────
//  Accept one LLM proposal ({ edit_id }) or all auto-safe ones ({ all_safe }).
//  RE-VALIDATES against the current raw_text and never trusts the stored class:
//  a stale (raw_text changed) or blocked edit is refused, so nothing that would
//  change a substantive word can reach clean_text.
async function acceptCleanup(req, res) {
  const { edit_id, all_safe } = req.body || {};
  if (!edit_id && all_safe !== true) {
    return res.status(400).json({ error: 'Provide edit_id or all_safe: true' });
  }

  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No deepgram_batch transcript for this hearing' });
    const turn = await loadTurn(client, transcriptId, req.params.turnId);
    if (!turn) return res.status(404).json({ error: 'Turn not found in this hearing' });

    const cleanup = turn.suggestions?.cleanup;
    if (!cleanup || !Array.isArray(cleanup.edits) || !cleanup.edits.length) {
      return res.status(400).json({ error: 'No cleanup proposals on this turn' });
    }
    if (cleanup.raw_text_sha256 && cleanup.raw_text_sha256 !== sha256(turn.raw_text)) {
      return res.status(409).json({ error: 'Cleanup proposals are stale (raw_text changed) — re-run the cleanup stage' });
    }

    let targets;
    if (all_safe === true) {
      targets = cleanup.edits.filter((e) => e.status === 'proposed' && isBulkAcceptable(e.class));
    } else {
      const e = cleanup.edits.find((x) => x.id === edit_id);
      if (!e) return res.status(404).json({ error: 'Proposal not found on this turn' });
      if (e.status !== 'proposed') return res.status(409).json({ error: `Proposal already ${e.status}` });
      if (e.class === 'rejected') return res.status(422).json({ error: `This edit was blocked by the validator (${e.reject_reason}) and cannot be accepted` });
      targets = [e];
    }

    const textEdits = Array.isArray(turn.suggestions?.text_edits) ? [...turn.suggestions.text_edits] : [];
    let accepted = 0;
    for (const e of targets) {
      // Re-anchor by the stored `original` substring against the CURRENT
      // raw_text — the numeric offset is only a hint. Unique match → apply
      // there; gone or ambiguous → refuse cleanly, never guess a position.
      const anchor = anchorEdit(turn.raw_text, e);
      if (!anchor) {
        if (all_safe === true) continue;
        return res.status(409).json({ error: 'This proposal no longer matches the current text — re-run cleanup' });
      }
      // Re-validate against the anchored span — never trust the stored class.
      const c = classifyEdit(e.original, e.replacement);
      if (c.class === 'rejected') {
        if (all_safe === true) continue;
        return res.status(422).json({ error: `Re-validation blocked this edit: ${c.reason}` });
      }
      if (all_safe === true && !isBulkAcceptable(c.class)) continue;
      // Re-derive the span's whitespace geometry before it can reach clean_text.
      // Where a model put the surrounding spaces — inside the span or outside —
      // is arbitrary, and taking it verbatim is what merges words ("thebill") or
      // doubles a space. Growth is bounded by the neighbouring applied edits, so
      // this can never create an overlap.
      const span = normalizeSpanWhitespace(turn.raw_text, { ...anchor, replacement: e.replacement }, spanLimits(textEdits, anchor));
      // cleanup_edit_id ties the applied edit back to its proposal, so an undo
      // finds it by identity rather than by geometry — normalising the span
      // above means the two no longer have to match character for character.
      if (span && !textEdits.some((t) => t.raw_start === span.raw_start && t.raw_end === span.raw_end)) {
        textEdits.push({ source: 'llm', cleanup_edit_id: e.id, raw_start: span.raw_start, raw_end: span.raw_end, original: span.original, replacement: span.replacement, class: c.class, at: new Date().toISOString() });
      }
      // A span that normalises away (the model only re-framed whitespace) still
      // leaves the queue — it was reviewed, it just changes nothing.
      e.status = 'accepted';
      accepted++;
    }

    if (!accepted) return res.json({ data: { accepted: 0, demoted: false } });

    await client.query('BEGIN');
    try {
      await persistTurnText(client, turn, { textEdits, cleanup, reviewedBy: req.user?.id });
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Edits overlap or do not reconstruct: ${err.message}` });
    }
    const demoted = await maybeDemote(client, req.params.id);
    await client.query('COMMIT');
    res.json({ data: { accepted, demoted } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

// ── POST /api/admin/hearings/:id/turns/:turnId/cleanup/reject ────────────────
//  Reject a proposal; revert its span to raw_text if it had been applied.
//  Dismissal is RECOVERABLE, never destructive: the proposal object stays in
//  suggestions.cleanup with status 'rejected' plus a `dismissed` stamp (who /
//  when), so it drops out of the active queue but can be restored verbatim.
//  Nothing is ever spliced out of cleanup.edits.
//
//  Two modes:
//    { edit_id }          dismiss one proposal. If that proposal had previously
//                         been accepted, its applied text_edit is also removed
//                         (un-apply), which is the point of a single-edit undo.
//    { all_pending: true } dismiss every still-`proposed` edit on the turn.
//                         text_edits is passed through UNTOUCHED, so already-
//                         accepted edits are structurally out of reach.
async function rejectCleanup(req, res) {
  const { edit_id, all_pending } = req.body || {};
  if (!edit_id && all_pending !== true) {
    return res.status(400).json({ error: 'Provide edit_id or all_pending: true' });
  }

  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No deepgram_batch transcript for this hearing' });
    const turn = await loadTurn(client, transcriptId, req.params.turnId);
    if (!turn) return res.status(404).json({ error: 'Turn not found in this hearing' });

    const cleanup = turn.suggestions?.cleanup;
    if (!cleanup || !Array.isArray(cleanup.edits)) return res.status(400).json({ error: 'No cleanup proposals on this turn' });

    const existingEdits = Array.isArray(turn.suggestions?.text_edits) ? turn.suggestions.text_edits : [];
    const stamp = { at: new Date().toISOString(), by: req.user?.id ?? null };
    let textEdits = existingEdits;
    let dismissed = 0;

    if (all_pending === true) {
      // Pending only — an accepted edit is never in this set, and text_edits is
      // not rebuilt at all, so bulk dismissal cannot disturb applied text.
      for (const e of cleanup.edits) {
        if (e.status !== 'proposed') continue;
        e.status = 'rejected';
        e.dismissed = stamp;
        dismissed++;
      }
      if (!dismissed) return res.json({ data: { dismissed: 0, demoted: false } });
    } else {
      const e = cleanup.edits.find((x) => x.id === edit_id);
      if (!e) return res.status(404).json({ error: 'Proposal not found on this turn' });
      if (e.status === 'rejected') return res.json({ data: { dismissed: 0, demoted: false } }); // already dismissed
      e.status = 'rejected';
      e.dismissed = stamp;
      dismissed = 1;
      // Un-apply by identity when the applied edit carries its proposal's id,
      // falling back to the span/replacement match for edits applied before that
      // stamp existed. Identity is the reliable link: accept normalises the
      // span's whitespace, so an applied edit need not be geometrically equal to
      // the proposal it came from.
      textEdits = existingEdits.filter((t) => {
        if (t.source !== 'llm') return true;
        if (t.cleanup_edit_id) return t.cleanup_edit_id !== e.id;
        return !(t.raw_start === e.raw_start && t.raw_end === e.raw_end && t.replacement === e.replacement);
      });
    }

    await client.query('BEGIN');
    await persistTurnText(client, turn, { textEdits, cleanup, reviewedBy: req.user?.id });
    const demoted = await maybeDemote(client, req.params.id);
    await client.query('COMMIT');
    res.json({ data: { dismissed, demoted } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

// ── POST /api/admin/hearings/:id/turns/:turnId/cleanup/restore ───────────────
//  Undo a dismissal: put a dismissed proposal back in the pending queue. Only
//  `rejected` (dismissed) edits are restorable — `accepted` is already applied
//  and `superseded` was overwritten by a human edit, so resurrecting either
//  would contradict the current text. The `dismissed` stamp is KEPT alongside a
//  `restored` stamp, so the round trip stays auditable.
async function restoreCleanup(req, res) {
  const { edit_id } = req.body || {};
  if (!edit_id) return res.status(400).json({ error: 'edit_id is required' });

  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No deepgram_batch transcript for this hearing' });
    const turn = await loadTurn(client, transcriptId, req.params.turnId);
    if (!turn) return res.status(404).json({ error: 'Turn not found in this hearing' });

    const cleanup = turn.suggestions?.cleanup;
    if (!cleanup || !Array.isArray(cleanup.edits)) return res.status(400).json({ error: 'No cleanup proposals on this turn' });
    const e = cleanup.edits.find((x) => x.id === edit_id);
    if (!e) return res.status(404).json({ error: 'Proposal not found on this turn' });
    if (e.status !== 'rejected') return res.status(409).json({ error: `Only a dismissed suggestion can be restored (this one is ${e.status})` });

    e.status = 'proposed';
    e.restored = { at: new Date().toISOString(), by: req.user?.id ?? null };

    // text_edits is untouched: restoring only re-queues a suggestion, it never
    // changes the turn's text. Accepting it afterwards re-validates as usual.
    const textEdits = Array.isArray(turn.suggestions?.text_edits) ? turn.suggestions.text_edits : [];

    await client.query('BEGIN');
    await persistTurnText(client, turn, { textEdits, cleanup, reviewedBy: req.user?.id });
    const demoted = await maybeDemote(client, req.params.id);
    await client.query('COMMIT');
    res.json({ data: { restored: 1, demoted } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

// ============================================================================
//  SECTIONS — navigable structure over the transcript.
// ----------------------------------------------------------------------------
//  A section is a RANGE, stored as a cut point: only its START turn is kept and
//  its end is implicitly the turn before the next section's start. Gaps and
//  overlaps are therefore unrepresentable, and the four editing operations are
//  anchor arithmetic. NOTHING in here writes speaker_turns — no text, no
//  attribution, no speaker_key. Ordering always comes from the anchor turn's
//  CURRENT seq, never from a stored seq, because structural edits renumber seq.
//
//  Every edit here stamps source='human', which makes re-detection leave the
//  section (and its span) alone. A boundary move changes the extent of TWO
//  sections, so BOTH are stamped — otherwise re-detection would legitimately
//  re-cut the neighbour and undo the move.
// ============================================================================
const SECTION_TYPES = ['chair_opening', 'ranking_opening', 'witness_statement', 'questioning', 'closing', 'unassigned'];

/** Sections with derived start/end seq, ordered by the anchor's live position. */
async function loadSections(runner, transcriptId) {
  const { rows } = await runner.query(`
    SELECT hs.id, hs.order_index, hs.type, hs.label, hs.member_id, hs.start_turn_id,
           hs.source, hs.confidence, hs.method, hs.detection_note, hs.edited_at,
           st.seq AS start_seq,
           lead(st.seq) OVER (ORDER BY st.seq) AS next_seq,
           m.full_name AS member_full_name
      FROM hearing_sections hs
      JOIN speaker_turns st ON st.id = hs.start_turn_id
      LEFT JOIN members m ON m.id = hs.member_id
     WHERE hs.transcript_id = $1
     ORDER BY st.seq`, [transcriptId]);
  const { rows: last } = await runner.query(
    `SELECT max(seq) AS max_seq FROM speaker_turns WHERE transcript_id = $1`, [transcriptId]);
  const maxSeq = last[0]?.max_seq ?? 0;
  return rows.map((r, i) => ({
    ...r,
    order_index: i,
    end_seq: r.next_seq != null ? r.next_seq - 1 : maxSeq,
  }));
}

/** order_index follows the anchors' live seq order. Caller owns the transaction. */
async function renumberSections(runner, transcriptId) {
  await runner.query('SET CONSTRAINTS hearing_sections_order_uniq DEFERRED');
  await runner.query(`
    WITH ordered AS (
      SELECT hs.id, (row_number() OVER (ORDER BY st.seq) - 1)::int AS ord
        FROM hearing_sections hs
        JOIN speaker_turns st ON st.id = hs.start_turn_id
       WHERE hs.transcript_id = $1)
    UPDATE hearing_sections h SET order_index = o.ord, updated_at = now()
      FROM ordered o WHERE h.id = o.id AND h.order_index IS DISTINCT FROM o.ord`, [transcriptId]);
}

// Tiling enforcement lives in utils/sectionDetect (assertTiling) so the admin
// endpoints and the CLI share ONE implementation. It is called inside each
// transaction immediately before COMMIT: a multi-step operation is free to pass
// through intermediate states and is validated once, whole. Anything that would
// leave a gap, an overlap, or a turn belonging to no section throws and rolls
// the edit back — the same discipline as the no-word-loss turn invariant.
const assertContiguousTiling = assertTiling;

const stampHuman = (runner, id, userId) => runner.query(
  `UPDATE hearing_sections
      SET source = 'human', confidence = NULL, edited_by = $2, edited_at = now(), updated_at = now()
    WHERE id = $1`, [id, userId ?? null]);

/** Fetch one section (with derived range) and assert it belongs to this hearing. */
async function sectionInHearing(runner, hearingId, sectionId) {
  const transcriptId = await primaryTranscriptId(runner, hearingId);
  if (!transcriptId) return { error: [404, 'No transcript for this hearing'] };
  const all = await loadSections(runner, transcriptId);
  const idx = all.findIndex((s) => s.id === sectionId);
  if (idx < 0) return { error: [404, 'Section not found on this hearing'] };
  return { transcriptId, all, idx, section: all[idx] };
}

// ── PATCH /api/admin/hearings/:id/sections/:sectionId ────────────────────────
//  Rename and/or retype. This is how an opening block gets carved up: set a
//  section's type to ranking_opening or witness_statement and give it a label.
async function updateSection(req, res) {
  const { label, type, member_id } = req.body || {};
  if (label === undefined && type === undefined && member_id === undefined) {
    return res.status(400).json({ error: 'Provide label, type, or member_id' });
  }
  if (type !== undefined && !SECTION_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${SECTION_TYPES.join(', ')}` });
  }
  const client = await db.connect();
  try {
    const found = await sectionInHearing(client, req.params.id, req.params.sectionId);
    if (found.error) return res.status(found.error[0]).json({ error: found.error[1] });

    await client.query('BEGIN');
    const sets = [];
    const vals = [req.params.sectionId];
    if (label !== undefined) { vals.push(label === '' ? null : label); sets.push(`label = $${vals.length}`); }
    if (type !== undefined) { vals.push(type); sets.push(`type = $${vals.length}`); }
    if (member_id !== undefined) { vals.push(member_id || null); sets.push(`member_id = $${vals.length}`); }
    await client.query(`UPDATE hearing_sections SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
    await stampHuman(client, req.params.sectionId, req.user?.id);
    await assertContiguousTiling(client, found.transcriptId);
    await client.query('COMMIT');

    res.json({ data: { sections: await loadSections(client, found.transcriptId) } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.tiling) return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally { client.release(); }
}

// ── POST /api/admin/hearings/:id/sections/split-at-turn ──────────────────────
//  "New section starting here." The containing section is resolved SERVER-side
//  from the turn, so a stale client list can never split the wrong section.
//  Turns before the split stay put; turns from it onward become a new section
//  for the admin to label. Splitting AT a section's own first turn is a no-op,
//  not an error — that turn already begins a section.
async function splitSectionAtTurn(req, res) {
  const { turn_id, type, label } = req.body || {};
  if (!turn_id) return res.status(400).json({ error: 'turn_id is required' });
  if (type !== undefined && !SECTION_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${SECTION_TYPES.join(', ')}` });
  }

  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No transcript for this hearing' });

    const { rows: t } = await client.query(
      `SELECT id, seq FROM speaker_turns WHERE id = $1 AND transcript_id = $2`, [turn_id, transcriptId]);
    if (!t.length) return res.status(404).json({ error: 'That turn is not in this transcript' });
    const seq = t[0].seq;

    const all = await loadSections(client, transcriptId);
    if (!all.length) return res.status(409).json({ error: 'This hearing has no sections yet — run detection first' });

    const container = all.find((s) => seq >= s.start_seq && seq <= s.end_seq);
    if (!container) return res.status(409).json({ error: 'No section covers that turn' });
    if (container.start_seq === seq) {
      // Already a boundary. Nothing to do, and nothing to complain about.
      return res.json({ data: { noop: true, section_id: container.id, sections: all } });
    }

    await client.query('BEGIN');
    const { rows: ins } = await client.query(
      `INSERT INTO hearing_sections
         (hearing_id, transcript_id, order_index, type, label, start_turn_id, source, edited_by, edited_at)
       VALUES ($1,$2,$3,$4,$5,$6,'human',$7, now()) RETURNING id`,
      [req.params.id, transcriptId, 9999, type ?? container.type, label ?? null, turn_id, req.user?.id ?? null]);
    await stampHuman(client, container.id, req.user?.id); // it was shortened
    await renumberSections(client, transcriptId);
    await assertContiguousTiling(client, transcriptId);
    await client.query('COMMIT');

    res.json({ data: { noop: false, new_section_id: ins[0].id, sections: await loadSections(client, transcriptId) } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.tiling) return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally { client.release(); }
}

// ── PATCH /api/admin/hearings/:id/sections/:sectionId/boundary ───────────────
//  MOVE a boundary. A boundary IS a section's start_turn_id, so this is a
//  single-row UPDATE: the section above re-derives its end ("the turn before the
//  next section"), which means there is no intermediate state in which a gap
//  could exist and no second write to get wrong.
//
//  This is the operation merge could never express. Merge deletes a section and
//  lets the neighbour's LABEL annex its turns — which is how "Sean Davis" came
//  to span 26 turns. Dragging moves the line without changing who owns what.
//
//  CLAMP: the new start must land strictly between the neighbouring anchors —
//  after the previous section's first turn (so IT keeps a turn) and no later
//  than this section's current last turn (so THIS one keeps a turn). The client
//  clamps the handle to the same window; this is the authority, and
//  assertTiling is the backstop behind both.
async function moveSectionBoundary(req, res) {
  const { start_turn_id } = req.body || {};
  if (!start_turn_id) return res.status(400).json({ error: 'start_turn_id is required' });

  const client = await db.connect();
  try {
    const found = await sectionInHearing(client, req.params.id, req.params.sectionId);
    if (found.error) return res.status(found.error[0]).json({ error: found.error[1] });
    const { transcriptId, all, idx, section } = found;
    if (idx === 0) {
      return res.status(409).json({ error: 'The first section starts the transcript — it has no boundary to move' });
    }
    const prev = all[idx - 1];

    const { rows: t } = await client.query(
      `SELECT id, seq FROM speaker_turns WHERE id = $1 AND transcript_id = $2`, [start_turn_id, transcriptId]);
    if (!t.length) return res.status(404).json({ error: 'That turn is not in this transcript' });
    const newSeq = t[0].seq;

    const min = prev.start_seq + 1;   // leaves the section ABOVE at least one turn
    const max = section.end_seq;      // leaves THIS section at least one turn
    if (newSeq < min || newSeq > max) {
      return res.status(409).json({
        error: `Boundary must land between turns ${min} and ${max} — dragging further would leave a section with no turns`,
        legal_range: [min, max],
      });
    }
    if (newSeq === section.start_seq) {
      return res.json({ data: { moved: false, sections: all } }); // dropped where it started
    }

    await client.query('BEGIN');
    await client.query(`UPDATE hearing_sections SET start_turn_id = $2, updated_at = now() WHERE id = $1`,
      [req.params.sectionId, start_turn_id]);
    // A boundary move changes TWO extents, so both sides are human-edited and
    // re-detect must leave both alone.
    await stampHuman(client, req.params.sectionId, req.user?.id);
    await stampHuman(client, prev.id, req.user?.id);
    await renumberSections(client, transcriptId);
    await assertContiguousTiling(client, transcriptId);
    await client.query('COMMIT');

    res.json({ data: { moved: true, from_seq: section.start_seq, to_seq: newSeq, sections: await loadSections(client, transcriptId) } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.tiling) return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally { client.release(); }
}

// ── DELETE /api/admin/hearings/:id/sections/:sectionId ───────────────────────
//  REMOVE a boundary. Deleting a cut point extends the section above through it,
//  so this section's turns fold upward and take that section's name. Always
//  upward — removing a cut point has exactly one meaning, and the UI states the
//  consequence before doing it.
//
//  The first section is not a boundary (it is the transcript's start) and
//  therefore cannot be deleted.
async function deleteSection(req, res) {
  const client = await db.connect();
  try {
    const found = await sectionInHearing(client, req.params.id, req.params.sectionId);
    if (found.error) return res.status(found.error[0]).json({ error: found.error[1] });
    const { transcriptId, all, idx, section } = found;
    if (idx === 0) {
      return res.status(409).json({ error: 'The first section starts the transcript — it is not a boundary and cannot be deleted' });
    }
    const survivor = all[idx - 1];

    // Keep the trace: the absorbed name lives on the survivor, so a fold can
    // always be explained (and undone by dropping a new boundary back here).
    const absorbed = section.label
      ? `absorbed “${section.label}” (${section.type}, turns ${section.start_seq}–${section.end_seq})` : null;
    const note = [survivor.detection_note, absorbed].filter(Boolean).join(' · ') || null;

    await client.query('BEGIN');
    await client.query(`DELETE FROM hearing_sections WHERE id = $1`, [section.id]);
    await client.query(`UPDATE hearing_sections SET detection_note = $2, updated_at = now() WHERE id = $1`, [survivor.id, note]);
    await stampHuman(client, survivor.id, req.user?.id);
    await renumberSections(client, transcriptId);
    await assertContiguousTiling(client, transcriptId);
    await client.query('COMMIT');

    res.json({ data: {
      surviving_section_id: survivor.id,
      absorbed_label: section.label,
      absorbed_turns: section.end_seq - section.start_seq + 1,
      sections: await loadSections(client, transcriptId),
    } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.tiling) return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally { client.release(); }
}

// ── POST /api/admin/hearings/:id/sections/redetect ───────────────────────────
//  Re-run the heuristic. Auto sections re-derive; human-edited sections are kept
//  verbatim and detection is forbidden from re-cutting inside their spans.
//  Proves, before and after, that speaker_turns did not move.
async function redetectSections(req, res) {
  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No transcript for this hearing' });

    const turns = await loadSectionTurns(client, transcriptId);
    if (!turns.length) return res.status(400).json({ error: 'That transcript has no turns' });
    const { rows: roster } = await client.query(`SELECT id, full_name, state FROM members`);
    const { sections: detected } = detectSections(turns, roster);

    const before = await turnsFingerprint(client, transcriptId);
    await client.query('BEGIN');
    const result = await writeSections(client, {
      hearingId: req.params.id, transcriptId, turns, detected, force: false,
    });
    await assertContiguousTiling(client, transcriptId);
    await client.query('COMMIT');
    const after = await turnsFingerprint(client, transcriptId);
    if (before !== after) {
      console.error('SECTION REDETECT ALTERED speaker_turns — investigate', { transcriptId });
      return res.status(500).json({ error: 'Re-detect aborted: transcript fingerprint changed' });
    }

    res.json({ data: {
      detected: result.inserted, preserved: result.preserved, skipped: result.dropped.length,
      sections: await loadSections(client, transcriptId),
    } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally { client.release(); }
}

// ── POST /api/admin/hearings/:id/turns/:turnId/cleanup/override ─────────────
//  Apply a validator-BLOCKED suggestion's text as the admin's OWN edit.
//
//  The validator blocked it because it changes meaning. A human may still judge
//  the change correct — but then the human owns it, so this path can only ever
//  produce a source:'human' edit. There is deliberately NO route from a blocked
//  suggestion to an llm edit: acceptCleanup refuses class 'rejected', and this
//  endpoint never writes source:'llm'. The proposal is marked `superseded`, not
//  `accepted`, because "accepted" would claim the machine's suggestion was taken
//  on the machine's authority.
//
//  The replacement is applied by building the text it produces and running it
//  through composeEdits — the same composition a manual save uses — so other
//  accepted cleanup edits on the turn are untouched.
async function overrideCleanup(req, res) {
  const { edit_id } = req.body || {};
  if (!edit_id) return res.status(400).json({ error: 'edit_id is required' });

  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No deepgram_batch transcript for this hearing' });
    const turn = await loadTurn(client, transcriptId, req.params.turnId);
    if (!turn) return res.status(404).json({ error: 'Turn not found in this hearing' });

    const cleanup = turn.suggestions?.cleanup;
    if (!cleanup || !Array.isArray(cleanup.edits)) return res.status(400).json({ error: 'No cleanup proposals on this turn' });
    const p = cleanup.edits.find((x) => x.id === edit_id);
    if (!p) return res.status(404).json({ error: 'Proposal not found on this turn' });
    if (p.status !== 'proposed') return res.status(409).json({ error: `Proposal already ${p.status}` });
    if (p.class !== 'rejected') {
      return res.status(422).json({ error: 'This path is only for validator-blocked suggestions — use accept for a normal proposal' });
    }

    const anchor = anchorEdit(turn.raw_text, p);
    if (!anchor) return res.status(409).json({ error: 'This suggestion no longer matches the current text — re-run cleanup' });

    const existing = Array.isArray(turn.suggestions?.text_edits) ? turn.suggestions.text_edits : [];
    if (existing.some((t) => spansOverlap(t, anchor))) {
      return res.status(409).json({ error: 'An edit already covers this text — edit the turn manually instead' });
    }

    // Where the blocked span sits in the CLEANED text (safe: it overlaps no
    // existing edit, so its offset shifts only by whole edits before it).
    let base;
    try { base = existing.length ? applyEdits(turn.raw_text, existing) : turn.raw_text; }
    catch (err) { return res.status(409).json({ error: `Existing edits do not reconstruct: ${err.message}` }); }
    let delta = 0;
    for (const e of [...existing].sort((a, b) => a.raw_start - b.raw_start)) {
      if (e.raw_end <= anchor.raw_start) delta += e.replacement.length - (e.raw_end - e.raw_start);
    }
    const baseStart = anchor.raw_start + delta;
    const baseEnd = baseStart + (anchor.raw_end - anchor.raw_start);
    if (base.slice(baseStart, baseEnd) !== p.original) {
      return res.status(409).json({ error: 'This suggestion no longer matches the current text — re-run cleanup' });
    }

    const submitted = base.slice(0, baseStart) + p.replacement + base.slice(baseEnd);
    if (submitted === base) return res.status(422).json({ error: 'That suggestion would not change the text' });
    if (!submitted.trim().length) return res.status(400).json({ error: 'Use delete-merge to empty a turn' });

    const composed = composeEdits(turn.raw_text, existing, submitted);
    if (!composed) return res.status(422).json({ error: 'Could not derive a faithful edit set for that override' });
    let rebuilt = null;
    try { rebuilt = applyEdits(turn.raw_text, composed.edits); } catch { rebuilt = null; }
    if (rebuilt !== submitted) return res.status(422).json({ error: 'Could not derive a faithful edit set for that override' });

    // Stamp every edit this override introduced. composeEdits only ever labels
    // new spans source:'human', so this can never mark something as llm.
    const preexisting = (e) => existing.some((x) =>
      x.raw_start === e.raw_start && x.raw_end === e.raw_end && x.replacement === e.replacement && x.source === e.source);
    const introduced = composed.edits.filter((e) => e.source === 'human' && !preexisting(e));
    if (!introduced.length) return res.status(422).json({ error: 'Could not attribute this override to an edit' });
    const stamp = {
      at: new Date().toISOString(),
      by: req.user?.id ?? null,
      blocked_reason: p.reject_reason ?? null,
      cleanup_edit_id: p.id,
    };
    for (const e of introduced) e.override = stamp;

    p.status = 'superseded';
    p.overridden = { at: stamp.at, by: stamp.by };
    // Any other pending proposal the new text now covers is superseded too.
    for (const e of cleanup.edits) {
      if (e.status === 'proposed' && composed.edits.some((t) => spansOverlap(e, t))) e.status = 'superseded';
    }

    await client.query('BEGIN');
    try {
      await persistTurnText(client, turn, { textEdits: composed.edits, cleanup, reviewedBy: req.user?.id });
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Edits overlap or do not reconstruct: ${err.message}` });
    }
    const demoted = await maybeDemote(client, req.params.id);
    await client.query('COMMIT');
    res.json({ data: { applied: introduced.length, demoted } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

// ── POST /api/admin/hearings/:id/turns/:turnId/text ─────────────────────────
//  Manual inline edit. The client sends the FULL new turn text; the server
//  diffs it against raw_text to derive human edit spans (each recording its raw
//  original), asserts they reconstruct the submitted text exactly, and
//  recomputes clean_text. raw_text is never touched. Human edits are trusted
//  (they may legitimately change a word) but always transparent and reversible.
async function editTurnText(req, res) {
  const { text, base } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ error: 'text (string) is required' });

  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No deepgram_batch transcript for this hearing' });
    const turn = await loadTurn(client, transcriptId, req.params.turnId);
    if (!turn) return res.status(404).json({ error: 'Turn not found in this hearing' });

    const existing = Array.isArray(turn.suggestions?.text_edits) ? turn.suggestions.text_edits : [];

    let textEdits;
    if (text === turn.raw_text) {
      textEdits = []; // reverted to the record
    } else {
      if (!text.trim().length) return res.status(400).json({ error: 'Use delete-merge to empty a turn, not a blank edit' });

      // The editor edits the CLEANED text, so the manual change is composed onto
      // the existing stack rather than re-derived from raw_text — accepted
      // cleanup edits the human didn't touch keep their llm provenance.
      const composed = composeEdits(turn.raw_text, existing, text);
      if (!composed) return res.status(422).json({ error: 'Could not derive a faithful edit set for that text' });

      // Optimistic concurrency: the client tells us which cleaned text it was
      // editing. If someone accepted or dismissed an edit meanwhile, the diff
      // would be taken against the wrong baseline — refuse instead of guessing.
      if (typeof base === 'string' && base !== composed.base) {
        return res.status(409).json({ error: 'This turn changed while you were editing (an edit was accepted or removed). Reopen the editor to pick up the current text.' });
      }

      let rebuilt = null;
      try { rebuilt = applyEdits(turn.raw_text, composed.edits); } catch { rebuilt = null; }
      if (rebuilt !== text) return res.status(422).json({ error: 'Could not derive a faithful edit set for that text' });
      textEdits = composed.edits;
    }

    // Supersede any cleanup proposal a human edit now overlaps (keeps the tier gate clean).
    const cleanup = turn.suggestions?.cleanup;
    if (cleanup?.edits) {
      for (const e of cleanup.edits) {
        if (e.status === 'proposed' && textEdits.some((t) => spansOverlap(e, t))) e.status = 'superseded';
      }
    }

    await client.query('BEGIN');
    try {
      await persistTurnText(client, turn, { textEdits, cleanup: cleanup ?? undefined, reviewedBy: req.user?.id });
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Edits overlap or do not reconstruct: ${err.message}` });
    }
    const demoted = await maybeDemote(client, req.params.id);
    await client.query('COMMIT');
    res.json({ data: { demoted, edits: textEdits.length } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

// ── POST /api/admin/hearings/:id/turns/:turnId/text-review ───────────────────
//  Mark a turn's text reviewed with no change ("looks good"). Feeds the tier-2 gate.
async function reviewTurnText(req, res) {
  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No deepgram_batch transcript for this hearing' });
    const turn = await loadTurn(client, transcriptId, req.params.turnId);
    if (!turn) return res.status(404).json({ error: 'Turn not found in this hearing' });
    const sugg = { ...(turn.suggestions || {}) };
    sugg.text_review = { reviewed_at: new Date().toISOString(), by: req.user?.id ?? null };
    await client.query(`UPDATE speaker_turns SET suggestions = $2::jsonb, updated_at = now() WHERE id = $1`, [turn.id, JSON.stringify(sugg)]);
    res.json({ data: { reviewed: true } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

// ── POST /api/admin/hearings/:id/status ─────────────────────────────────────
//  Tier promotion: attributed (tier 1) or verified (tier 2). Both hard-gated on
//  every bucket being reviewed (no 'unverified' turn may reach the public).
async function setStatus(req, res) {
  const { status } = req.body || {};
  if (!['attributed', 'verified'].includes(status)) {
    return res.status(400).json({ error: "status must be 'attributed' or 'verified'" });
  }

  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No deepgram_batch transcript for this hearing' });

    const { rows: pending } = await client.query(
      `SELECT 'Speaker ' || f.speaker_ordinal AS label
         FROM (SELECT speaker_key,
                      dense_rank() OVER (ORDER BY min(seq))::int AS speaker_ordinal,
                      bool_or(attribution_status = 'unverified') AS pending
                 FROM speaker_turns WHERE transcript_id = $1
                GROUP BY speaker_key) f
        WHERE f.pending
        ORDER BY f.speaker_ordinal`,
      [transcriptId]
    );
    if (pending.length) {
      return res.status(400).json({
        error: 'Cannot promote: some speakers are not yet reviewed',
        unresolved: pending.map((r) => r.label),
      });
    }

    // Tier-2 (human-verified) additionally requires the WORDS to be reviewed:
    // every non-empty turn must be marked reviewed and carry no still-proposed
    // cleanup edit. So "human-verified" means a person looked at speakers AND text.
    if (status === 'verified') {
      const { rows: textPending } = await client.query(
        `SELECT 'Turn ' || seq AS label
           FROM speaker_turns
          WHERE transcript_id = $1 AND raw_text <> ''
            AND ( NOT (suggestions ? 'text_review')
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(suggestions->'cleanup'->'edits', '[]'::jsonb)) e
                           WHERE e->>'status' = 'proposed') )
          ORDER BY seq
          LIMIT 15`,
        [transcriptId]
      );
      if (textPending.length) {
        return res.status(400).json({
          error: 'Cannot mark human-verified: some turns still need text review (accept/reject their cleanup, or mark them reviewed)',
          unresolved: textPending.map((r) => r.label),
        });
      }
    }

    const { rowCount } = await client.query(
      `UPDATE hearings SET status = $2
        WHERE id = $1 AND status IN ('draft', 'attributed', 'verified')`,
      [req.params.id, status]
    );
    if (!rowCount) return res.status(409).json({ error: 'Hearing is not in a promotable state' });

    res.json({ data: { status } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

module.exports = {
  listAdminHearings, getReview, applySpeaker, overrideTurn,
  acceptAll, splitTurn, mergeTurn, insertTurn, setStatus,
  acceptCleanup, rejectCleanup, restoreCleanup, overrideCleanup, editTurnText, reviewTurnText,
  updateSection, splitSectionAtTurn, moveSectionBoundary, deleteSection, redetectSections,
};
