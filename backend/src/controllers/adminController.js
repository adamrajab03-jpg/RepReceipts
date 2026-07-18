const db = require('../utils/db');

// ============================================================================
//  Admin: attribution review + two-tier publish.
// ----------------------------------------------------------------------------
//  Applies the LLM's per-speaker suggestions (written to
//  speaker_turns.suggestions.attribution by ingestion/attribute.js) to the
//  confirmed record — member_id / speaker_name / speaker_role /
//  attribution_status. Nothing here trusts the client: every applied member is
//  re-validated against the tracked roster, and accepted-vs-corrected is decided
//  server-side by comparing the applied identity to the stored suggestion.
//
//  Trust tiers live on hearings.status: draft → attributed (AI-assisted,
//  human-accepted) → verified (human-verified). Editing attributions on a
//  verified hearing demotes it back to 'attributed' (surfaced to the caller as
//  `demoted: true`) so we never silently over-claim.
//
//  Per-turn overrides (diarization drift) pin the turn with a
//  suggestions.turn_override marker; every speaker-level write carries
//  `AND NOT (suggestions ? 'turn_override')`, so an individual fix is never
//  clobbered by a later bulk action, in either order.
// ============================================================================

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

// Apply one identity to every NON-PINNED turn of a speaker label. Caller owns txn.
async function applyToSpeaker(runner, transcriptId, label, applied, status) {
  const memberId    = applied.type === 'member'  ? applied.member_id   : null;
  const speakerName = applied.type === 'witness' ? applied.speaker_name : null;
  const role        = applied.type === 'member'  ? applied.role
                    : applied.type === 'witness' ? 'witness'
                    : 'unknown';
  const { rowCount } = await runner.query(
    `UPDATE speaker_turns
        SET member_id = $3, speaker_name = $4, speaker_role = $5, attribution_status = $6
      WHERE transcript_id = $1 AND speaker_label_raw = $2
        AND NOT (suggestions ? 'turn_override')`,
    [transcriptId, label, memberId, speakerName, role, status]
  );
  return rowCount;
}

// Editing attributions on a verified hearing returns it to 'attributed' — the
// safe under-claiming direction. Returns true when a demotion actually happened.
async function maybeDemote(runner, hearingId) {
  const { rows } = await runner.query(
    `UPDATE hearings SET status = 'attributed' WHERE id = $1 AND status = 'verified' RETURNING id`,
    [hearingId]
  );
  return rows.length > 0;
}

