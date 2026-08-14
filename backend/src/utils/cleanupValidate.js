// ============================================================================
//  Content-word validator for LLM grammar cleanup — the trust-critical core.
// ----------------------------------------------------------------------------
//  A cleanup "edit" replaces one exact substring of a turn's raw_text (the
//  `original`, copied verbatim) with a `replacement`. This module decides,
//  PROGRAMMATICALLY and independent of what the model claimed, whether that edit
//  is safe — i.e. whether it changes any SUBSTANTIVE word. The model's declared
//  `type` is never trusted; classifyEdit() re-derives the class from the two
//  strings alone.
//
//  This is the text analog of attribute.js resolving bioguide_ids against the
//  roster in code: the guardrail is code, not the prompt. It runs twice — once
//  in the pipeline stage at proposal time, and again in the accept endpoint at
//  apply time (against the CURRENT raw_text) — so a stale or crafted proposal
//  can never reach clean_text.
//
//  Classes (see the plan §3):
//    mechanical           punctuation / capitalization / whitespace only        (auto-safe)
//    filler               above + removed single-token disfluency (um, uh, …)   (auto-safe)
//    false_start          deleted a VERBATIM adjacent repetition (stutter)      (auto-safe)
//    transcription_error  exactly ONE content word swapped, passes phonetic gate (HUMAN-ACCEPT ONLY)
//    rejected             everything else — added / removed / reordered / multi- (BLOCKED)
//                         changed content words, or a failed phonetic gate
//    noop                 original === replacement
//
//  GUARANTEE: after applying accepted edits, the content-word sequence of
//  clean_text equals that of raw_text except (a) filler removed, (b) verbatim
//  adjacent repeats collapsed, (c) explicitly-accepted single-word
//  transcription_error swaps. No content word is ever added, removed beyond
//  (a)/(b), or reordered.
//
//  Numbers, dates, and quantities are content words (so "15" → "50" is caught).
//  Multi-word discourse markers ("you know", "I mean") are deliberately NOT in
//  the auto-safe filler set — the validator can't distinguish filler usage from
//  content usage ("I mean what I say"), so their removal falls through to the
//  general rule and is `rejected`/flagged. A human may still remove them as a
//  manual edit (human edits are trusted-but-transparent, not machine-gated).
// ============================================================================

// Single-token disfluencies only. Expanding this is a reviewed config change.
const FILLER = new Set([
  'um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'err', 'erm', 'ah', 'ahh',
  'hmm', 'hm', 'mm', 'mhm', 'mm-hmm', 'uh-huh', 'uh-uh',
]);

// Classes that may be accepted without an explicit per-edit human decision
// (bulk "accept all safe"). transcription_error is intentionally excluded — it
// is the one class that changes a content word, so it always needs a human.
const AUTO_SAFE = new Set(['mechanical', 'filler', 'false_start']);
const isBulkAcceptable = (cls) => AUTO_SAFE.has(cls);

// ── Tokenization ─────────────────────────────────────────────────────────────
// A token's "core" = the token with leading/trailing punctuation stripped,
// lowercased. Internal apostrophes/hyphens are KEPT so "don't" ≠ "dont" and
// "we're" ≠ "were" (those are meaning changes, not punctuation).
function core(token) {
  return token
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
    .toLowerCase();
}

// Content words: cores that are non-empty (not pure punctuation) and not filler.
function contentWords(text) {
  const out = [];
  for (const tok of String(text).split(/\s+/)) {
    if (!tok) continue;
    const c = core(tok);
    if (!c || FILLER.has(c)) continue;
    out.push(c);
  }
  return out;
}

// Filler cores present in the text (order preserved).
function fillerTokens(text) {
  const out = [];
  for (const tok of String(text).split(/\s+/)) {
    if (!tok) continue;
    const c = core(tok);
    if (c && FILLER.has(c)) out.push(c);
  }
  return out;
}

// ── Sequence helpers ─────────────────────────────────────────────────────────
const arrEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function isPermutation(a, b) {
  if (a.length !== b.length) return false;
  const s1 = [...a].sort();
  const s2 = [...b].sort();
  return s1.every((x, i) => x === s2[i]);
}

function isSubsequence(sub, arr) {
  let i = 0;
  for (const x of arr) if (i < sub.length && x === sub[i]) i++;
  return i === sub.length;
}

