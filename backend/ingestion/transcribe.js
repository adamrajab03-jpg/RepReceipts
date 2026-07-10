#!/usr/bin/env node
// ============================================================================
//  Deepgram batch ingestion CLI (Slice 1)
// ----------------------------------------------------------------------------
//  Usage:
//    node ingestion/transcribe.js <audio-file-or-url> --title "Hearing title"
//                                 [--held-on 2026-06-15] [--video-url <url>]
//                                 [--new]
//
//  What it does:
//    1. If --video-url matches an existing hearing, reuses that hearing (wipes
//       its prior deepgram_batch transcript + speaker_turns, leaves any
//       gpo_official transcript alone) instead of creating a duplicate. Pass
//       --new to force a fresh hearing row even on a video_url match.
//       Otherwise creates a hearing (status 'transcribing', committee_id NULL)
//       and a transcript (source 'deepgram_batch', status 'processing') up
//       front, so the record is visible while the — potentially slow — API
//       call runs.
//    2. Sends the source to Deepgram Nova-3 pre-recorded with diarization —
//       unless a cached response for this exact audio already exists on disk
//       (backend/ingestion/artifacts/), in which case it's reused for $0.
//    3. Groups the diarized words into speaker turns and inserts them.
//    4. Flips the transcript to 'complete' and the hearing to 'draft'
//       (auto-diarized, awaiting speaker attribution).
//
//  Attribution — mapping "Speaker N" to real members, a real committee, and a
//  video source — is the next slice, not this one.
// ============================================================================

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');
const {
  loadSource,
  computeSourceKey,
  transcribeSource,
  groupWordsIntoTurns,
  NOVA3_PRERECORDED_USD_PER_MIN,
} = require('./deepgram');
const { readCache, writeCache } = require('./artifactCache');

