// ============================================================================
//  Manual-edit diff — derive discrete raw-span replacements from a hand-edited
//  turn, so a free-form inline edit becomes a set of hoverable, revertible
//  edits with each original raw span recorded.
// ----------------------------------------------------------------------------
//  raw_text stays canonical: a human edit is stored as spans over raw_text, and
//  clean_text = applyEdits(raw_text, spans). We diff at the "atom" level (each
//  atom is a whitespace run OR a non-whitespace run) so spans land on word
//  boundaries and the concatenation of atoms reconstitutes the string exactly.
//  Callers MUST assert applyEdits(raw, diffToEdits(raw, next)) === next before
//  trusting the result (see cleanupValidate.applyEdits).
// ============================================================================

function segment(s) {
  return s.match(/\s+|\S+/g) || [];
}

/**
 * Minimal set of replacement spans turning `raw` into `next`.
 * @returns [{ raw_start, raw_end, original, replacement }]  in raw order.
 */
function diffToEdits(raw, next) {
  const A = segment(raw);
  const B = segment(next);
  const n = A.length, m = B.length;

  // LCS length table (bottom-up), then backtrack into an op stream.
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ t: 'eq', a: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: 'del', a: A[i] }); i++; }
    else { ops.push({ t: 'ins', b: B[j] }); j++; }
  }
  while (i < n) { ops.push({ t: 'del', a: A[i] }); i++; }
  while (j < m) { ops.push({ t: 'ins', b: B[j] }); j++; }

  // Coalesce maximal runs of del/ins (between eq atoms) into one span each.
  const edits = [];
  let rawPos = 0;
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === 'eq') { rawPos += ops[k].a.length; k++; continue; }
    const start = rawPos;
    let original = '';
    let replacement = '';
    while (k < ops.length && ops[k].t !== 'eq') {
      if (ops[k].t === 'del') { original += ops[k].a; rawPos += ops[k].a.length; }
      else replacement += ops[k].b;
      k++;
    }
    edits.push({ raw_start: start, raw_end: rawPos, original, replacement });
  }
  return edits;
}

// ============================================================================
//  Composition — layering a manual edit ON TOP OF an existing edit stack.
// ----------------------------------------------------------------------------
//  A turn's edit stack (suggestions.text_edits) mixes accepted LLM cleanup edits
//  and human edits; clean_text = applyEdits(raw_text, stack). The inline editor
//  shows that CLEANED text, so a manual save must be diffed against the cleaned
//  base, not against raw_text.
//
//  Diffing against raw_text (the old behaviour) silently destroyed provenance:
//  an accepted LLM edit is anchored to the model's own `original`, which carries
//  unchanged context ("as mister Volok said" → "as mister Volokh said"), while a
//  re-diff always yields the MINIMAL span ("Volok" → "Volokh"). The two can
//  never be equal, so every accepted cleanup edit was re-stamped source:'human'.
//
//  Composition instead maps the human's changes back onto raw coordinates and
//  keeps every edit the human did not touch exactly as it was:
//
//    raw ──stack──> base ──human diff──> submitted
//
//  An LLM edit whose output the human overwrote is CONSUMED by the resulting
//  human edit (a person authored that text now, so the record must say human),
//  but its origin is preserved on `supersedes` so nothing is lost.
// ============================================================================

/**
 * Split raw into alternating untouched gaps and edit outputs, carrying both raw
 * and base (cleaned) coordinates. Returns null if the stack is malformed.
 */
function buildSegments(raw, edits) {
  const sorted = [...edits].sort((a, b) => a.raw_start - b.raw_start);
  const segs = [];
  let rawPos = 0;
  let basePos = 0;
  for (const e of sorted) {
    if (typeof e.raw_start !== 'number' || typeof e.raw_end !== 'number') return null;
    if (e.raw_start < rawPos || e.raw_end < e.raw_start || e.raw_end > raw.length) return null; // overlap / out of range
    if (raw.slice(e.raw_start, e.raw_end) !== e.original) return null;                          // stale against raw_text
    if (e.raw_start > rawPos) {
      const len = e.raw_start - rawPos;
      segs.push({ edit: null, rawStart: rawPos, rawEnd: e.raw_start, baseStart: basePos, baseEnd: basePos + len });
      basePos += len;
    }
    segs.push({ edit: e, rawStart: e.raw_start, rawEnd: e.raw_end, baseStart: basePos, baseEnd: basePos + e.replacement.length });
    basePos += e.replacement.length;
    rawPos = e.raw_end;
  }
  if (rawPos < raw.length) {
    const len = raw.length - rawPos;
    segs.push({ edit: null, rawStart: rawPos, rawEnd: raw.length, baseStart: basePos, baseEnd: basePos + len });
  }
  return segs;
}

/** The cleaned text a segment list represents. */
function segmentsToBase(raw, segs) {
  return segs.map((s) => (s.edit ? s.edit.replacement : raw.slice(s.rawStart, s.rawEnd))).join('');
}

/**
 * Layer `submitted` (a hand-edit of the CLEANED text) onto `existing`.
 *
 * @returns {{ edits: Array, base: string }|null} merged stack in raw order, or
 *   null when the stack is malformed / the change cannot be mapped. Callers MUST
 *   still assert applyEdits(raw, edits) === submitted before trusting it.
 */
