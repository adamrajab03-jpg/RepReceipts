// ============================================================================
//  HEARING SECTIONING — CLI pass.
// ----------------------------------------------------------------------------
//  Thin wrapper over src/utils/sectionDetect.js, which the admin "re-detect"
//  endpoint also uses — one implementation of the heuristic, two front doors.
//
//  Usage:
//    node ingestion/sections.js <hearing-id>            dry run (default)
//    node ingestion/sections.js <hearing-id> --apply    write hearing_sections
//    node ingestion/sections.js <hearing-id> --apply --force
//                                                       also replace admin edits
//
//  Writes ONLY hearing_sections. --apply fingerprints every field of
//  speaker_turns that sectioning must never touch (raw_text, clean_text,
//  member_id, speaker_key, attribution_status, suggestions) before and after
//  the transaction and fails loudly if anything moved.
// ============================================================================
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const db = require('../src/utils/db');
const {
  SOFT, detectSections, loadSectionTurns, writeSections, turnsFingerprint, assertTiling,
} = require('../src/utils/sectionDetect');

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const HEARING = process.argv.find((a) => /^[0-9a-f-]{36}$/i.test(a));

(async () => {
  if (!HEARING) {
    console.error('usage: node ingestion/sections.js <hearing-id> [--apply] [--force]');
    process.exit(1);
  }

  const { rows: tr } = await db.query(
    `SELECT id FROM transcripts WHERE hearing_id = $1
      ORDER BY (source = 'deepgram_batch') DESC, is_primary DESC, created_at DESC LIMIT 1`, [HEARING]);
  if (!tr.length) { console.error('No transcript for that hearing'); process.exit(1); }
  const transcriptId = tr[0].id;

  const turns = await loadSectionTurns(db, transcriptId);
  if (!turns.length) { console.error('That transcript has no turns'); process.exit(1); }
  const { rows: roster } = await db.query(`SELECT id, full_name, state FROM members`);

  const { sections, notes, chair, witnesses } = detectSections(turns, roster);

  console.log(`hearing ${HEARING}`);
  console.log(`transcript ${transcriptId} · ${turns.length} turns · roster ${roster.length}`);
  console.log(`chair bucket: ${chair.key ?? '(none found)'} via ${chair.how}`);
  console.log(`witnesses: ${witnesses.join(', ') || '(none attributed)'}\n`);

  console.log('── DETECTED SECTIONS ──');
  for (const [i, s] of sections.entries()) {
    const range = s.startSeq === s.endSeq ? `${s.startSeq}` : `${s.startSeq}–${s.endSeq}`;
    const soft = s.confidence < SOFT ? '  ⚠' : '';
    console.log(`${String(i).padStart(2)}  ${range.padEnd(9)} ${s.type.padEnd(18)} ${String(s.label ?? '—').padEnd(28)} ${s.confidence.toFixed(2)}  ${s.method}${soft}`);
    for (const n of s.notes) console.log(`         └ ${n}`);
  }

  if (notes.length) {
    console.log('\n── REVIEW NOTES (matched something, deliberately did not cut) ──');
    for (const n of notes) console.log(`  · ${n}`);
  }
  const softCount = sections.filter((s) => s.confidence < SOFT).length;
  console.log(`\n${sections.length} sections · ${softCount} below ${SOFT} confidence and flagged for review`);

  // ── What a reset would destroy ──────────────────────────────────────────
  // --force is the ONLY way to discard admin edits, and it always says exactly
  // what it is discarding first — in the dry run as well as the real thing.
  const { rows: existingRows } = await db.query(`
    SELECT hs.type, hs.label, hs.source, st.seq
      FROM hearing_sections hs JOIN speaker_turns st ON st.id = hs.start_turn_id
     WHERE hs.transcript_id = $1 ORDER BY st.seq`, [transcriptId]).catch(() => ({ rows: [] }));
  const humanRows = existingRows.filter((r) => r.source === 'human');

  if (FORCE) {
    console.log(`\n── RESET (--force) ──`);
    console.log(`Existing sections: ${existingRows.length} (${humanRows.length} admin-edited).`);
    if (humanRows.length) {
      console.log('These ADMIN-EDITED sections will be PERMANENTLY DISCARDED:');
      for (const h of humanRows) console.log(`  · turn ${String(h.seq).padStart(3)}  ${h.type.padEnd(18)} ${h.label ?? '—'}`);
    } else {
      console.log('No admin-edited sections — nothing manual is at risk.');
    }
    console.log('Everything is replaced by the detection above.');
  } else if (humanRows.length) {
    console.log(`\n${humanRows.length} admin-edited section(s) will be PRESERVED (add --force to discard them and reset to pure detection).`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to persist.');
    await db.pool?.end?.();
    process.exit(0);
  }

  const client = await db.connect();
  try {
    const before = await turnsFingerprint(client, transcriptId);
    await client.query('BEGIN');
    const { inserted, preserved, dropped } = await writeSections(client, {
      hearingId: HEARING, transcriptId, turns, detected: sections, force: FORCE,
    });
    // Validated once, whole, immediately before COMMIT — a reset that would
    // leave a gap rolls back entirely rather than half-wiping your sections.
    await assertTiling(client, transcriptId);
    await client.query('COMMIT');
    const after = await turnsFingerprint(client, transcriptId);

    if (dropped.length) {
      console.log('\n── PRESERVED ADMIN EDITS ──');
      for (const d of dropped) console.log(`  · detected cut at turn ${d.seq} skipped — ${d.why}`);
    }
    console.log(FORCE
      ? `\nRESET APPLIED — ${inserted} section(s) written from scratch, ${humanRows.length} admin-edited discarded`
      : `\nAPPLIED — ${inserted} auto section(s) written, ${preserved} admin-edited preserved`);
    console.log(`tiling validated at commit: CONFIRMED (no gaps, no overlaps, every turn covered)`);
    console.log(`speaker_turns untouched: ${before === after ? 'CONFIRMED' : 'CHANGED — INVESTIGATE'}`);
    if (before !== after) process.exitCode = 1;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.tiling) console.error(`\nABORTED — ${err.message}\nNothing was written; your existing sections are unchanged.`);
    else console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
  }

  await db.pool?.end?.();
  process.exit(process.exitCode ?? 0);
})().catch((e) => { console.error(e); process.exit(1); });
