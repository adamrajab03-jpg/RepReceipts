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
//    1. If --video-url matches an existing hearing, that hearing is reused —
//       but its prior deepgram_batch transcript + speaker_turns are NOT
//       touched until a full replacement is in hand. The fetch (or cache hit)
//       happens first; the wipe-and-replace only happens inside the same
//       commit as the new data. If the fetch fails, the old transcript and
//       hearing status are byte-for-byte as they were before the run. Pass
//       --new to force a fresh hearing row even on a video_url match.
//       For a brand-new hearing (no match), a shell row is created up front
//       (status 'transcribing', committee_id NULL) so it's visible while the
//       — potentially slow — API call runs; there's no prior data to lose there.
//    2. Sends the source to Deepgram Nova-3 pre-recorded with diarization —
//       unless a cached response for this exact audio already exists on disk
//       (backend/ingestion/artifacts/), in which case it's reused for $0.
//    3. Groups the diarized words into speaker turns.
//    4. Only now, in one transaction: wipe the old deepgram_batch transcript
//       (reuse case only), insert the new transcript (status 'complete') and
//       its turns, and flip the hearing to 'draft' (auto-diarized, awaiting
//       speaker attribution).
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
const { readCache, writeCache, cachePath } = require('./artifactCache');

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
  let reused = false;
  try {
    const heldOn = opts['held-on'] || null;
    const videoUrl = opts['video-url'] || null;
    const videoSource = videoUrl ? 'other' : null;
    const forceNew = opts.new === true;

    // 1a. Dedup lookup is READ-ONLY — no mutation until new data is in hand.
    let existingId = null;
    if (videoUrl && !forceNew) {
      const existingRes = await client.query(
        `SELECT id FROM hearings WHERE video_url = $1`,
        [videoUrl]
      );
      existingId = existingRes.rows[0]?.id ?? null;
    }

    if (existingId) {
      hearingId = existingId;
      reused = true;
      console.log(`Found existing hearing ${hearingId} for this --video-url. Fetching before touching it…`);
    } else {
      // Nothing pre-existing is at risk, so it's safe to create the shell row
      // up front for visibility while the (potentially slow) API call runs.
      await client.query('BEGIN');
      const hearingRes = await client.query(
        `INSERT INTO hearings (committee_id, title, held_on, video_url, video_source, status)
         VALUES (NULL, $1, $2, $3, $4, 'transcribing')
         RETURNING id`,
        [title, heldOn, videoUrl, videoSource]
      );
      hearingId = hearingRes.rows[0].id;
      await client.query('COMMIT');
      console.log(`Created hearing ${hearingId} (status: transcribing)`);
    }

    // 2. Deepgram call (or cache hit), timed. Still zero destructive DB writes.
    const startedAt = Date.now();
    let result;
    const cached = readCache(sourceKey);
    if (cached) {
      result = cached.result;
      console.log(`Cache hit for this audio (${sourceKey.slice(0, 12)}…) — reusing, $0.`);
    } else {
      console.log(`Cache miss — calling Deepgram for "${source}" (Nova-3, batch, diarized)…`);
      result = await transcribeSource(loaded, apiKey);
      try {
        writeCache(sourceKey, { source, fetchedAt: new Date().toISOString(), result });
        console.log(`Cached Deepgram response at ${cachePath(sourceKey)}`);
      } catch (cacheErr) {
        console.error(`Warning: failed to write Deepgram cache (${cacheErr.message}) — continuing without it.`);
      }
    }
    const elapsedSec = (Date.now() - startedAt) / 1000;

    const alt = result?.results?.channels?.[0]?.alternatives?.[0];
    if (!alt) throw new Error('Deepgram returned no transcription alternative.');

    const audioSec = result?.metadata?.duration ?? 0;
    const turns = groupWordsIntoTurns(alt.words ?? []);
    if (!turns.length) throw new Error('No words returned — nothing to insert.');

    // 3. New data is fully in hand and validated. Only now does the
    //    destructive part happen, atomically: wipe (reuse case only), insert,
    //    finalize. If anything below throws, the ROLLBACK restores the wiped
    //    transcript along with everything else — the hearing ends up exactly
    //    as it was before this run started.
    await client.query('BEGIN');
    if (reused) {
      await client.query(
        `UPDATE hearings SET title = $2, held_on = $3, video_source = $4 WHERE id = $1`,
        [hearingId, title, heldOn, videoSource]
      );
      // Only this pipeline's prior transcript is wiped — a gpo_official
      // transcript on the same hearing, if any, is left untouched. Cascades
      // to its speaker_turns via transcripts -> speaker_turns ON DELETE CASCADE.
      await client.query(
        `DELETE FROM transcripts WHERE hearing_id = $1 AND source = 'deepgram_batch'`,
        [hearingId]
      );
    }

    const txRes = await client.query(
      `INSERT INTO transcripts (hearing_id, source, is_primary, status)
       VALUES ($1, 'deepgram_batch', true, 'complete')
       RETURNING id`,
      [hearingId]
    );
    const transcriptId = txRes.rows[0].id;

    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      // speaker_key starts equal to the raw diarization label; it is the
      // editable grouping layer the review workbench rewrites, while
      // speaker_label_raw stays the immutable Deepgram artifact.
      await client.query(
        `INSERT INTO speaker_turns
           (transcript_id, seq, speaker_label_raw, speaker_key, start_ms, end_ms,
            confidence, attribution_status, raw_text, word_times)
         VALUES ($1, $2, $3, $3, $4, $5, $6, 'unverified', $7, $8::jsonb)`,
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
    await client.query(`UPDATE hearings SET status = 'draft' WHERE id = $1`, [hearingId]);
    await client.query('COMMIT');

    console.log(reused
      ? `Reusing hearing ${hearingId} (previous deepgram_batch transcript replaced)`
      : `Finalized hearing ${hearingId}`);

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
    // Best-effort rollback of whichever transaction was open.
    await client.query('ROLLBACK').catch(() => {});
    console.error('');
    console.error('Transcription failed:', err.message);
    if (hearingId && !reused) {
      console.error(`Hearing ${hearingId} left with status 'transcribing' (new hearing; no prior data lost).`);
    } else if (hearingId && reused) {
      console.error(`Hearing ${hearingId} left untouched — existing transcript preserved.`);
    }
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
