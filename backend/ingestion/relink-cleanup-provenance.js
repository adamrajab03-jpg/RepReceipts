// ============================================================================
//  One-off repair: re-link accepted cleanup proposals that lost their `llm`
//  provenance to a manual save.
// ----------------------------------------------------------------------------
//  Before the compose fix, editTurnText re-derived the whole edit stack from
//  raw_text, so every accepted LLM edit came back as source:'human' with the
//  minimal diff span instead of the model's wider anchored span. The TEXT stayed
//  correct; only the attribution was wrong. This restores the truth: these were
//  LLM suggestions a human accepted, and the two-colour provenance should say so.
//
//  Safety rules:
//    * the resulting clean_text must be byte-identical — asserted per turn,
//      and the turn is skipped entirely if it would change;
//    * a proposal is re-linked ONLY when the human edits inside its span
//      reproduce its replacement exactly. Anything ambiguous (further edited
//      since, partial overlap, stale anchor) is SKIPPED and reported, never
//      guessed;
//    * dry-run by default. Pass --apply to write.
//
//  Usage:  node ingestion/relink-cleanup-provenance.js [--apply]
// ============================================================================
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const db = require('../src/utils/db');
const { applyEdits } = require('../src/utils/cleanupValidate');

const APPLY = process.argv.includes('--apply');

const overlaps = (a, b) => a.raw_start < b.raw_end && b.raw_start < a.raw_end;

(async () => {
  const { rows } = await db.query(`
    SELECT st.id, st.seq, st.raw_text, st.clean_text,
           st.suggestions AS suggestions
      FROM speaker_turns st
     WHERE st.suggestions ? 'cleanup' AND st.suggestions ? 'text_edits'
     ORDER BY st.seq`);

  const skipped = [];
  let relinked = 0;
  let turnsChanged = 0;

  for (const t of rows) {
    const sugg = t.suggestions;
    const cleanup = sugg.cleanup;
    const existing = Array.isArray(sugg.text_edits) ? sugg.text_edits : [];
    if (!cleanup?.edits?.length || !existing.length) continue;

    const before = applyEdits(t.raw_text, existing);
    let edits = existing.map((e) => ({ ...e }));
    let touched = 0;

    for (const p of cleanup.edits) {
      if (p.status !== 'accepted') continue;
      // Already intact?
      if (edits.some((e) => e.source === 'llm' && e.raw_start === p.raw_start && e.raw_end === p.raw_end)) continue;

      const where = `seq ${t.seq} ${JSON.stringify(p.original)} → ${JSON.stringify(p.replacement)}`;

      if (t.raw_text.slice(p.raw_start, p.raw_end) !== p.original) {
        skipped.push(`${where} — proposal no longer anchors to raw_text`);
        continue;
      }
      const inside = edits.filter((e) => e.raw_start >= p.raw_start && e.raw_end <= p.raw_end);
      const straddling = edits.filter((e) => overlaps(e, p) && !(e.raw_start >= p.raw_start && e.raw_end <= p.raw_end));
      if (straddling.length) {
        skipped.push(`${where} — an edit straddles the span, mapping is ambiguous`);
        continue;
      }
      if (!inside.length) {
        skipped.push(`${where} — no edit carries this change any more`);
        continue;
      }
      if (inside.some((e) => e.source === 'llm')) {
        skipped.push(`${where} — span already holds a different llm edit`);
        continue;
      }
      // Do the human edits inside the span reproduce the proposal exactly?
      const local = inside.map((e) => ({
        raw_start: e.raw_start - p.raw_start, raw_end: e.raw_end - p.raw_start,
        original: e.original, replacement: e.replacement,
      }));
      let produced = null;
      try { produced = applyEdits(p.original, local); } catch { produced = null; }
      if (produced !== p.replacement) {
        skipped.push(`${where} — span now reads ${JSON.stringify(produced)}, not the accepted text (edited since)`);
        continue;
      }

      // Unambiguous: collapse those human spans back into the accepted LLM edit.
      const at = inside.map((e) => e.at).filter(Boolean).sort()[0] ?? null;
      edits = edits.filter((e) => !inside.includes(e));
      edits.push({
        source: 'llm',
        raw_start: p.raw_start, raw_end: p.raw_end,
        original: p.original, replacement: p.replacement,
        class: p.class ?? null,
        at,
        // Honest about the repair: the original accept timestamp was overwritten
        // by the manual save, so `at` is that save's time, not the accept's.
        relinked: { at: new Date().toISOString(), reason: 'provenance restored after manual-save clobber' },
      });
      edits.sort((a, b) => a.raw_start - b.raw_start);
      touched++;
    }

    if (!touched) continue;

    let after = null;
    try { after = applyEdits(t.raw_text, edits); } catch (e) { after = `THREW: ${e.message}`; }
    if (after !== before) {
      skipped.push(`seq ${t.seq} — WOULD CHANGE TEXT, turn skipped entirely`);
      continue;
    }

    relinked += touched;
    turnsChanged++;
    console.log(`seq ${t.seq}: re-linked ${touched} accepted cleanup edit(s) → source:'llm'`);
    for (const e of edits.filter((x) => x.source === 'llm')) {
      console.log(`    [${e.raw_start},${e.raw_end}) ${JSON.stringify(e.original)} → ${JSON.stringify(e.replacement)}  (${e.class})`);
    }

    if (APPLY) {
      const next = { ...sugg, text_edits: edits };
      await db.query(`UPDATE speaker_turns SET suggestions = $2::jsonb, updated_at = now() WHERE id = $1`,
        [t.id, JSON.stringify(next)]);
    }
  }

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'} — ${relinked} proposal(s) re-linked across ${turnsChanged} turn(s)`);
  if (skipped.length) {
    console.log(`\nSKIPPED (${skipped.length}) — not re-linked, left as human edits:`);
    for (const s of skipped) console.log(`  · ${s}`);
  }
  if (!APPLY) console.log('\nnothing written. re-run with --apply to commit.');

  await db.pool?.end?.();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