function composeEdits(raw, existing, submitted, now = new Date().toISOString()) {
  const segs = buildSegments(raw, existing || []);
  if (!segs) return null;
  const base = segmentsToBase(raw, segs);
  if (submitted === base) {
    return { edits: (existing || []).map((e) => ({ ...e })), base }; // no manual change → stack untouched
  }

  // Human changes, in BASE coordinates.
  const humanDiff = diffToEdits(base, submitted);

  // A base offset is a safe cut point only where it corresponds to a real raw
  // offset: anywhere in an untouched gap, or exactly on an edit's boundary.
  const toRaw = (pos) => {
    for (const s of segs) {
      if (pos < s.baseStart || pos > s.baseEnd) continue;
      if (!s.edit) return s.rawStart + (pos - s.baseStart);
      if (pos === s.baseStart) return s.rawStart;
      if (pos === s.baseEnd) return s.rawEnd;
      return null; // strictly inside an edit's output — no raw offset exists
    }
    return pos === 0 ? 0 : null; // empty stack / empty raw
  };

  // Grow every changed span outward to whole edit segments, then merge whatever
  // now overlaps or touches. Repeat to a fixpoint: merging can pull in another
  // edit segment, which can force another merge.
  const expand = (span) => {
    let { bs, be } = span;
    for (const s of segs) {
      if (!s.edit) continue;
      const overlaps = bs < s.baseEnd && s.baseStart < be;
      const insertionInside = bs === be && bs > s.baseStart && bs < s.baseEnd;
      // A prior edit that inserted text occupies NO raw span, so raw offsets
      // cannot order it against a new insertion at the same point. Absorb it
      // (such edits are always human — LLM edits never have an empty original)
      // so the two never race for the same offset.
      const touchesInsertion = s.rawStart === s.rawEnd && bs <= s.baseEnd && s.baseStart <= be;
      if (overlaps || insertionInside || touchesInsertion) {
        bs = Math.min(bs, s.baseStart);
        be = Math.max(be, s.baseEnd);
      }
    }
    return { bs, be };
  };
  let spans = humanDiff.map((d) => ({ bs: d.raw_start, be: d.raw_end }));
  for (let guard = 0; ; guard++) {
    if (guard > 64) return null; // pathological — refuse rather than loop
    const grown = spans.map(expand).sort((a, b) => a.bs - b.bs || a.be - b.be);
    const merged = [];
    for (const s of grown) {
      const last = merged[merged.length - 1];
      if (last && s.bs <= last.be) last.be = Math.max(last.be, s.be);
      else merged.push({ ...s });
    }
    const settled = JSON.stringify(merged) === JSON.stringify(spans);
    spans = merged;
    if (settled) break;
  }

  // Locate each span inside `submitted`. Every diff is contained in exactly one
  // span (expansion only grows them), so walking both lists in order gives an
  // exact offset — no positional arithmetic that a pure insertion could fool:
  // a zero-length span must still map to the text that was inserted INTO it.
  const byStart = [...humanDiff].sort((a, b) => a.raw_start - b.raw_start || a.raw_end - b.raw_end);
  const placed = [];
  let di = 0;
  let carried = 0; // submitted-vs-base drift accumulated before the current span
  for (const s of spans) {
    while (di < byStart.length && byStart[di].raw_end <= s.bs && byStart[di].raw_start < s.bs) {
      const d = byStart[di++];
      carried += d.replacement.length - (d.raw_end - d.raw_start);
    }
    const subStart = s.bs + carried;
    let inner = 0;
    while (di < byStart.length && byStart[di].raw_start >= s.bs && byStart[di].raw_end <= s.be) {
      const d = byStart[di++];
      inner += d.replacement.length - (d.raw_end - d.raw_start);
    }
    carried += inner;
    placed.push({ bs: s.bs, be: s.be, subStart, subEnd: subStart + (s.be - s.bs) + inner });
  }
  if (di !== byStart.length) return null; // a change escaped every span — refuse

  const out = [];
  const consumed = new Set();
  for (const s of placed) {
    const rawStart = toRaw(s.bs);
    const rawEnd = toRaw(s.be);
    const { subStart, subEnd } = s;
    if (rawStart == null || rawEnd == null) return null;
    if (rawEnd < rawStart || subEnd < subStart || subEnd > submitted.length) return null;

    const original = raw.slice(rawStart, rawEnd);
    const replacement = submitted.slice(subStart, subEnd);

    const swallowed = (existing || []).filter((e) =>
      (e.raw_start < rawEnd && rawStart < e.raw_end) ||
      (e.raw_start === e.raw_end && e.raw_start >= rawStart && e.raw_end <= rawEnd) // absorbed insertion
    );
    for (const e of swallowed) consumed.add(e);

    if (original === replacement) continue; // the human undid this region back to raw

    const edit = { source: 'human', raw_start: rawStart, raw_end: rawEnd, original, replacement, at: now };
    // Keep the history of any accepted cleanup this manual edit overwrote.
    const priorLlm = swallowed.filter((e) => e.source === 'llm');
    if (priorLlm.length) {
      edit.supersedes = priorLlm.map((e) => ({
        source: 'llm', class: e.class ?? null, original: e.original, replacement: e.replacement, at: e.at ?? null,
      }));
    }
    out.push(edit);
  }

  // Everything the human never touched survives byte-for-byte — this is the
  // whole point: accepted LLM edits keep source:'llm', their class and their
  // accept timestamp, so they stay emerald in the workbench.
  for (const e of existing || []) if (!consumed.has(e)) out.push({ ...e });
  out.sort((a, b) => a.raw_start - b.raw_start);
  return { edits: out, base };
}

module.exports = { diffToEdits, segment, composeEdits, buildSegments, segmentsToBase };