// Multiset difference: elements of `a` not matched by an element of `b`.
function multisetDiff(a, b) {
  const rem = [...b];
  const out = [];
  for (const x of a) {
    const i = rem.indexOf(x);
    if (i >= 0) rem.splice(i, 1);
    else out.push(x);
  }
  return out;
}

// A true stutter/self-repair: B is A with one copy of a VERBATIM adjacent
// duplicate run removed. "the the bill" → "the bill", "I— I think" → "I think".
// Only verbatim adjacent repeats — never a merely-redundant phrase.
function detectFalseStart(A, B) {
  if (B.length >= A.length) return false;
  for (let L = 1; L <= Math.floor(A.length / 2); L++) {
    for (let p = 0; p + 2 * L <= A.length; p++) {
      let same = true;
      for (let k = 0; k < L; k++) if (A[p + k] !== A[p + L + k]) { same = false; break; }
      if (!same) continue;
      const collapsed = [...A.slice(0, p + L), ...A.slice(p + 2 * L)];
      if (arrEq(collapsed, B)) return true;
    }
  }
  return false;
}

// ── Phonetic gate (transcription_error) ──────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// Standard Soundex — a coarse "sounds like" code (first letter + 3 digits).
function soundex(s) {
  const up = s.toUpperCase().replace(/[^A-Z]/g, '');
  if (!up) return '';
  const code = {
    B: '1', F: '1', P: '1', V: '1',
    C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2',
    D: '3', T: '3', L: '4', M: '5', N: '5', R: '6',
  };
  let out = up[0];
  let prev = code[up[0]] || '';
  for (let i = 1; i < up.length && out.length < 4; i++) {
    const ch = up[i];
    const c = code[ch] || '';
    if (c && c !== prev) out += c;
    if (ch === 'H' || ch === 'W') { /* keep prev — H/W are transparent */ }
    else prev = c; // consonant updates prev; vowel resets it to ''
  }
  return (out + '000').slice(0, 4);
}

// Is `b` a plausible speech-to-text mishearing of `a` (or vice versa)?
// Intentionally permissive — transcription_error is human-accept-only, so this
// gate only separates "plausible mishearing worth surfacing" from "clearly
// unrelated substitution (reject)". Numbers must match exactly.
function phoneticSimilar(a, b) {
  if (a === b) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false; // any numeric change is never "similar"
  const sa = soundex(a);
  if (sa && sa === soundex(b)) return true;
  const sim = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  return sim >= 0.5;
}

// ── The classifier ───────────────────────────────────────────────────────────
/**
 * Classify one edit purely from its (original, replacement) strings.
 * @returns { class, reason, before, after, changedIndex? }
 */
function classifyEdit(original, replacement) {
  if (original === replacement) return { class: 'noop', reason: 'no change', before: [], after: [] };

  const A = contentWords(original);
  const B = contentWords(replacement);
  const fA = fillerTokens(original);
  const fB = fillerTokens(replacement);

  // Content words identical → only punctuation / case / whitespace / filler moved.
  if (arrEq(A, B)) {
    const removedFiller = multisetDiff(fA, fB);
    if (removedFiller.length) {
      return { class: 'filler', reason: `removes filler: ${removedFiller.join(', ')}`, before: A, after: B };
    }
    return { class: 'mechanical', reason: 'punctuation / capitalization only', before: A, after: B };
  }

  // Content words differ from here on.
  if (detectFalseStart(A, B)) {
    return { class: 'false_start', reason: 'removes a verbatim self-repair (stutter)', before: A, after: B };
  }

  if (A.length === B.length) {
    const diffs = [];
    for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) diffs.push(i);
    if (diffs.length === 1) {
      const i = diffs[0];
      if (phoneticSimilar(A[i], B[i])) {
        return { class: 'transcription_error', reason: `single-word ASR fix: "${A[i]}" → "${B[i]}"`, before: A, after: B, changedIndex: i };
      }
      return { class: 'rejected', reason: `substitutes content word "${A[i]}" → "${B[i]}" (not a plausible mishearing)`, before: A, after: B };
    }
    if (isPermutation(A, B)) return { class: 'rejected', reason: 'reorders content words', before: A, after: B };
    return { class: 'rejected', reason: `changes ${diffs.length} content words`, before: A, after: B };
  }

  // Different content-word counts (and not a verbatim stutter).
  if (isSubsequence(B, A)) {
    return { class: 'rejected', reason: `removes content word(s): ${multisetDiff(A, B).join(', ')}`, before: A, after: B };
  }
  if (isSubsequence(A, B)) {
    return { class: 'rejected', reason: `adds content word(s): ${multisetDiff(B, A).join(', ')}`, before: A, after: B };
  }
  return { class: 'rejected', reason: 'rewrites content words', before: A, after: B };
}

