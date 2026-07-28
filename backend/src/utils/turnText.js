// ============================================================================
//  Turn-text partition helpers for structural edits (split / merge).
// ----------------------------------------------------------------------------
//  The no-lost-word invariant: every structural edit is a pure string
//  partition or concatenation, asserted to reconstitute the original exactly
//  before anything is written. word_times arrays are only ever sliced or
//  concatenated — entries are never rebuilt — so per-word timing follows its
//  text verbatim.
//
//  Word positions are located with the SAME progressive indexOf walk the
//  frontend timestamp resolver uses (frontend/src/utils/resolveMs.ts), so a
//  split can never disagree with click-to-timestamp anchoring.
// ============================================================================

/**
 * Locate each word_times token's exact [start, end) char range in rawText via
 * a progressive indexOf walk. Returns null if any token fails to locate — the
 * caller must refuse the operation rather than guess.
 */
function wordPositions(rawText, wordTimes) {
  const positions = [];
  let searchFrom = 0;
  for (const wt of wordTimes) {
    const idx = rawText.indexOf(wt.w, searchFrom);
    if (idx === -1) return null;
    positions.push({ start: idx, end: idx + wt.w.length });
    searchFrom = idx + wt.w.length;
  }
  return positions;
}

/**
 * Partition rawText before word k (0-based index into wordTimes; the first
 * word of the second half). Returns { textA, joiner, textB, wtA, wtB } where
 * textA + joiner + textB === rawText by construction — still asserted, never
 * assumed. Throws { status, message } on invalid input or a failed assertion.
 */
function splitAtWord(rawText, wordTimes, k) {
  if (!Array.isArray(wordTimes) || wordTimes.length < 2) {
    throw { status: 400, message: 'Turn has too few timed words to split' };
  }
  if (!Number.isInteger(k) || k < 1 || k > wordTimes.length - 1) {
    throw { status: 400, message: `word_index must be between 1 and ${wordTimes.length - 1}` };
  }
  const positions = wordPositions(rawText, wordTimes);
  if (!positions) {
    throw { status: 422, message: 'word_times do not align with raw_text; refusing to split' };
  }
  const endA = positions[k - 1].end;
  const startB = positions[k].start;
  const textA = rawText.slice(0, endA);
  const joiner = rawText.slice(endA, startB);
  const textB = rawText.slice(startB);
  assertReconstruction(textA, joiner, textB, rawText, 'split');
  return { textA, joiner, textB, wtA: wordTimes.slice(0, k), wtB: wordTimes.slice(k) };
}

/**
 * Partition rawText at a whitespace run containing charOffset — the fallback
 * for turns without word_times. The whole run becomes the joiner, so the two
 * halves plus the joiner are exactly the original string.
 */
function splitAtChar(rawText, charOffset) {
  if (!Number.isInteger(charOffset) || charOffset < 1 || charOffset >= rawText.length) {
    throw { status: 400, message: 'char_offset out of range' };
  }
  if (!/\s/.test(rawText[charOffset])) {
    throw { status: 400, message: 'char_offset must point at whitespace between words' };
  }
  let runStart = charOffset;
  while (runStart > 0 && /\s/.test(rawText[runStart - 1])) runStart--;
  let runEnd = charOffset;
  while (runEnd < rawText.length && /\s/.test(rawText[runEnd])) runEnd++;
  if (runStart === 0 || runEnd === rawText.length) {
    throw { status: 400, message: 'Split point must leave text on both sides' };
  }
  const textA = rawText.slice(0, runStart);
  const joiner = rawText.slice(runStart, runEnd);
  const textB = rawText.slice(runEnd);
  assertReconstruction(textA, joiner, textB, rawText, 'split');
  return { textA, joiner, textB, wtA: null, wtB: null };
}

/**
 * Merge two turns' texts in reading order. joiner is the recorded split joiner
 * when re-merging split siblings, else a single space — and omitted entirely
 * when either side is empty, so no character is ever added.
 * Returns { merged, joinerUsed, seamOffset } with seamOffset = char index
 * where secondText begins in merged (the seam the UI marks).
 */
function mergeTexts(firstText, secondText, joiner) {
  const j = firstText.length && secondText.length ? joiner : '';
  const merged = firstText + j + secondText;
  if (merged.length !== firstText.length + j.length + secondText.length ||
      !merged.startsWith(firstText) || !merged.endsWith(secondText)) {
    // Unreachable for strings; kept as the merge-side twin of the split assert.
    throw { status: 500, message: 'Merge reconstruction check failed' };
  }
  return { merged, joinerUsed: j, seamOffset: firstText.length + j.length };
}

function assertReconstruction(textA, joiner, textB, original, op) {
  if (textA + joiner + textB !== original) {
    throw { status: 422, message: `Refusing ${op}: partition does not reconstitute raw_text exactly` };
  }
  if (!textA.trim().length || !textB.trim().length) {
    throw { status: 400, message: 'Split point must leave words on both sides' };
  }
}

/** Mean per-word ASR confidence for a word_times slice, or null. */
function meanConfidence(wordTimes) {
  if (!Array.isArray(wordTimes) || !wordTimes.length) return null;
  const vals = wordTimes.map((t) => t.c).filter((c) => typeof c === 'number');
  if (!vals.length) return null;
  return Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3));
}

module.exports = { wordPositions, splitAtWord, splitAtChar, mergeTexts, meanConfidence };
