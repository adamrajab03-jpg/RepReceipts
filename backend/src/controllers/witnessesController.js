const db = require('../utils/db');
const { primaryTranscriptId } = require('./adminController');
const { WITNESS_INDUSTRIES, isIndustry } = require('../utils/witnessIndustries');

// ============================================================================
//  ADMIN: witness records for a hearing.
//
//  This controller NEVER writes speaker_turns. A witness record links to its
//  turns by matching speaker_turns.speaker_name — the same string the
//  attribution path already writes across a speaker_key bucket — and renaming a
//  witness IN THE TRANSCRIPT is done by the editor calling the existing
//  PATCH /hearings/:id/speakers (applySpeaker), so there stays exactly one code
//  path that writes turns and it keeps recomputing attribution_status.
//  See 013_hearing_witnesses.sql for the full rationale.
// ============================================================================

// The transcript's own witness identities. This predicate is deliberately
// IDENTICAL to the public derivation in hearingsController.getHearingTranscript:
// if the two ever disagree, the editor would pre-populate names no reader sees,
// or miss ones they do.
const DETECTED_SQL = `
  SELECT st.speaker_name,
         count(*)::int    AS turn_count,
         min(st.seq)::int AS first_seq,
         array_agg(DISTINCT st.speaker_key) AS speaker_keys
    FROM speaker_turns st
   WHERE st.transcript_id = $1 AND st.raw_text <> ''
     AND st.member_id IS NULL
     AND COALESCE(btrim(st.speaker_name), '') <> ''
     AND COALESCE(st.speaker_role, 'unknown') <> 'staff'
   GROUP BY st.speaker_name
   ORDER BY min(st.seq)
`;

async function loadHearing(runner, id) {
  const { rows } = await runner.query(
    'SELECT id, title, status FROM hearings WHERE id = $1', [id]
  );
  return rows[0] ?? null;
}

/**
 * The editor's payload: saved rows merged with what the transcript detected, so
 * the admin never retypes a name. Returned by BOTH the GET and the PUT — the
 * form re-renders from server truth rather than from its own optimism.
 *
 * link_state is the honest status of the speaker_name link:
 *   linked    — the transcript currently has turns under this name
 *   unlinked  — no speaker_name at all (written testimony, or never captured)
 *   orphaned  — has a speaker_name that matches nothing. This is the one failure
 *               mode of a string link (attribution was renamed after the witness
 *               was saved), so it gets a visible state instead of vanishing.
 */
async function buildEditorPayload(runner, hearing) {
  const transcriptId = await primaryTranscriptId(runner, hearing.id);

  const { rows: detected } = transcriptId
    ? await runner.query(DETECTED_SQL, [transcriptId])
    : { rows: [] };

  const { rows: saved } = await runner.query(`
    SELECT id, speaker_name, display_name, title, organization,
           industry, industry_custom, display_order
      FROM hearing_witnesses
     WHERE hearing_id = $1
     ORDER BY display_order, display_name
  `, [hearing.id]);

  const byName = new Map(detected.map((d) => [d.speaker_name, d]));
  const claimed = new Set();

  const savedRows = saved.map((w) => {
    const d = w.speaker_name ? byName.get(w.speaker_name) : null;
    if (d) claimed.add(d.speaker_name);
    return {
      ...w,
      turn_count:   d ? d.turn_count : 0,
      first_seq:    d ? d.first_seq  : null,
      speaker_keys: d ? d.speaker_keys : [],
      link_state:   d ? 'linked' : (w.speaker_name ? 'orphaned' : 'unlinked'),
    };
  });

  // Detected identities with no record yet come back as DRAFT rows (id null):
  // the name is already filled in, and industry is deliberately null so the
  // admin has to pick one rather than inherit a silent default.
  const draftRows = detected
    .filter((d) => !claimed.has(d.speaker_name))
    .map((d) => ({
      id: null,
      speaker_name: d.speaker_name,
      display_name: d.speaker_name,
      title: null,
      organization: null,
      industry: null,
      industry_custom: null,
      turn_count: d.turn_count,
      first_seq: d.first_seq,
      speaker_keys: d.speaker_keys,
      link_state: 'linked',
    }));

  // Array position IS display order from here on, and the PUT reads it back the
  // same way — so reordering in the editor is just moving an element.
  const rows = [...savedRows, ...draftRows].map((r, i) => ({ ...r, display_order: i }));

  return {
    hearing: { id: hearing.id, title: hearing.title, status: hearing.status },
    industries: WITNESS_INDUSTRIES,
    rows,
    saved_count: saved.length,
    detected_count: detected.length,
  };
}