// ── Locate + apply ───────────────────────────────────────────────────────────
/**
 * Locate each edit's `original` in rawText via a progressive indexOf walk (the
 * same discipline as turnText.wordPositions / resolveMs). Edits are matched
 * left-to-right; one whose `original` can't be found at/after the cursor is
 * DROPPED, never guessed. Returns { located, dropped }.
 */
function locateEdits(rawText, edits) {
  const located = [];
  const dropped = [];
  let cursor = 0;
  for (const e of edits) {
    if (e.original === '') { dropped.push({ ...e, drop_reason: 'empty original' }); continue; }
    const idx = rawText.indexOf(e.original, cursor);
    if (idx === -1) { dropped.push({ ...e, drop_reason: 'original not found at/after cursor' }); continue; }
    located.push({ ...e, raw_start: idx, raw_end: idx + e.original.length });
    cursor = idx + e.original.length;
  }
  return { located, dropped };
}

/**
 * Apply located, non-overlapping edits to rawText and return the derived text.
 * Every edit's span must still equal its `original` (guards against a raw_text
 * that changed under the proposal) and the untouched gaps + originals must
 * reconstitute rawText exactly — the no-silent-drift assertion.
 */
function applyEdits(rawText, edits) {
  const sorted = [...edits].sort((a, b) => a.raw_start - b.raw_start);
  let cursor = 0;
  let out = '';
  let check = '';
  for (const e of sorted) {
    if (e.raw_start < cursor) throw new Error(`overlapping edits at offset ${e.raw_start}`);
    if (e.raw_start < 0 || e.raw_end > rawText.length || e.raw_end < e.raw_start) {
      throw new Error(`edit span [${e.raw_start}, ${e.raw_end}) out of range`);
    }
    const slice = rawText.slice(e.raw_start, e.raw_end);
    if (slice !== e.original) {
      throw new Error(`edit no longer matches raw_text: expected "${e.original}", found "${slice}"`);
    }
    out += rawText.slice(cursor, e.raw_start) + e.replacement;
    check += rawText.slice(cursor, e.raw_start) + slice;
    cursor = e.raw_end;
  }
  out += rawText.slice(cursor);
  check += rawText.slice(cursor);
  if (check !== rawText) throw new Error('reconstruction check failed: gaps + originals ≠ raw_text');
  return out;
}

/**
 * Whitespace-safe splice geometry for a MACHINE edit.
 *
 * A model names the text it wants gone (`original`) and what replaces it — but
 * whether the surrounding spaces belong inside that span is an arbitrary
 * framing choice, and splicing it verbatim lets that choice damage a word
 * boundary that nobody asked to change:
 *
 *    "the um bill" − " um"  →  "thebill"     (the space went with the filler)
 *    "the um bill" − "um"   →  "the  bill"   (both spaces stayed)
 *
 * So the accept path re-derives the geometry here instead of trusting it: the
 * span is trimmed to the words themselves, the replacement to its own text, and
 * a pure deletion absorbs exactly ONE of the whitespace runs beside it. The
 * composed clean_text then carries exactly the separation raw_text had — one
 * space where there was whitespace, none where there wasn't.
 *
 * Growth over whitespace is bounded by `limits` (the nearest already-applied
 * edit on each side), so normalising can never manufacture an overlap.
 *
 * Only machine edits go through this. A human joining two words is an intended
 * edit and is applied verbatim — the same trusted-but-transparent split the
 * rest of this module keeps.
 *
 * @returns { raw_start, raw_end, original, replacement } — `original` re-sliced
 *          from rawText so applyEdits' identity check still holds. Returns null
 *          when nothing is left to apply (the edit normalises to a no-op).
 */
