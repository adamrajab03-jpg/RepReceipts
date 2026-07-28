#!/usr/bin/env node
// ============================================================================
//  No-lost-word invariant proof (word-sequence, whitespace-independent)
// ----------------------------------------------------------------------------
//  The structural edits (split / merge / insert) hold a hard invariant: no word
//  is ever lost or duplicated. This tool PROVES that across a sequence of edits
//  by comparing the transcript's WORD SEQUENCE before and after.
//
//  Why words, not raw bytes:
//    Re-merging split siblings is byte-identical (the recorded joiner round-
//    trips). But a genuine cross-speaker merge joins with a canonical single
//    space, so raw_text bytes legitimately change while NO WORD is lost. A raw
//    md5(string_agg(raw_text,' ')) would flag that expected normalization as a
//    failure. This tool normalizes whitespace away and compares the token
//    sequence, so it fails ONLY on a real defect: a word lost, duplicated, or
//    reordered.
//
//  Tokenization (the canonical word sequence):
//    Concatenate every turn's raw_text in seq order, split on whitespace, drop
//    empties. Because we only ever slice/concatenate text and never alter the
//    characters inside a word, this token stream is invariant under any correct
//    split or merge. (An inserted BLANK turn contributes zero tokens; only
//    later typing real words into it would — legitimately — change the count.)
//
//  Usage:
//    node ingestion/verify-words.js snapshot <hearingId>   # BEFORE the edits
//    …do the split → merge → split → merge-across-boundary in the workbench…
//    node ingestion/verify-words.js check    <hearingId>   # AFTER — YES/NO
//
//    node ingestion/verify-words.js print    <hearingId>   # fingerprint only
//
//  Exit code: 0 = words conserved, 1 = NOT conserved / error. Scriptable.
//  The baseline snapshot is written to ingestion/artifacts/wordproof-<id>.json.
// ============================================================================

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ARTIFACTS_DIR = path.resolve(__dirname, 'artifacts');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const fmt = (n) => n.toLocaleString('en-US');

function snapshotPath(hearingId) {
  return path.join(ARTIFACTS_DIR, `wordproof-${hearingId}.json`);
}

// The primary deepgram_batch transcript for a hearing (same rule the API uses).
async function primaryTranscriptId(pool, hearingId) {
  const { rows } = await pool.query(
    `SELECT id FROM transcripts
      WHERE hearing_id = $1 AND source = 'deepgram_batch'
      ORDER BY is_primary DESC, created_at DESC
      LIMIT 1`,
    [hearingId]
  );
  return rows[0]?.id ?? null;
}

