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

module.exports = { diffToEdits, segment };