function normalizeSpanWhitespace(rawText, edit, limits = {}) {
  const minStart = Math.max(0, limits.minStart ?? 0);
  const maxEnd = Math.min(rawText.length, limits.maxEnd ?? rawText.length);
  const ws = (i) => /\s/.test(rawText[i]);

  let s = edit.raw_start;
  let e = edit.raw_end;
  let replacement = String(edit.replacement ?? '');

  // A whitespace-only span IS a whitespace edit ("  " → " "); its framing is the
  // whole point, so leave it exactly as proposed.
  if (!rawText.slice(s, e).trim()) {
    return { raw_start: s, raw_end: e, original: rawText.slice(s, e), replacement };
  }

  // Trim the framing off both sides: the span shrinks to the words it removes,
  // the replacement to the words it contributes. With both trimmed, a
  // replacement can no longer swallow or duplicate a neighbouring space — the
  // whitespace on each side of the span is left untouched, right where
  // raw_text put it.
  while (s < e && ws(s)) s++;
  while (e > s && ws(e - 1)) e--;
  replacement = replacement.replace(/^\s+/, '').replace(/\s+$/, '');

  // A deletion leaves the whitespace from BOTH sides behind. Absorb one run so
  // the words that close up are separated by a single space — or by nothing,
  // when the deletion is at an edge and there is no word left on that side.
  if (replacement === '') {
    const spaceLeft = s > minStart && ws(s - 1);
    const spaceRight = e < maxEnd && ws(e);
    const wordLeft = rawText.slice(minStart, s).trim() !== '';
    const wordRight = rawText.slice(e, maxEnd).trim() !== '';
    if (spaceRight && (spaceLeft || !wordLeft)) {
      while (e < maxEnd && ws(e)) e++;
    } else if (spaceLeft && !wordRight) {
      while (s > minStart && ws(s - 1)) s--;
    }
  }

  const original = rawText.slice(s, e);
  if (original === replacement) return null;
  return { raw_start: s, raw_end: e, original, replacement };
}

/**
 * The whitespace `normalizeSpanWhitespace` may absorb around `span`: up to the
 * nearest already-applied edit on each side, so two adjacent edits can never
 * grow into each other.
 */
function spanLimits(appliedEdits, span) {
  let minStart = 0;
  let maxEnd = Infinity;
  for (const t of appliedEdits) {
    if (t.raw_end <= span.raw_start) minStart = Math.max(minStart, t.raw_end);
    if (t.raw_start >= span.raw_end) maxEnd = Math.min(maxEnd, t.raw_start);
  }
  return { minStart, maxEnd: maxEnd === Infinity ? undefined : maxEnd };
}

/**
 * Re-anchor an edit against the CURRENT text by its stored `original` substring.
 * The numeric offset is only a hint: prefer it when it still matches exactly
 * (fast, unambiguous), otherwise locate `original` and accept ONLY a unique
 * occurrence. Returns { raw_start, raw_end }, or null when the edit cannot be
 * placed unambiguously (the span is gone, or the substring now occurs more than
 * once). Callers must reject a null cleanly — never guess a position.
 *
 * This keeps sequential accepts safe regardless of offsets: because every span
 * is anchored to the immutable raw_text (not the mutable clean_text), accepting
 * one edit never moves another; and if an offset is ever wrong for any reason,
 * the substring re-locates it or refuses.
 */
function anchorEdit(text, edit) {
  const { raw_start, raw_end, original } = edit;
  if (typeof original !== 'string') return null;
  if (typeof raw_start === 'number' && typeof raw_end === 'number' &&
      raw_start >= 0 && raw_end <= text.length &&
      text.slice(raw_start, raw_end) === original) {
    return { raw_start, raw_end };            // stored offset still valid
  }
  if (original === '') return null;           // can't anchor an empty span by search
  const first = text.indexOf(original);
  if (first === -1) return null;              // gone → genuinely stale
  if (text.indexOf(original, first + 1) !== -1) return null; // ambiguous → don't guess
  return { raw_start: first, raw_end: first + original.length };
}

module.exports = {
  FILLER,
  AUTO_SAFE,
  isBulkAcceptable,
  contentWords,
  classifyEdit,
  locateEdits,
  applyEdits,
  anchorEdit,
  normalizeSpanWhitespace,
  spanLimits,
  // exported for tests / reuse
  soundex,
  phoneticSimilar,
  detectFalseStart,
};
