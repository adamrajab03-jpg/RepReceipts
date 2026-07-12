#!/usr/bin/env node
// ============================================================================
//  LLM speaker attribution (Slice: suggestions only — nothing auto-applied)
// ----------------------------------------------------------------------------
//  Usage:
//    node ingestion/attribute.js <hearingId> --committee SSCM [--provider anthropic]
//
//  What it does:
//    1. Loads the hearing's deepgram_batch transcript + all speaker_turns, and
//       the committee roster (the bounded candidate list). Committee comes from
//       --committee (thomas_id); falls back to the hearing's committee_id when
//       that is set. Attribution and committee-tagging stay decoupled.
//    2. Sends the FULL transcript + roster to the provider (Claude Sonnet) in
//       ONE call; the model maps every distinct "Speaker N" to a member
//       (by bioguide_id), a named witness, or unknown, with confidence + a
//       cue-citing reasoning.
//    3. STRICT validation: the model returns bioguide_id, never a UUID. Each is
//       resolved to a member UUID against the EXACT roster that was sent; any
//       bioguide_id not in that set is coerced to unknown and flagged. This makes
//       hallucinated attributions structurally impossible.
//    4. Writes each speaker's suggestion to suggestions.attribution on ALL of
//       that speaker's turns — and touches NOTHING else. member_id, speaker_name,
//       speaker_role, and attribution_status (the confirmed record) are never
//       written here; that is the admin-review flow's job.
//
//  Idempotent: re-running overwrites only suggestions.attribution.
// ============================================================================

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');
const { getProvider } = require('./attribution/provider');