// ── Arg parsing ─────────────────────────────────────────────────────────────
const BOOLEAN_FLAGS = new Set(['new']);

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        opts[key] = true;
      } else {
        opts[key] = argv[i + 1];
        i++;
      }
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function fmtDuration(sec) {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${String(r).padStart(2, '0')}s`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const source = opts._[0];
  const title = opts.title;

  if (!source || !title) {
    console.error('Usage: node ingestion/transcribe.js <audio-file-or-url> --title "Hearing title" [--held-on YYYY-MM-DD] [--video-url <url>] [--new]');
    process.exit(1);
  }

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    console.error('DEEPGRAM_API_KEY is not set in the root .env');
    process.exit(1);
  }

  // Resolve + hash the source before touching the DB, so a bad path fails
  // fast instead of leaving a stray 'transcribing' hearing behind.
  const loaded = loadSource(source);
  const sourceKey = computeSourceKey(loaded);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  let hearingId;
  let transcriptId;
  let reused = false;
  try {
    await client.query('BEGIN');
    const heldOn = opts['held-on'] || null;
    const videoUrl = opts['video-url'] || null;
    const videoSource = videoUrl ? 'other' : null;
    const forceNew = opts.new === true;

    let existing = null;
    if (videoUrl && !forceNew) {
      const existingRes = await client.query(
        `SELECT id FROM hearings WHERE video_url = $1`,
        [videoUrl]
      );
      existing = existingRes.rows[0] || null;
    }

    if (existing) {
      hearingId = existing.id;
      reused = true;
      await client.query(
        `UPDATE hearings SET title = $2, held_on = $3, video_source = $4, status = 'transcribing'
         WHERE id = $1`,
        [hearingId, title, heldOn, videoSource]
      );
      // Only this pipeline's prior transcript is wiped — a gpo_official
      // transcript on the same hearing, if any, is left untouched. Cascades
      // to its speaker_turns via transcripts -> speaker_turns ON DELETE CASCADE.
      await client.query(
        `DELETE FROM transcripts WHERE hearing_id = $1 AND source = 'deepgram_batch'`,
        [hearingId]
      );
    } else {
      const hearingRes = await client.query(
        `INSERT INTO hearings (committee_id, title, held_on, video_url, video_source, status)
         VALUES (NULL, $1, $2, $3, $4, 'transcribing')
         RETURNING id`,
        [title, heldOn, videoUrl, videoSource]
      );
      hearingId = hearingRes.rows[0].id;
    }

    const txRes = await client.query(
      `INSERT INTO transcripts (hearing_id, source, is_primary, status)
       VALUES ($1, 'deepgram_batch', true, 'processing')
       RETURNING id`,
      [hearingId]
    );
    transcriptId = txRes.rows[0].id;
    await client.query('COMMIT');

    console.log(reused
      ? `Reusing hearing ${hearingId} (matched --video-url; previous deepgram_batch transcript wiped)`
      : `Created hearing ${hearingId} (status: transcribing)`);

    // 2. Deepgram call (or cache hit), timed.
    const startedAt = Date.now();
    let result;
    const cached = readCache(sourceKey);
    if (cached) {
      result = cached.result;
      console.log(`Cache hit for this audio (${sourceKey.slice(0, 12)}…) — reusing saved Deepgram response, $0.`);
    } else {
      console.log(`Sending "${source}" to Deepgram Nova-3 (batch, diarized)…`);
      result = await transcribeSource(loaded, apiKey);
      writeCache(sourceKey, { source, fetchedAt: new Date().toISOString(), result });
    }
    const elapsedSec = (Date.now() - startedAt) / 1000;

    const alt = result?.results?.channels?.[0]?.alternatives?.[0];
    if (!alt) throw new Error('Deepgram returned no transcription alternative.');

    const audioSec = result?.metadata?.duration ?? 0;
    const turns = groupWordsIntoTurns(alt.words ?? []);
    if (!turns.length) throw new Error('No words returned — nothing to insert.');

    // 3. Insert turns + finalize, in one transaction.
    await client.query('BEGIN');
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      await client.query(
        `INSERT INTO speaker_turns
           (transcript_id, seq, speaker_label_raw, start_ms, end_ms,
            confidence, attribution_status, raw_text, word_times)
         VALUES ($1, $2, $3, $4, $5, $6, 'unverified', $7, $8::jsonb)`,
        [
          transcriptId,
          i,
          t.speakerLabelRaw,
          t.startMs,
          t.endMs,
          t.confidence,
          t.rawText,
          JSON.stringify(t.wordTimes),
        ]
      );
    }
    await client.query(`UPDATE transcripts SET status = 'complete' WHERE id = $1`, [transcriptId]);
    await client.query(`UPDATE hearings SET status = 'draft' WHERE id = $1`, [hearingId]);
    await client.query('COMMIT');

    // 4. Summary + cost/time estimate.
    const speakers = new Set(turns.map((t) => t.speakerLabelRaw)).size;
    const estCost = cached ? 0 : (audioSec / 60) * NOVA3_PRERECORDED_USD_PER_MIN;

    console.log('');
    console.log('Done.');
    console.log(`  Audio duration   : ${fmtDuration(audioSec)}`);
    console.log(`  Processing time  : ${elapsedSec.toFixed(1)}s${cached ? ' (cache read)' : ' (Deepgram round-trip)'}`);
    console.log(`  Speaker turns    : ${turns.length}`);
    console.log(`  Distinct speakers: ${speakers}`);
    console.log(`  Est. Deepgram cost: $${estCost.toFixed(4)}${cached ? ' (cached — no API call)' : ` (~$${NOVA3_PRERECORDED_USD_PER_MIN}/min, Nova-3 batch)`}`);
    console.log('');
    console.log(`  View: /hearings/${hearingId}`);
  } catch (err) {
    // Best-effort: roll back the current statement's txn. The hearing, if it was
    // created, is left in 'transcribing' to signal the run did not finish.
    await client.query('ROLLBACK').catch(() => {});
    console.error('');
    console.error('Transcription failed:', err.message);
    if (hearingId) console.error(`Hearing ${hearingId} left with status 'transcribing'.`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