// ── GET /api/admin/hearings/:id/witnesses ───────────────────────────────────
async function getWitnesses(req, res) {
  const hearing = await loadHearing(db, req.params.id);
  if (!hearing) return res.status(404).json({ error: 'Hearing not found' });
  res.json({ data: await buildEditorPayload(db, hearing) });
}

/**
 * Normalise one submitted row, or return a message saying why it can't be
 * saved. Blank strings become NULL, so "cleared the field" and "never filled it
 * in" are one state in the database rather than two.
 */
function normaliseRow(raw, index) {
  const at = `Witness ${index + 1}`;
  const str = (v) => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s === '' ? null : s;
  };

  const display_name = str(raw.display_name);
  if (!display_name) return { error: `${at}: a name is required` };

  // industry is REQUIRED on save. A draft row arrives with null so the admin
  // makes a deliberate choice; silently defaulting to 'other' would assert a
  // category nobody picked.
  if (!isIndustry(raw.industry)) {
    return { error: `${at} (${display_name}): pick an industry` };
  }

  return {
    row: {
      id: typeof raw.id === 'string' && raw.id ? raw.id : null,
      speaker_name: str(raw.speaker_name),
      display_name,
      title: str(raw.title),
      organization: str(raw.organization),
      industry: raw.industry,
      // Coerced rather than rejected: switching the dropdown away from 'other'
      // should not fail the save because stale custom text sits in the form.
      industry_custom: raw.industry === 'other' ? str(raw.industry_custom) : null,
    },
  };
}

// ── PUT /api/admin/hearings/:id/witnesses ───────────────────────────────────
//  One atomic full-set save: array order is display order, ids absent from the
//  payload are deletions, ids present are updates, rows without an id are
//  inserts. Add, remove and reorder all fall out of this, so there is no
//  per-row CRUD surface to keep consistent — the right trade for a handful of
//  rows per hearing.
async function saveWitnesses(req, res) {
  const submitted = req.body ? req.body.witnesses : null;
  if (!Array.isArray(submitted)) {
    return res.status(400).json({ error: 'witnesses must be an array' });
  }

  const rows = [];
  for (let i = 0; i < submitted.length; i++) {
    const { row, error } = normaliseRow(submitted[i] || {}, i);
    if (error) return res.status(400).json({ error });
    rows.push(row);
  }

  // Two witnesses cannot claim the same transcript identity. Caught here so the
  // admin gets the name back instead of a raw unique-violation.
  const names = rows.map((r) => r.speaker_name).filter(Boolean);
  const dupe = names.find((n, i) => names.indexOf(n) !== i);
  if (dupe) {
    return res.status(400).json({
      error: `Two witnesses are both linked to "${dupe}" in the transcript`,
    });
  }

  const client = await db.connect();
  try {
    const hearing = await loadHearing(client, req.params.id);
    if (!hearing) return res.status(404).json({ error: 'Hearing not found' });

    await client.query('BEGIN');
    // Every row is renumbered from 0 in one pass, so positions collide
    // transiently — the constraint is still enforced at COMMIT.
    await client.query('SET CONSTRAINTS hearing_witnesses_order_uniq DEFERRED');

    const keep = rows.map((r) => r.id).filter(Boolean);
    await client.query(
      'DELETE FROM hearing_witnesses WHERE hearing_id = $1 AND id <> ALL($2::uuid[])',
      [hearing.id, keep]
    );

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const vals = [
        hearing.id, r.speaker_name, r.display_name, r.title, r.organization,
        r.industry, r.industry_custom, i, req.user.id,
      ];
      if (r.id) {
        // hearing_id in the WHERE: an id belonging to another hearing can never
        // be steered into this one.
        const { rowCount } = await client.query(`
          UPDATE hearing_witnesses
             SET speaker_name = $2, display_name = $3, title = $4, organization = $5,
                 industry = $6, industry_custom = $7, display_order = $8,
                 updated_by = $9, updated_at = now()
           WHERE hearing_id = $1 AND id = $10
        `, [...vals, r.id]);
        if (!rowCount) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `"${r.display_name}" no longer exists — reload the page and try again`,
          });
        }
      } else {
        await client.query(`
          INSERT INTO hearing_witnesses
            (hearing_id, speaker_name, display_name, title, organization,
             industry, industry_custom, display_order, created_by, updated_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
        `, vals);
      }
    }

    await client.query('COMMIT');
    res.json({ data: await buildEditorPayload(client, hearing) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

module.exports = { getWitnesses, saveWitnesses };