// ── Arg parsing ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      opts[a.slice(2)] = argv[i + 1];
      i++;
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function pad(s, n) {
  s = String(s ?? '');
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const hearingId = opts._[0];
  const providerName = opts.provider || 'anthropic';

  if (!hearingId) {
    console.error('Usage: node ingestion/attribute.js <hearingId> --committee SSCM [--provider anthropic]');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    // 1a. Hearing.
    const hRes = await client.query(
      `SELECT id, title, held_on, committee_id FROM hearings WHERE id = $1`,
      [hearingId]
    );
    if (!hRes.rows.length) throw new Error(`No hearing with id ${hearingId}.`);
    const hearing = hRes.rows[0];

    // 1b. Committee: --committee wins; else resolve from hearing.committee_id.
    let thomasId = opts.committee || null;
    if (!thomasId && hearing.committee_id) {
      const cRes = await client.query(`SELECT thomas_id FROM committees WHERE id = $1`, [hearing.committee_id]);
      thomasId = cRes.rows[0]?.thomas_id || null;
    }
    if (!thomasId) {
      throw new Error('No committee: pass --committee <thomas_id> (the hearing has no committee_id set).');
    }

    // 1c. Roster — the bounded candidate list. Carries member_id (UUID) for
    //     resolution, but only bioguide_id is ever shown to the model.
    const rRes = await client.query(
      `SELECT m.id AS member_id, m.bioguide_id, m.full_name, m.party, m.state, cm.role
         FROM committee_memberships cm
         JOIN members m     ON m.id = cm.member_id
         JOIN committees c  ON c.id = cm.committee_id
        WHERE c.thomas_id = $1`,
      [thomasId]
    );
    if (!rRes.rows.length) throw new Error(`Committee ${thomasId} has no members — run import:committees first.`);
    const roster = rRes.rows.map((r) => ({
      memberId: r.member_id,
      bioguideId: r.bioguide_id,
      fullName: r.full_name,
      party: r.party,
      state: r.state,
      role: r.role,
    }));
    const rosterByBioguide = new Map(roster.map((m) => [m.bioguideId, m]));

    // 1d. Transcript: the primary deepgram_batch transcript's turns, in order.
    const txRes = await client.query(
      `SELECT id FROM transcripts
        WHERE hearing_id = $1 AND source = 'deepgram_batch'
        ORDER BY is_primary DESC, created_at DESC
        LIMIT 1`,
      [hearingId]
    );
    if (!txRes.rows.length) throw new Error('No deepgram_batch transcript for this hearing.');
    const transcriptId = txRes.rows[0].id;

    const tRes = await client.query(
      `SELECT seq, speaker_label_raw, raw_text
         FROM speaker_turns
        WHERE transcript_id = $1
        ORDER BY seq`,
      [transcriptId]
    );
    if (!tRes.rows.length) throw new Error('Transcript has no speaker_turns.');
    const transcriptTurns = tRes.rows.map((t) => ({ label: t.speaker_label_raw, text: t.raw_text }));

    // Ordered distinct speaker labels (by first appearance).
    const speakerLabels = [];
    const seen = new Set();
    for (const t of tRes.rows) {
      if (!seen.has(t.speaker_label_raw)) { seen.add(t.speaker_label_raw); speakerLabels.push(t.speaker_label_raw); }
    }

    console.log(`Hearing ${hearingId}: "${hearing.title}"`);
    console.log(`Committee: ${thomasId} (${roster.length} members) | turns: ${tRes.rows.length} | distinct speakers: ${speakerLabels.length}`);
    console.log(`Sending full transcript to provider "${providerName}"…`);

    // 2. Provider call (one shot for the whole hearing).
    const committeeName = thomasId === 'SSCM'
      ? 'Senate Committee on Commerce, Science, and Transportation'
      : thomasId;
    const provider = getProvider(providerName);
    const { rawMappings, usage, costUsd, model, provider: providerId } = await provider.attributeSpeakers({
      hearingMeta: { title: hearing.title, committeeName, thomasId, heldOn: hearing.held_on },
      roster,
      transcriptTurns,
      speakerLabels,
    });

    // 3. Resolve + STRICT-validate against the sent roster.
    const byLabel = new Map(rawMappings.map((m) => [m.speakerLabel, m]));
    const generatedAt = new Date().toISOString();
    const results = [];

    for (const label of speakerLabels) {
      const m = byLabel.get(label);
      let type = 'unknown';
      let memberId = null;
      let bioguideId = null;
      let displayName = null;
      let confidence = 0;
      let reasoning = 'No mapping returned for this speaker.';
      const flags = [];

      if (m) {
        confidence = m.confidence;
        reasoning = m.reasoning;
        if (m.identityType === 'member') {
          const hit = m.bioguideId ? rosterByBioguide.get(m.bioguideId) : null;
          if (hit) {
            type = 'member';
            memberId = hit.memberId;
            bioguideId = hit.bioguideId;
            displayName = hit.fullName;            // authoritative name from the roster, not the model's
          } else {
            // Hallucinated / off-roster bioguide → coerced to unknown.
            flags.push('coerced_unknown_offroster_bioguide');
            reasoning = `[coerced to unknown: model returned off-roster bioguide "${m.bioguideId}"] ${reasoning}`;
          }
        } else if (m.identityType === 'witness') {
          type = 'witness';
          displayName = m.displayName || null;
          if (!displayName) flags.push('witness_without_name');
        }
        // identity_type === 'unknown' falls through to the unknown defaults.
      }

      const attribution = {
        suggested_identity: { type, member_id: memberId, bioguide_id: bioguideId, display_name: displayName },
        confidence,
        reasoning,
        provider: providerId,
        model,
        speaker_label_raw: label,
        generated_at: generatedAt,
      };
      if (flags.length) attribution.flags = flags;
      results.push({ label, attribution });
    }

    // Extra labels the model invented that aren't in the transcript → report + drop.
    const extras = rawMappings.map((m) => m.speakerLabel).filter((l) => !seen.has(l));

    // 4. Write — ONLY suggestions.attribution, scoped per speaker, one txn.
    //    Never touches member_id / speaker_name / speaker_role / attribution_status.
    await client.query('BEGIN');
    for (const r of results) {
      await client.query(
        `UPDATE speaker_turns
            SET suggestions = jsonb_set(coalesce(suggestions, '{}'::jsonb), '{attribution}', $3::jsonb, true)
          WHERE transcript_id = $1 AND speaker_label_raw = $2`,
        [transcriptId, r.label, JSON.stringify(r.attribution)]
      );
    }
    await client.query('COMMIT');

    // ── Summary (judge accuracy from here) ────────────────────────────────────
    console.log('');
    console.log(`Done. ${model} | in ${usage.inputTokens} tok, out ${usage.outputTokens} tok | est. $${costUsd.toFixed(4)} (standard rates; ~half at intro pricing)`);
    console.log('');
    console.log(pad('SPEAKER', 11) + pad('TYPE', 9) + pad('CONF', 6) + pad('SUGGESTED', 26) + 'REASONING');
    for (const r of results) {
      const si = r.attribution.suggested_identity;
      console.log(
        pad(r.label, 11) +
        pad(si.type, 9) +
        pad(r.attribution.confidence.toFixed(2), 6) +
        pad(si.display_name || (si.type === 'unknown' ? '—' : ''), 26) +
        r.attribution.reasoning
      );
    }
    if (extras.length) {
      console.log(`\n  Ignored ${extras.length} invented label(s) not in transcript: ${extras.join(', ')}`);
    }
    console.log(`\n  Inspect from the DB:`);
    console.log(`    SELECT DISTINCT ON (speaker_label_raw) speaker_label_raw,`);
    console.log(`           suggestions->'attribution'->'suggested_identity'->>'display_name' AS suggested,`);
    console.log(`           suggestions->'attribution'->>'confidence' AS confidence,`);
    console.log(`           suggestions->'attribution'->>'reasoning' AS reasoning`);
    console.log(`      FROM speaker_turns WHERE transcript_id = '${transcriptId}'`);
    console.log(`     ORDER BY speaker_label_raw;`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('');
    console.error('Attribution failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
