// ============================================================================
//  Word tokens with per-word timing — the backend twin of
//  frontend/src/utils/tokenizeTurn.ts.
// ----------------------------------------------------------------------------
//  Citations need, on the server, exactly what the reader sees on the page:
//  which word of the DISPLAYED text (clean_text ?? raw_text) was spoken when.
//  The server is authoritative for a citation's timestamp (anyone may share,
//  so nothing timing-related is taken from the client), which means the
//  frontend's aligner has to exist here too.
//
//  This is a line-for-line port, not a re-implementation. The parity test
//  (frontend/src/utils/tokenizeTurn.parity.test.mjs) runs both over the same
//  fixtures — hand-written edit shapes plus a few hundred generated ones — and
//  fails if they ever disagree on a single token or timing. Change one, change
//  both, and run it.
//
//  The contract, unchanged from the frontend:
//    - Tokens ALWAYS come from the text being rendered (charStart/charEnd are
//      exact by construction), never from word_times.
//    - word_times is anchored to the immutable raw_text, so after accepted
//      edits the two sequences are aligned; a timing that cannot be placed
//      unambiguously is left unplaced rather than guessed.
// ============================================================================

/**
 * Split `text` into word tokens { word, charStart, charEnd, wt? }, hanging each
 * word_times entry on the token it belongs to.
 */
function tokenizeText(text, wordTimes) {
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ word: m[0], charStart: m.index, charEnd: m.index + m[0].length });
  }
  if (wordTimes && wordTimes.length) attachTimings(tokens, wordTimes);
  return tokens;
}

// Comparison key for one word: edge punctuation stripped, lowercased. Internal
// apostrophes/hyphens are kept, so "don't" never matches "dont".
const wordKey = (s) =>
  s.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '').toLowerCase();

// Above this the LCS table is skipped — only reached when text and word_times
// disagree over hundreds of words, where any alignment would be guesswork.
const MAX_LCS_CELLS = 250_000;

function attachTimings(tokens, wordTimes) {
  if (!tokens.length) return;
  const A = wordTimes.map((wt) => wordKey(wt.w ?? ''));   // timed words, raw_text order
  const B = tokens.map((t) => wordKey(t.word));           // rendered words

  let lo = 0;
  while (lo < A.length && lo < B.length && A[lo] === B[lo]) { tokens[lo].wt = wordTimes[lo]; lo++; }
  let hiA = A.length;
  let hiB = B.length;
  while (hiA > lo && hiB > lo && A[hiA - 1] === B[hiB - 1]) { hiA--; hiB--; tokens[hiB].wt = wordTimes[hiA]; }

  if (hiA > lo || hiB > lo) alignMiddle(tokens, wordTimes, A, B, lo, hiA, hiB);
}

function alignMiddle(tokens, wordTimes, A, B, lo, hiA, hiB) {
  const m = hiA - lo;
  const n = hiB - lo;

  // Anchors: index pairs (word_time, token) the two sequences agree on.
  const anchors = [];
  if (m > 0 && n > 0 && m * n <= MAX_LCS_CELLS) {
    const w = n + 1;
    const lcs = new Uint16Array((m + 1) * w);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        lcs[i * w + j] = A[lo + i] === B[lo + j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (A[lo + i] === B[lo + j]) { anchors.push([lo + i, lo + j]); i++; j++; }
      else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) i++;
      else j++;
    }
  }

  for (const [ai, bi] of anchors) tokens[bi].wt = wordTimes[ai];

  // Hand out the timings between anchors only when the pairing is unambiguous.
  let prevA = lo - 1;
  let prevB = lo - 1;
  const bounds = [...anchors, [hiA, hiB]];
  for (const [ai, bi] of bounds) {
    const gapA = ai - prevA - 1;
    const gapB = bi - prevB - 1;
    if (gapA > 0 && gapA === gapB) {
      for (let k = 1; k <= gapA; k++) tokens[prevB + k].wt = wordTimes[prevA + k];
    }
    prevA = ai;
    prevB = bi;
  }
}

module.exports = { tokenizeText, wordKey };
