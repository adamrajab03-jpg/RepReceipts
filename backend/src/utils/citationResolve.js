// ============================================================================
//  Citation resolution — find a shared quote in the CURRENT transcript and say
//  honestly whether it still reads the same.
// ----------------------------------------------------------------------------
//  Input: an immutable citation row (see migration 014) and the public
//  transcript's non-blank turns in reading order. Output:
//
//    match     — the shared words are in the transcript, word for word and
//                punctuation for punctuation (whitespace ignored: HTML collapses
//                it, so a reader cannot see it).
//    diverged  — the passage was found but its words or punctuation changed.
//                change = 'formatting' when only punctuation/capitalisation
//                moved, 'wording' when a word did.
//    not_found — nowhere the evidence points contains anything close enough.
//
//  WHAT ANCHORS A QUOTE, strongest first
//    Word timing. word_times entries are facts about the recording: accepted
//    edits only write clean_text, and split/merge slice or concatenate the
//    entries verbatim, so each word carries the time it was spoken wherever a
//    structural edit moves it — across turn ids, seq renumbering, even a
//    re-transcription (same audio, near-identical times).
//    The words themselves, with the snapshot's prefix/suffix as context.
//    The hints (anchor_turn_id, char range) — a fast path, never trusted
//    without checking the text, and gone after a merge.
//
//  THE RULE: fuzzy matching runs only where there is INDEPENDENT evidence the
//  passage lives there — its recorded time, or the turn it was shared from.
//  Never across the whole transcript. For a receipts tool a false positive
//  (confidently highlighting the wrong passage, or the right words in the
//  wrong mouth) is worse than an honest "could not be located".
//
//  NO DRIFT: resolution always compares the ORIGINAL snapshot with the current
//  text. It never starts from a previous resolution, so edits cannot compound.
// ============================================================================
const { tokenizeText, wordKey } = require('./wordAlign');
const { displayText } = require('./citationSnapshot');

/** Named, test-covered tuning. Change a value → the scenario tests say what moved. */
const TUNING = Object.freeze({
  /** Stage 1: an exact-words candidate's timed words must lie within the quote's
   *  recorded time span, give or take this. Absorbs re-transcription jitter. */
  TIME_TOLERANCE_MS: 2000,
  /** Stage 2: slack when collecting timed words that overlap the quote's span. */
  REGION_SLACK_MS: 250,
  /** Stage 2: minimum share of the snapshot's words (punctuation-only tokens
   *  aside) still present, in order, in the located span. */
  MIN_SIMILARITY: 0.5,
  /** Stage 2: a located span longer than this × the quote (+2) is not the same
   *  passage, however many of its words survive — a few surviving words must
   *  not anchor a paragraph-long insertion. */
  MAX_SPAN_GROWTH: 2,
  /** Stage 1, untimed: chars of prefix/suffix context that must agree before an
   *  exact match outside the original turn is trusted. */
  CONTEXT_MIN_CHARS: 16,
  /** Stage 2: cost of substituting a near-spelling word (vs 1 for any other). */
  NEAR_SUB_COST: 0.5,
});

const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

// ── Speakers ─────────────────────────────────────────────────────────────────
// A person, for comparison: the member when attributed to one, else the name
// the page shows. Case/whitespace-insensitive so a cosmetic rename of the same
// witness isn't reported as a different speaker.
const turnIdentity = (t) =>
  t.member_id ? `m:${t.member_id}` : `n:${norm(t.speaker_name ?? t.speaker_label_raw).toLowerCase()}`;
const citationIdentity = (c) =>
  c.member_id ? `m:${c.member_id}` : `n:${norm(c.speaker_name).toLowerCase()}`;

const currentSpeaker = (t) => ({
  member_id: t.member_id ?? null,
  name: t.member_full_name ?? t.speaker_name ?? t.speaker_label_raw ?? 'Unknown speaker',
  role: t.speaker_role ?? null,
  party: t.member_id ? t.party ?? null : null,
  state: t.member_id ? t.state ?? null : null,
  chamber: t.member_id ? t.chamber ?? null : null,
});

