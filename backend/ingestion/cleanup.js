#!/usr/bin/env node
// ============================================================================
//  LLM grammar cleanup (Slice: proposals only — nothing auto-applied)
// ----------------------------------------------------------------------------
//  Usage:
//    node ingestion/cleanup.js <hearingId> [--provider anthropic] [--batch 30] [--dry-run]
//
//  What it does:
//    1. Loads the hearing's primary deepgram_batch transcript and its non-empty
//       speaker_turns in order.
//    2. Sends batches of consecutive turns to the provider (Claude Sonnet). The
//       model returns discrete EDITS per turn (exact `original` substring +
//       `replacement` + a claimed `type`) — never rewritten turns.
//    3. Provider-agnostic safety, identical for any model:
//         a. LOCATE each edit's `original` in raw_text via a progressive
//            indexOf walk (turnText discipline). Unlocatable → dropped, never
//            guessed.
//         b. VALIDATE each located edit with the content-word validator
//            (src/utils/cleanupValidate.js), which re-derives the real class,
//            ignoring the model's declared type. Edits that would change a
//            substantive word are classed `rejected` and stored FLAGGED (shown,
//            never silently dropped).
//    4. Writes each turn's proposals to suggestions.cleanup — and touches
//       NOTHING else. Never writes clean_text, member_id, speaker_name,
//       speaker_role, attribution_status, or suggestions.attribution.
//       clean_text is only ever derived from ACCEPTED edits, by the admin flow.
//
//  Idempotent: re-running overwrites only suggestions.cleanup.
// ============================================================================

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const crypto = require('crypto');
const { Pool } = require('pg');
const { getProvider } = require('./cleanup/provider');
const { locateEdits, classifyEdit } = require('../src/utils/cleanupValidate');

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'dry-run') { opts[key] = true; }
      else { opts[key] = argv[i + 1]; i++; }
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const pad = (s, n) => { s = String(s ?? ''); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const hearingId = opts._[0];
  const providerName = opts.provider || 'anthropic';
  const batchSize = Math.max(1, parseInt(opts.batch || '30', 10));
  const dryRun = opts['dry-run'] === true;

  if (!hearingId) {
    console.error('Usage: node ingestion/cleanup.js <hearingId> [--provider anthropic] [--batch 30] [--dry-run]');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const hRes = await client.query(`SELECT id, title FROM hearings WHERE id = $1`, [hearingId]);
    if (!hRes.rows.length) throw new Error(`No hearing with id ${hearingId}.`);
    const hearing = hRes.rows[0];

    const txRes = await client.query(
      `SELECT id FROM transcripts
        WHERE hearing_id = $1 AND source = 'deepgram_batch'
        ORDER BY is_primary DESC, created_at DESC
        LIMIT 1`,
      [hearingId]
    );
    if (!txRes.rows.length) throw new Error('No deepgram_batch transcript for this hearing.');
    const transcriptId = txRes.rows[0].id;

    // Non-empty turns only — blank admin-inserted slots have nothing to clean.
    const tRes = await client.query(
      `SELECT id, seq, raw_text FROM speaker_turns
        WHERE transcript_id = $1 AND raw_text <> ''
        ORDER BY seq`,
      [transcriptId]
    );
    if (!tRes.rows.length) throw new Error('Transcript has no non-empty speaker_turns.');
    const turns = tRes.rows;

    console.log(`Hearing ${hearingId}: "${hearing.title}"`);
    console.log(`Turns to clean: ${turns.length} | batch size: ${batchSize} | provider: ${providerName}${dryRun ? ' | DRY RUN (no writes)' : ''}`);

    const provider = getProvider(providerName);
    const generatedAt = new Date().toISOString();

    // Accumulators.
    const classCounts = { mechanical: 0, filler: 0, false_start: 0, transcription_error: 0, rejected: 0 };
    let droppedCount = 0;
    let usage = { inputTokens: 0, outputTokens: 0 };
    let costUsd = 0;
    let modelUsed = null;
    const perTurnRecords = new Map(); // turnId → cleanup record

    for (let start = 0; start < turns.length; start += batchSize) {
      const slice = turns.slice(start, start + batchSize);
      const batch = slice.map((t, i) => ({ index: i, text: t.raw_text }));
      process.stdout.write(`  batch ${Math.floor(start / batchSize) + 1}/${Math.ceil(turns.length / batchSize)} (turns ${slice[0].seq}–${slice[slice.length - 1].seq})… `);

      const { rawTurns, usage: u, costUsd: c, model } = await provider.cleanupBatch({ batch });
      usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens;
      costUsd += c; modelUsed = model;

      const byIndex = new Map(rawTurns.map((rt) => [rt.turnIndex, rt.edits]));
      let batchEdits = 0;
      for (let i = 0; i < slice.length; i++) {
        const turn = slice[i];
        const returned = byIndex.get(i) || [];
        const { located, dropped } = locateEdits(turn.raw_text, returned);
        droppedCount += dropped.length;

        const edits = [];
        for (const e of located) {
          const c2 = classifyEdit(e.original, e.replacement);
          if (c2.class === 'noop') continue;
          classCounts[c2.class] = (classCounts[c2.class] || 0) + 1;
          batchEdits++;
          edits.push({
            id: crypto.randomBytes(4).toString('hex'),
            original: e.original,
            replacement: e.replacement,
            llm_type: e.llmType,
            class: c2.class,
            reject_reason: c2.class === 'rejected' ? c2.reason : null,
            raw_start: e.raw_start,
            raw_end: e.raw_end,
            status: 'proposed',
          });
        }

        perTurnRecords.set(turn.id, {
          provider: providerName,
          model,
          generated_at: generatedAt,
          raw_text_sha256: sha256(turn.raw_text),
          edits,
        });
      }
      console.log(`${batchEdits} edit(s)`);
    }

    // ── Write — ONLY suggestions.cleanup, one txn, idempotent ────────────────
    if (!dryRun) {
      await client.query('BEGIN');
      for (const [turnId, record] of perTurnRecords) {
        await client.query(
          `UPDATE speaker_turns
              SET suggestions = jsonb_set(coalesce(suggestions, '{}'::jsonb), '{cleanup}', $2::jsonb, true)
            WHERE id = $1`,
          [turnId, JSON.stringify(record)]
        );
      }
      await client.query('COMMIT');
    }

    // ── Summary (the rejected count is the guardrail firing) ──────────────────
    const totalEdits = Object.values(classCounts).reduce((a, b) => a + b, 0);
    console.log('');
    console.log(`Done${dryRun ? ' (dry run — nothing written)' : ''}. ${modelUsed} | in ${usage.inputTokens} tok, out ${usage.outputTokens} tok | est. $${costUsd.toFixed(4)} (standard rates; ~half at intro pricing)`);
    console.log('');
    console.log(`  ${pad('CLASS', 22)}COUNT`);
    console.log(`  ${pad('mechanical (auto-safe)', 22)}${classCounts.mechanical}`);
    console.log(`  ${pad('filler (auto-safe)', 22)}${classCounts.filler}`);
    console.log(`  ${pad('false_start (auto-safe)', 22)}${classCounts.false_start}`);
    console.log(`  ${pad('transcription_error', 22)}${classCounts.transcription_error}  (human-accept only)`);
    console.log(`  ${pad('REJECTED (blocked)', 22)}${classCounts.rejected}  ← validator caught a meaning-change attempt`);
    console.log(`  ${'─'.repeat(30)}`);
    console.log(`  ${pad('total proposed', 22)}${totalEdits}`);
    console.log(`  ${pad('unlocatable (dropped)', 22)}${droppedCount}`);
    console.log('');
    if (!dryRun) {
      console.log(`  Proposals written to suggestions.cleanup on ${perTurnRecords.size} turn(s). clean_text untouched.`);
      console.log(`  Review + accept in the workbench: /admin/hearings/${hearingId}`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('');
    console.error('Cleanup failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
