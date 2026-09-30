// ============================================================================
//  Turn content — what a turn SAYS, and the rules that keep it from vanishing.
// ----------------------------------------------------------------------------
//  THE INVARIANT (migration 015)
//  raw_text is a turn's first transcription, whatever its source — Deepgram's
//  for a diarized turn ('asr'), a reviewer's for an admin-inserted one
//  ('human'). Written once; afterwards only split/merge partition or
//  concatenate it, and edits layer in clean_text. So raw_text always holds a
//  turn's words, and anything that asks "does this turn have content?" and
//  "will this operation keep every word?" can be answered from it.
//
//  One definition of "has something to show", in SQL and JS, used by every
//  reader-facing query: the public transcript and its derived lists
//  (participants, witnesses, topics), the witness editor's detection, the
//  tier-2 review gate, and citations. It mirrors what the page renders —
//  clean_text ?? raw_text — so a turn is shown exactly when it would render
//  words, and hidden only when it would render nothing (an inserted slot no one
//  has filled in yet).
// ============================================================================
const { mergeTexts } = require('./turnText');

/**
 * SQL predicate: the turn would display non-blank text.
 * @param alias table alias ('st'), or '' for bare column names.
 */
function displayableSql(alias = 'st') {
  const p = alias ? `${alias}.` : '';
  return `btrim(coalesce(${p}clean_text, ${p}raw_text, '')) <> ''`;
}

/** The text a turn displays — the same expression the public page renders. */
const displayText = (turn) => turn.clean_text ?? turn.raw_text ?? '';

/** JS twin of displayableSql. */
const hasDisplayableText = (turn) => displayText(turn).trim() !== '';

// ── Typing into an inserted turn ─────────────────────────────────────────────
/**
 * An inserted turn (raw_text '') has no original for an edit to be an edit OF.
 * The first non-blank text a reviewer saves is its first transcription: it is
 * written to raw_text with origin 'human'. Returns null when the turn already
 * has a transcription (the ordinary edit path applies).
 */
function firstFillPlan(turn, text) {
  if (turn.raw_text !== '') return null;
  const words = typeof text === 'string' ? text.trim() : '';
  if (!words) throw { status: 400, message: 'Type the turn’s words before saving' };
  return { raw_text: words, text_origin: 'human' };
}

// ── Merging ──────────────────────────────────────────────────────────────────
/** Origin of a merged turn: an empty side contributes no words, so no origin. */
function mergedOrigin(first, second) {
  const sides = [first, second].filter((t) => t.raw_text !== '');
  if (!sides.length) return 'human';                 // two unfilled inserted slots
  if (sides.length === 1) return sides[0].text_origin;
  return sides[0].text_origin === sides[1].text_origin ? sides[0].text_origin : 'mixed';
}

/**
 * Everything a merge writes to the surviving turn, computed without touching
 * the database — so the no-lost-word guarantee is testable.
 *
 * The guarantee: every word either side DISPLAYS is in its raw_text, and
 * raw_text is what gets concatenated. A side whose displayed words are not
 * backed by its raw_text (the pre-015 shape: typed text living only in
 * clean_text) is REFUSED rather than merged, because merge resets clean_text
 * and those words would silently disappear. After 015 nothing can produce that
 * shape; this is the backstop that makes "a merge never drops a turn's only
 * content" a checked fact instead of an assumption.
 *
 * word_times: concatenated in reading order. A side with words but no timing
 * (a reviewer-transcribed turn, or an already-untimed one) makes the merged
 * turn untimed — partial timing cannot be split safely (turnText.splitAtWord).
 * The caller surfaces that as word_times_lost.
 */
function planMerge(first, second, joiner) {
  for (const side of [first, second]) {
    if (hasDisplayableText(side) && side.raw_text.trim() === '') {
      throw {
        status: 422,
        message: 'Refusing to merge: a turn’s words exist only as an edit, not in its transcription record, and a merge would delete them. Re-save that turn’s text first.',
      };
    }
  }

  const { merged, joinerUsed, seamOffset } = mergeTexts(first.raw_text, second.raw_text, joiner);

  // Belt and braces on the invariant itself: every word of both originals is in
  // the merged record, in order.
  const words = (s) => s.split(/\s+/).filter(Boolean);
  const kept = words(merged);
  const expected = [...words(first.raw_text), ...words(second.raw_text)];
  if (kept.length !== expected.length || kept.some((w, i) => w !== expected[i])) {
    throw { status: 500, message: 'Merge word check failed — nothing written' };
  }

  let wordTimes;
  let wtLost = false;
  const firstWt = first.raw_text.length ? first.word_times : [];
  const secondWt = second.raw_text.length ? second.word_times : [];
  if (firstWt == null || secondWt == null) {
    wordTimes = null;
    wtLost = (first.raw_text.length > 0 && Array.isArray(first.word_times)) ||
             (second.raw_text.length > 0 && Array.isArray(second.word_times));
  } else {
    wordTimes = [...firstWt, ...secondWt];
    if (!wordTimes.length) wordTimes = null;
  }

  return { merged, joinerUsed, seamOffset, wordTimes, wtLost, textOrigin: mergedOrigin(first, second) };
}

module.exports = { displayableSql, displayText, hasDisplayableText, firstFillPlan, planMerge, mergedOrigin };