// ── The token stream ─────────────────────────────────────────────────────────
// Every word of the transcript in reading order, carrying its turn and its
// aligned timing. Quotes can straddle turns only by way of a later split, so
// the stream (not any one turn) is the search space.
function buildStream(turns) {
  const stream = [];
  turns.forEach((turn, ti) => {
    // wi: the timing's index in this turn's word_times, so Stage 2 can look up
    // which ORIGINAL words an edited (untimed) run of text replaced.
    const index = new Map((turn.word_times ?? []).map((wt, i) => [wt, i]));
    for (const t of tokenizeText(displayText(turn), turn.word_times)) {
      stream.push({ ...t, ti, key: wordKey(t.word), wi: t.wt ? index.get(t.wt) : -1 });
    }
  });
  return stream;
}

// Chars of `a`'s end that agree with `b`'s end (whitespace-normalised).
function commonSuffix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** How much of the snapshot's prefix/suffix agrees with the text around a span. */
function contextScore(citation, turns, stream, a, b) {
  const first = stream[a];
  const last = stream[b];
  const firstText = displayText(turns[first.ti]);
  const lastText = displayText(turns[last.ti]);
  // Reach into the neighbouring turn when the span sits at a turn edge — after a
  // split, the context that used to precede the quote lives in the turn before.
  let before = firstText.slice(0, first.charStart);
  if (norm(before).length < norm(citation.prefix).length && first.ti > 0) {
    before = `${displayText(turns[first.ti - 1])} ${before}`;
  }
  let after = lastText.slice(last.charEnd);
  if (norm(after).length < norm(citation.suffix).length && last.ti + 1 < turns.length) {
    after = `${after} ${displayText(turns[last.ti + 1])}`;
  }
  // Leading/trailing whitespace at the quote boundary is not context.
  return commonSuffix(norm(citation.prefix), norm(before)) + commonPrefix(norm(citation.suffix), norm(after));
}

// ── Stage 2 alignment ────────────────────────────────────────────────────────
function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function subCost(a, b) {
  if (a === b) return 0;
  const long = Math.max(a.length, b.length);
  if (Math.min(a.length, b.length) >= 4 && levenshtein(a, b) <= Math.max(1, Math.floor(long / 4))) {
    return TUNING.NEAR_SUB_COST;   // a respelling ("Kimmelmen" → "Kimmelman"), not a different word
  }
  return 1;
}

/**
 * Fitting alignment: the whole of Q (the snapshot's words) against the best-
 * matching stretch of R (the region's words). Skipping region words before or
 * after the stretch is free; inside it every insertion, deletion or
 * substitution costs. Returns the stretch [start, end] in R and its cost.
 */
function fitAlign(Q, R) {
  const n = Q.length;
  const m = R.length;
  const W = m + 1;
  const D = new Float64Array((n + 1) * W);
  const P = new Uint8Array((n + 1) * W);          // 1 diagonal · 2 skip a Q word · 3 take an extra R word
  for (let i = 1; i <= n; i++) {
    D[i * W] = i;
    P[i * W] = 2;
    for (let j = 1; j <= m; j++) {
      const diag = D[(i - 1) * W + j - 1] + subCost(Q[i - 1], R[j - 1]);
      const up = D[(i - 1) * W + j] + 1;
      const left = D[i * W + j - 1] + 1;
      // Prefer the diagonal on ties: it keeps the span tight around real matches.
      if (diag <= up && diag <= left) { D[i * W + j] = diag; P[i * W + j] = 1; }
      else if (up <= left) { D[i * W + j] = up; P[i * W + j] = 2; }
      else { D[i * W + j] = left; P[i * W + j] = 3; }
    }
  }
  let end = 1;
  for (let j = 2; j <= m; j++) if (D[n * W + j] < D[n * W + end]) end = j;
  let i = n;
  let j = end;
  while (i > 0) {
    const p = P[i * W + j];
    if (p === 1) { i--; j--; } else if (p === 2) { i--; } else { j--; }
  }
  return { cost: D[n * W + end], start: j, end: end - 1 };   // R[start..end], end < start ⇒ empty
}

/**
 * Similarity of a FINAL span: the share of the snapshot's words still present,
 * in order (a weighted LCS — a respelling counts half). Punctuation-only tokens
 * (empty keys) are left out on both sides; they are formatting, not words.
 */