// ── GET /api/admin/hearings ─────────────────────────────────────────────────
async function listAdminHearings(_req, res) {
  try {
    const { rows } = await db.query(`
      SELECT
        h.id, h.title, h.status, h.held_on, h.created_at,
        c.name AS committee_name,
        count(st.id)::int AS turn_count,
        count(DISTINCT st.speaker_label_raw)::int AS speaker_count,
        count(DISTINCT st.speaker_label_raw)
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
//  Returns the full chronological transcript (Part A summary is derived from it
//  client-side, so the two views can't drift) plus the roster.
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
        st.id, st.seq, st.start_ms, st.speaker_label_raw,
        st.member_id, st.speaker_name, st.speaker_role, st.attribution_status,
        st.raw_text,
        m.full_name AS member_full_name,
        st.suggestions -> 'attribution' AS suggestion,
        (st.suggestions ? 'turn_override') AS pinned
      FROM speaker_turns st
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
//  Attribute (or correct) every non-pinned turn of one speaker.
async function applySpeaker(req, res) {
  const { speaker_label_raw, decision, member_id, witness_name } = req.body || {};
  if (!speaker_label_raw || !['member', 'witness', 'unknown'].includes(decision)) {
    return res.status(400).json({ error: 'speaker_label_raw and a valid decision (member|witness|unknown) are required' });
  }

  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No deepgram_batch transcript for this hearing' });

    let applied;
    if (decision === 'member') {
      if (!member_id) return res.status(400).json({ error: 'member_id is required for a member decision' });
      const { rows } = await client.query(
        `SELECT m.id, (SELECT cm.role FROM committee_memberships cm
                        WHERE cm.member_id = m.id ORDER BY cm.congress DESC NULLS LAST LIMIT 1) AS role
           FROM members m WHERE m.id = $1`,
        [member_id]
      );
      if (!rows.length) return res.status(400).json({ error: 'member_id is not a tracked roster member' });
      applied = { type: 'member', member_id, role: roleForMember(rows[0].role) };
    } else if (decision === 'witness') {
      const name = (witness_name || '').trim();
      if (!name) return res.status(400).json({ error: 'witness_name is required for a witness decision' });
      applied = { type: 'witness', speaker_name: name };
    } else {
      applied = { type: 'unknown' };
    }

    const { rows: sug } = await client.query(
      `SELECT suggestions -> 'attribution' AS attribution
         FROM speaker_turns
        WHERE transcript_id = $1 AND speaker_label_raw = $2 LIMIT 1`,
      [transcriptId, speaker_label_raw]
    );
    const status = statusFor(applied, sug[0]?.attribution);

    await client.query('BEGIN');
    const updated = await applyToSpeaker(client, transcriptId, speaker_label_raw, applied, status);
    const demoted = updated ? await maybeDemote(client, req.params.id) : false;
    await client.query('COMMIT');

    if (!updated) return res.status(404).json({ error: 'No turns matched that speaker label' });
    res.json({ data: { speaker_label_raw, attribution_status: status, turns_updated: updated, demoted } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

// ── PATCH /api/admin/hearings/:id/turns/:turnId ─────────────────────────────
//  Override ONE turn (diarization drift). Pins it so speaker-level writes skip
//  it. decision 'reset' un-pins and re-inherits the speaker's current identity.
async function overrideTurn(req, res) {
  const { decision, member_id, witness_name } = req.body || {};
  if (!['member', 'witness', 'unknown', 'reset'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be member|witness|unknown|reset' });
  }

  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No deepgram_batch transcript for this hearing' });

    // Confirm the turn belongs to this hearing's transcript; get its speaker label.
    const { rows: tRows } = await client.query(
      `SELECT id, speaker_label_raw FROM speaker_turns WHERE id = $1 AND transcript_id = $2`,
      [req.params.turnId, transcriptId]
    );
    if (!tRows.length) return res.status(404).json({ error: 'Turn not found in this hearing' });
    const label = tRows[0].speaker_label_raw;

    await client.query('BEGIN');

    if (decision === 'reset') {
      // Re-inherit from a non-pinned sibling of the same speaker; if none, revert
      // to the pending (unverified) state so the suggestion shows again.
      const { rows: sib } = await client.query(
        `SELECT member_id, speaker_name, speaker_role, attribution_status
           FROM speaker_turns
          WHERE transcript_id = $1 AND speaker_label_raw = $2 AND id <> $3
            AND NOT (suggestions ? 'turn_override')
          LIMIT 1`,
        [transcriptId, label, req.params.turnId]
      );
      const s = sib[0] || { member_id: null, speaker_name: null, speaker_role: null, attribution_status: 'unverified' };
      await client.query(
        `UPDATE speaker_turns
            SET member_id = $2, speaker_name = $3, speaker_role = $4, attribution_status = $5,
                suggestions = suggestions - 'turn_override'
          WHERE id = $1`,
        [req.params.turnId, s.member_id, s.speaker_name, s.speaker_role, s.attribution_status]
      );
    } else {
      let memberId = null, speakerName = null, role;
      if (decision === 'member') {
        if (!member_id) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'member_id is required' }); }
        const { rows } = await client.query(
          `SELECT (SELECT cm.role FROM committee_memberships cm
                    WHERE cm.member_id = m.id ORDER BY cm.congress DESC NULLS LAST LIMIT 1) AS role
             FROM members m WHERE m.id = $1`,
          [member_id]
        );
        if (!rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'member_id is not a tracked roster member' }); }
        memberId = member_id; role = roleForMember(rows[0].role);
      } else if (decision === 'witness') {
        speakerName = (witness_name || '').trim();
        if (!speakerName) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'witness_name is required' }); }
        role = 'witness';
      } else {
        role = 'unknown';
      }

      const marker = JSON.stringify({ decision, member_id: memberId, speaker_name: speakerName, at: new Date().toISOString() });
      await client.query(
        `UPDATE speaker_turns
            SET member_id = $2, speaker_name = $3, speaker_role = $4, attribution_status = 'edited',
                suggestions = jsonb_set(coalesce(suggestions, '{}'::jsonb), '{turn_override}', $5::jsonb, true)
          WHERE id = $1`,
        [req.params.turnId, memberId, speakerName, role, marker]
      );
    }

    const demoted = await maybeDemote(client, req.params.id);
    await client.query('COMMIT');

    res.json({ data: { turn_id: req.params.turnId, decision, demoted } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

// ── POST /api/admin/hearings/:id/accept-all ─────────────────────────────────
//  Fill every pending speaker's suggestion in one shot: unverified, non-pinned
//  turns only — never overwrites work already done.
async function acceptAll(req, res) {
  const client = await db.connect();
  try {
    const transcriptId = await primaryTranscriptId(client, req.params.id);
    if (!transcriptId) return res.status(404).json({ error: 'No deepgram_batch transcript for this hearing' });

    const { rows: speakers } = await client.query(`
      SELECT st.speaker_label_raw AS label,
             (array_agg(st.suggestions -> 'attribution') FILTER (WHERE st.suggestions ? 'attribution'))[1] AS suggestion
        FROM speaker_turns st
       WHERE st.transcript_id = $1
       GROUP BY st.speaker_label_raw
    `, [transcriptId]);

    const roster = await loadRoster(client);
    const roleById = new Map(roster.map((m) => [m.id, roleForMember(m.role)]));

    const applied = [];
    const skipped = [];

    await client.query('BEGIN');
    for (const s of speakers) {
      const sug = s.suggestion?.suggested_identity;
      if (!sug) { skipped.push({ label: s.label, reason: 'no_suggestion' }); continue; }

      let identity;
      if (sug.type === 'member') {
        if (!sug.member_id || !roleById.has(sug.member_id)) {
          skipped.push({ label: s.label, reason: 'suggested_member_not_in_roster' });
          continue;
        }
        identity = { type: 'member', member_id: sug.member_id, role: roleById.get(sug.member_id) };
      } else if (sug.type === 'witness') {
        if (!sug.display_name) { skipped.push({ label: s.label, reason: 'witness_without_name' }); continue; }
        identity = { type: 'witness', speaker_name: sug.display_name };
      } else {
        identity = { type: 'unknown' };
      }

      // Only fill still-pending (unverified) turns; accepting a suggestion → 'attributed'.
      const { rowCount } = await client.query(
        `UPDATE speaker_turns
            SET member_id = $3, speaker_name = $4, speaker_role = $5, attribution_status = 'attributed'
          WHERE transcript_id = $1 AND speaker_label_raw = $2
            AND attribution_status = 'unverified' AND NOT (suggestions ? 'turn_override')`,
        [
          transcriptId, s.label,
          identity.type === 'member' ? identity.member_id : null,
          identity.type === 'witness' ? identity.speaker_name : null,
          identity.type === 'member' ? identity.role : identity.type === 'witness' ? 'witness' : 'unknown',
        ]
      );
      if (rowCount > 0) applied.push({ label: s.label, type: identity.type, turns: rowCount });
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

// ── POST /api/admin/hearings/:id/status ─────────────────────────────────────
//  Tier promotion: attributed (tier 1) or verified (tier 2). Both hard-gated on
//  every speaker being reviewed (no 'unverified' turn may reach the public).
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
      `SELECT DISTINCT speaker_label_raw
         FROM speaker_turns
        WHERE transcript_id = $1 AND attribution_status = 'unverified'
        ORDER BY speaker_label_raw`,
      [transcriptId]
    );
    if (pending.length) {
      return res.status(400).json({
        error: 'Cannot promote: some speakers are not yet reviewed',
        unresolved: pending.map((r) => r.speaker_label_raw),
      });
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

module.exports = { listAdminHearings, getReview, applySpeaker, overrideTurn, acceptAll, setStatus };
