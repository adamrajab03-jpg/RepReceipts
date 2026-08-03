const crypto = require('crypto');
const db = require('../utils/db');
const { splitAtWord, splitAtChar, mergeTexts, meanConfidence } = require('../utils/turnText');
const { classifyEdit, applyEdits, isBulkAcceptable, anchorEdit } = require('../utils/cleanupValidate');
const { diffToEdits } = require('../utils/textDiff');

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

    res.json({ data: { hearing: hRows[0], transcript_id: transcriptId, roster, turns } });
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
      if (!textEdits.some((t) => t.raw_start === anchor.raw_start && t.raw_end === anchor.raw_end)) {
        textEdits.push({ source: 'llm', raw_start: anchor.raw_start, raw_end: anchor.raw_end, original: e.original, replacement: e.replacement, class: c.class, at: new Date().toISOString() });
      }
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
async function rejectCleanup(req, res) {
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
    e.status = 'rejected';

    const textEdits = (Array.isArray(turn.suggestions?.text_edits) ? turn.suggestions.text_edits : [])
      .filter((t) => !(t.source === 'llm' && t.raw_start === e.raw_start && t.raw_end === e.raw_end && t.replacement === e.replacement));

    await client.query('BEGIN');
    await persistTurnText(client, turn, { textEdits, cleanup, reviewedBy: req.user?.id });
    const demoted = await maybeDemote(client, req.params.id);
    await client.query('COMMIT');
    res.json({ data: { demoted } });
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
  const { text } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ error: 'text (string) is required' });

  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No deepgram_batch transcript for this hearing' });
    const turn = await loadTurn(client, transcriptId, req.params.turnId);
    if (!turn) return res.status(404).json({ error: 'Turn not found in this hearing' });

    let textEdits;
    if (text === turn.raw_text) {
      textEdits = []; // reverted to the record
    } else {
      if (!text.trim().length) return res.status(400).json({ error: 'Use delete-merge to empty a turn, not a blank edit' });
      const derived = diffToEdits(turn.raw_text, text);
      let rebuilt = null;
      try { rebuilt = applyEdits(turn.raw_text, derived); } catch { rebuilt = null; }
      if (rebuilt !== text) return res.status(422).json({ error: 'Could not derive a faithful edit set for that text' });
      const existing = Array.isArray(turn.suggestions?.text_edits) ? turn.suggestions.text_edits : [];
      textEdits = derived.map((d) => {
        const prior = existing.find((t) => t.raw_start === d.raw_start && t.raw_end === d.raw_end && t.replacement === d.replacement);
        return prior ? { ...prior } : { source: 'human', raw_start: d.raw_start, raw_end: d.raw_end, original: d.original, replacement: d.replacement, at: new Date().toISOString() };
      });
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
  acceptCleanup, rejectCleanup, editTurnText, reviewTurnText,
};