function retainedShare(Q, S) {
  const q = Q.filter(Boolean);
  const s = S.filter(Boolean);
  if (!q.length) return 0;
  let row = new Array(s.length + 1).fill(0);
  for (let i = 1; i <= q.length; i++) {
    const next = [0];
    for (let j = 1; j <= s.length; j++) {
      const c = subCost(q[i - 1], s[j - 1]);
      const w = c === 0 ? 1 : c === TUNING.NEAR_SUB_COST ? 0.5 : 0;
      next[j] = Math.max(row[j], next[j - 1], w ? row[j - 1] + w : 0);
    }
    row = next;
  }
  return row[s.length] / q.length;
}

/**
 * The quote's extent as the RECORDING defines it: the timed words spoken
 * inside [t0, t1], plus any run of edited (untimed) words at either edge that
 * replaced words originally spoken inside it.
 *
 * Why this is needed: at a changed edge, alignment alone cannot tell "the
 * quote ends at 'our', with 'children' deleted" from "the quote ends at
 * 'kids', which replaced 'children'" — equal cost, and it would pick the
 * shorter span, cutting off exactly the edited word a reader needs to see.
 * Timing can tell: an edit leaves the replaced words' word_times entries in the
 * turn (only clean_text is ever written), so the entries between the run's
 * timed neighbours say what the run replaced — and whether that was inside the
 * quote. A run that replaced no quoted word (a pure insertion just outside it)
 * is left out.
 */
function timeExtent(stream, turns, a, b, t0, t1) {
  // A word is inside the quote when its MIDPOINT is. Edges ± slack is wrong
  // here: Deepgram words abut, and the next speaker can start 40 ms after the
  // quote's last word — ±250 ms counted those neighbours in, bleeding the
  // highlight one word back and one word into the next turn (and raising a
  // false "attribution changed"). The quote's own edge words have midpoints
  // inside [t0, t1] by construction (t0/t1 ARE their start/end); a neighbour's
  // midpoint lies outside however tightly it abuts; and re-transcription
  // jitter is already removed by the caller's offset, leaving far less than
  // half a word of error.
  const inside = (wt) => {
    const mid = (wt.s + wt.e) / 2;
    return mid >= t0 && mid <= t1;
  };
  let L = -1;
  let R = -1;
  for (let i = a; i <= b; i++) {
    if (stream[i].wt && inside(stream[i].wt)) { if (L === -1) L = i; R = i; }
  }
  if (L === -1) return null;

  const replacedInside = (ti, fromWi, toWi) =>
    (turns[ti].word_times ?? []).slice(fromWi + 1, toWi).some(inside);

  // Left edge: the untimed run just before L, within L's turn.
  let k = L - 1;
  while (k >= 0 && !stream[k].wt && stream[k].ti === stream[L].ti) k--;
  if (k + 1 < L) {
    const fromWi = k >= 0 && stream[k].ti === stream[L].ti ? stream[k].wi : -1;
    if (replacedInside(stream[L].ti, fromWi, stream[L].wi)) L = k + 1;
  }
  // Right edge: the untimed run just after R, within R's turn.
  k = R + 1;
  while (k < stream.length && !stream[k].wt && stream[k].ti === stream[R].ti) k++;
  if (k - 1 > R) {
    const ti = stream[R].ti;
    const toWi = k < stream.length && stream[k].ti === ti ? stream[k].wi : (turns[ti].word_times ?? []).length;
    if (replacedInside(ti, stream[R].wi, toWi)) R = k - 1;
  }
  return { L, R };
}

// ── Result assembly ──────────────────────────────────────────────────────────
function located(status, extra, citation, turns, stream, a, b) {
  const segments = [];
  for (let k = a; k <= b; k++) {
    const t = stream[k];
    const seg = segments[segments.length - 1];
    if (seg && seg.ti === t.ti) seg.char_end = t.charEnd;
    else segments.push({ ti: t.ti, turn_id: turns[t.ti].id, char_start: t.charStart, char_end: t.charEnd });
  }
  const segTurns = segments.map((s) => turns[s.ti]);
  const identities = new Set(segTurns.map(turnIdentity));
  const cited = citationIdentity(citation);
  return {
    status,
    change: null,
    ...extra,
    segments: segments.map(({ ti, ...s }) => s),
    current_text: segments.map((s) => displayText(turns[s.ti]).slice(s.char_start, s.char_end)).join(' '),
    current_speakers: segTurns.map(currentSpeaker),
    attribution_changed: [...identities].some((id) => id !== cited),
    mixed_speakers: identities.size > 1,
  };
}

const NOT_FOUND = (similarity = null) => ({
  status: 'not_found', change: null, located_by: null, similarity,
  segments: [], current_text: null, current_speakers: [],
  attribution_changed: false, mixed_speakers: false,
});