// Build the canonical word sequence + its fingerprints for one hearing.
async function fingerprint(pool, hearingId) {
  const transcriptId = await primaryTranscriptId(pool, hearingId);
  if (!transcriptId) throw new Error(`No deepgram_batch transcript for hearing ${hearingId}`);

  const { rows } = await pool.query(
    `SELECT raw_text FROM speaker_turns WHERE transcript_id = $1 ORDER BY seq`,
    [transcriptId]
  );

  // Concatenate in reading order, then split on any whitespace run. Joining the
  // turns with a space (vs '') matters: it stops the last word of one turn and
  // the first of the next from fusing into a single bogus token.
  const words = rows
    .map((r) => r.raw_text)
    .join(' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);

  return {
    hearing_id: hearingId,
    transcript_id: transcriptId,
    turn_count: rows.length,
    word_count: words.length,
    // Tokens contain no whitespace, so '\n' is an unambiguous joiner. This hash
    // captures words AND their order.
    seq_hash: md5(words.join('\n')),
    // Order-independent: same multiset of words, possibly reordered.
    set_hash: md5([...words].sort().join('\n')),
    words,
    at: new Date().toISOString(),
  };
}

function multiset(words) {
  const m = new Map();
  for (const w of words) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

// Symmetric multiset diff → { missing, extra } (each: [word, count] samples).
function diffMultisets(baseWords, curWords, sample = 12) {
  const a = multiset(baseWords);
  const b = multiset(curWords);
  const missing = []; // in baseline, fewer/none in current
  const extra = [];   // in current, not/fewer in baseline
  for (const [w, n] of a) { const d = n - (b.get(w) ?? 0); if (d > 0) missing.push([w, d]); }
  for (const [w, n] of b) { const d = n - (a.get(w) ?? 0); if (d > 0) extra.push([w, d]); }
  const total = (arr) => arr.reduce((s, [, d]) => s + d, 0);
  return {
    missingTotal: total(missing),
    extraTotal: total(extra),
    missing: missing.slice(0, sample),
    extra: extra.slice(0, sample),
  };
}

// First index where two word sequences diverge (for the reorder diagnostic).
function firstDivergence(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n; // one is a prefix of the other
}

const line = (fp) =>
  `${fmt(fp.turn_count)} turns · ${fmt(fp.word_count)} words · seq ${fp.seq_hash.slice(0, 12)}… · set ${fp.set_hash.slice(0, 12)}…`;

async function main() {
  const [cmd, hearingId] = process.argv.slice(2);
  if (!['snapshot', 'check', 'print'].includes(cmd) || !hearingId) {
    console.error('Usage: node ingestion/verify-words.js <snapshot|check|print> <hearingId>');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const fp = await fingerprint(pool, hearingId);

    if (cmd === 'print') {
      console.log(line(fp));
      return;
    }

    if (cmd === 'snapshot') {
      fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
      // Store the full word list so `check` can pinpoint exactly what changed —
      // not just report that something did.
      fs.writeFileSync(snapshotPath(hearingId), JSON.stringify(fp));
      console.log('Baseline captured (BEFORE edits):');
      console.log(`  ${line(fp)}`);
      console.log(`  saved → ${snapshotPath(hearingId)}`);
      console.log('\nNow do the structural edits, then run:');
      console.log(`  node ingestion/verify-words.js check ${hearingId}`);
      return;
    }

    // cmd === 'check'
    const p = snapshotPath(hearingId);
    if (!fs.existsSync(p)) {
      console.error(`No baseline for hearing ${hearingId}. Run 'snapshot' BEFORE editing.`);
      process.exit(1);
    }
    const base = JSON.parse(fs.readFileSync(p, 'utf8'));

    console.log(`Baseline : ${line(base)}   (${base.at})`);
    console.log(`Current  : ${line(fp)}   (${fp.at})`);
    console.log('');

    if (fp.seq_hash === base.seq_hash) {
      console.log('WORDS CONSERVED: YES  — same words, same order.');
      process.exit(0);
    }

    if (fp.set_hash === base.set_hash) {
      // Same multiset, different order → a real ordering defect, not whitespace.
      const i = firstDivergence(base.words, fp.words);
      console.log('WORDS CONSERVED: NO  — same word multiset, but ORDER changed (reordering defect).');
      console.log(`  first divergence at word #${fmt(i)}:`);
      console.log(`    baseline: …${base.words.slice(Math.max(0, i - 3), i + 3).join(' ')}…`);
      console.log(`    current : …${fp.words.slice(Math.max(0, i - 3), i + 3).join(' ')}…`);
      process.exit(1);
    }

    const d = diffMultisets(base.words, fp.words);
    console.log('WORDS CONSERVED: NO  — the set of words changed (lost and/or duplicated).');
    console.log(`  net: ${fmt(fp.word_count - base.word_count)}  (lost ${fmt(d.missingTotal)}, gained ${fmt(d.extraTotal)})`);
    if (d.missing.length) console.log(`  lost   (baseline→gone) : ${d.missing.map(([w, n]) => n > 1 ? `${w}×${n}` : w).join(', ')}${d.missingTotal > 12 ? ' …' : ''}`);
    if (d.extra.length)   console.log(`  gained (new in current): ${d.extra.map(([w, n]) => n > 1 ? `${w}×${n}` : w).join(', ')}${d.extraTotal > 12 ? ' …' : ''}`);
    process.exit(1);
  } catch (err) {
    console.error('verify-words failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) main();

// Exported for the offline self-test (no DB): the invariant logic is pure.
module.exports = { md5, diffMultisets, firstDivergence, multiset };