/**
 * @param citation a citations row
 * @param turns    the public transcript's non-blank turns, in reading order:
 *                 { id, raw_text, clean_text, word_times, start_ms, member_id,
 *                   member_full_name, speaker_name, speaker_label_raw,
 *                   speaker_role, party, state, chamber }
 */
function resolveCitation(citation, turns) {
  const stream = buildStream(turns);
  const E = citation.quoted_text.split(/\s+/).filter(Boolean);
  if (!E.length || !stream.length) return NOT_FOUND();

  const t0 = citation.anchor_start_ms;
  const t1 = citation.anchor_end_ms;
  const timedCitation = t0 != null && t1 != null;
  const hintTi = citation.anchor_turn_id ? turns.findIndex((t) => t.id === citation.anchor_turn_id) : -1;

  // ── Stage 1: the exact words, wherever they now are ─────────────────────────
  const runs = [];
  for (let i = 0; i + E.length <= stream.length; i++) {
    let k = 0;
    while (k < E.length && stream[i + k].word === E[k]) k++;
    if (k === E.length) runs.push({ a: i, b: i + E.length - 1 });
  }

  const accepted = [];
  for (const run of runs) {
    const toks = stream.slice(run.a, run.b + 1);
    const inHint = hintTi >= 0 && toks.some((t) => t.ti === hintTi);
    const context = contextScore(citation, turns, stream, run.a, run.b);
    const trustedWithoutTime = inHint || (runs.length === 1 && context >= TUNING.CONTEXT_MIN_CHARS);
    const timedToks = toks.filter((t) => t.wt);

    // Is the run's timing its OWN? A genuinely spoken occurrence has every word
    // timed by consecutive word_times entries (a turn boundary — a split inside
    // the quote — restarts the count). Edited text is different: when a
    // reviewer re-adds words, the aligner can hand them timings BORROWED from
    // other occurrences of the same words elsewhere in the turn ("Big Tech has
    // to answer" lending "Big Tech has"), so they look as if spoken at another
    // moment. Such timing is an alignment artifact, not evidence.
    const ownTiming = toks.length > 0 && toks.every((t, k) =>
      t.wt && (k === 0 || t.ti !== toks[k - 1].ti || t.wi === toks[k - 1].wi + 1));

    let delta = Infinity;
    let ok;
    if (timedCitation && timedToks.length) {
      const lo = Math.min(...timedToks.map((t) => t.wt.s));
      const hi = Math.max(...timedToks.map((t) => t.wt.e));
      const consistent = lo >= t0 - TUNING.TIME_TOLERANCE_MS && hi <= t1 + TUNING.TIME_TOLERANCE_MS;
      if (consistent) delta = Math.abs(lo - t0);
      // Genuine timing is decisive: the same words at a different MOMENT are a
      // different utterance — the "Thank you, Mr. Chairman." trap. Borrowed or
      // partial timing proves nothing either way, so such a run falls back to
      // the untimed rule rather than being rejected on artifacts.
      ok = ownTiming ? consistent : consistent || trustedWithoutTime;
    } else {
      // No timing to check against (untimed citation, or the words lost their
      // timing in a merge): trust only the original turn, or a unique
      // occurrence whose surroundings also agree.
      ok = trustedWithoutTime;
    }
    if (!ok) continue;

    const hintExact = inHint && toks.every((t) => t.ti === hintTi) &&
      toks[0].charStart === citation.char_start && toks[toks.length - 1].charEnd === citation.char_end;
    const offsetDist = inHint ? Math.abs(toks[0].charStart - citation.char_start) : Infinity;
    accepted.push({ ...run, hintExact, delta, context, offsetDist });
  }

  if (accepted.length) {
    accepted.sort((x, y) =>
      (y.hintExact - x.hintExact) || (x.delta - y.delta) || (y.context - x.context) || (x.offsetDist - y.offsetDist));
    const best = accepted[0];
    return located('match', { located_by: best.hintExact ? 'hint' : 'exact', similarity: 1 },
      citation, turns, stream, best.a, best.b);
  }

  // ── Stage 2: the words changed — look only where the evidence points ───────
  const regions = [];
  if (timedCitation) {
    let lo = -1;
    let hi = -1;
    stream.forEach((t, i) => {
      if (t.wt && t.wt.e > t0 - TUNING.REGION_SLACK_MS && t.wt.s < t1 + TUNING.REGION_SLACK_MS) {
        if (lo === -1) lo = i;
        hi = i;
      }
    });
    if (lo !== -1) {
      // Widen past the timed words: an edited first/last word loses its timing,
      // and the passage's true edge may sit just outside the timed span.
      const pad = Math.max(3, Math.ceil(E.length / 4));
      regions.push({ a: Math.max(0, lo - pad), b: Math.min(stream.length - 1, hi + pad), by: 'time' });
    }
  }
  // The original turn, ONLY when the recording gave us nowhere to look. If the
  // quote's moment was found and does not read similarly, a similar sentence
  // elsewhere in that turn is a different moment — not the passage.
  if (!regions.length && hintTi >= 0) {
    const a = stream.findIndex((t) => t.ti === hintTi);
    if (a !== -1) {
      let b = a;
      while (b + 1 < stream.length && stream[b + 1].ti === hintTi) b++;
      regions.push({ a, b, by: 'turn' });
    }
  }

  const Q = E.map(wordKey);
  let bestSimilarity = null;
  for (const region of regions) {
    const R = stream.slice(region.a, region.b + 1).map((t) => t.key);
    const fit = fitAlign(Q, R);
    if (fit.end < fit.start) continue;
    let a = region.a + fit.start;
    let b = region.a + fit.end;

    // Located by time: the recording, not the alignment, has the final say on
    // the edges (see timeExtent). The union keeps both — alignment still covers
    // edge words that were already untimed when the quote was shared.
    if (region.by === 'time') {
      // Clock offset: 0 within one transcript (word_times entries move
      // verbatim), a few hundred ms after a re-transcription of the same audio.
      // Read it off an edge word that still matches exactly; beyond the
      // tolerance it is not jitter, so don't trust it.
      const first = stream[a];
      const last = stream[b];
      let offset = 0;
      if (first.wt && first.key === Q[0]) offset = first.wt.s - t0;
      else if (last.wt && last.key === Q[Q.length - 1]) offset = last.wt.e - t1;
      if (Math.abs(offset) > TUNING.TIME_TOLERANCE_MS) offset = 0;

      const ext = timeExtent(stream, turns, region.a, region.b, t0 + offset, t1 + offset);
      if (ext) {
        const overlaps = ext.L <= b && a <= ext.R;
        a = overlaps ? Math.min(a, ext.L) : ext.L;
        b = overlaps ? Math.max(b, ext.R) : ext.R;
        // Never let the alignment carry the span into a turn the recording
        // puts no quoted word in: a quote only spans turns because a split
        // divided it, and then its timed words sit in each of them.
        const firstTi = stream[ext.L].ti;
        const lastTi = stream[ext.R].ti;
        while (a < b && stream[a].ti < firstTi) a++;
        while (b > a && stream[b].ti > lastTi) b--;
      }
    }

    // Score exactly what would be highlighted.
    const span = stream.slice(a, b + 1);
    const similarity = Number(retainedShare(Q, span.map((t) => t.key)).toFixed(3));
    bestSimilarity = Math.max(bestSimilarity ?? 0, similarity);
    if (similarity < TUNING.MIN_SIMILARITY) continue;
    if (span.length > Q.length * TUNING.MAX_SPAN_GROWTH + 2) continue;

    // Found by alignment but word-for-word identical (e.g. the original spot
    // lost its timing): that is still a match, not a divergence.
    const sameWords = span.length === E.length && span.every((t, k) => t.word === E[k]);
    // Formatting-only = the same words once punctuation and case are set aside.
    // Tokens that are ALL punctuation (a free-standing "—") have an empty key
    // and are dropped, so adding or removing a dash is formatting, not wording.
    const spanKeys = span.map((t) => t.key).filter(Boolean);
    const quoteKeys = Q.filter(Boolean);
    const sameKeys = spanKeys.length === quoteKeys.length && spanKeys.every((k, i) => k === quoteKeys[i]);
    return located(sameWords ? 'match' : 'diverged', {
      change: sameWords ? null : sameKeys ? 'formatting' : 'wording',
      located_by: region.by,
      similarity,
    }, citation, turns, stream, a, b);
  }

  return NOT_FOUND(bestSimilarity);
}

module.exports = { resolveCitation, TUNING, fitAlign };
