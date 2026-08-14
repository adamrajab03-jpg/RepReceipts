// Run: node src/utils/cleanupValidate.test.js
// Standalone (no test framework) — prints a table and exits 1 on any failure.
const V = require('./cleanupValidate');

let pass = 0, fail = 0;
const rows = [];

// Assert classifyEdit(original, replacement).class === expect.
function cls(section, original, replacement, expect) {
  const r = V.classifyEdit(original, replacement);
  const ok = r.class === expect;
  ok ? pass++ : fail++;
  rows.push({ section, original, replacement, expect, got: r.class, reason: r.reason, ok });
}

// Generic boolean assertion.
function ok(name, cond) {
  cond ? pass++ : fail++;
  rows.push({ section: 'apply/util', original: name, replacement: '', expect: 'true', got: String(cond), reason: '', ok: !!cond });
}

// ── ADVERSARIAL: these MUST be rejected (the guardrail's whole job) ──────────
cls('ADVERSARIAL→rejected', 'the bill', 'the law', 'rejected');                       // content substitution
cls('ADVERSARIAL→rejected', 'we need', 'we really need', 'rejected');                 // adds a content word
cls('ADVERSARIAL→rejected', '15 members', '50 members', 'rejected');                  // number change
cls('ADVERSARIAL→rejected', 'Cruz and Cantwell', 'Cantwell and Cruz', 'rejected');    // reorder
cls('ADVERSARIAL→rejected', 'we should act now', 'we must act now', 'rejected');       // modal meaning change
cls('ADVERSARIAL→rejected', 'the important bill', 'the bill', 'rejected');             // deletes a real content word
cls('ADVERSARIAL→rejected', 'dont worry', 'do not worry', 'rejected');                 // contraction expansion (adds "not")
cls('ADVERSARIAL→rejected', "there's three reasons", 'there are three reasons', 'rejected'); // grammar fix that changes words (user Q3)
cls('ADVERSARIAL→rejected', 'and so I', 'and so I believe we must act', 'rejected');   // completes an unfinished sentence (user Q3)
cls('ADVERSARIAL→rejected', 'a full and fair hearing', 'a fair and full hearing', 'rejected'); // reorder (diff positions)
cls('ADVERSARIAL→rejected', 'raise taxes', 'cut taxes', 'rejected');                   // antonym swap, not phonetic

// ── transcription_error: surfaced but HUMAN-ACCEPT ONLY (never bulk) ─────────
cls('transcription_error', 'Senator Cantwater', 'Senator Cantwell', 'transcription_error');
cls('transcription_error', 'their are three', 'there are three', 'transcription_error'); // homophone (soundex match)
cls('transcription_error', 'the Commerce Committee', 'the Commerce Committe', 'transcription_error'); // near-miss spelling
ok('transcription_error is NOT bulk-acceptable', V.isBulkAcceptable('transcription_error') === false);

// ── mechanical: punctuation / capitalization / whitespace only (auto-safe) ───
cls('mechanical', 'the senate will come to order', 'The Senate will come to order.', 'mechanical');
cls('mechanical', 'mr chairman', 'Mr. Chairman', 'mechanical');
cls('mechanical', 'yes  i  agree', 'Yes, I agree.', 'mechanical');
ok('mechanical IS bulk-acceptable', V.isBulkAcceptable('mechanical') === true);

// ── filler: single-token disfluency removal (auto-safe) ──────────────────────
cls('filler', 'um, the answer', 'the answer', 'filler');
cls('filler', 'I think, uh, we should', 'I think, we should', 'filler');
cls('filler', 'well, hmm, that depends', 'well, that depends', 'filler');
ok('filler IS bulk-acceptable', V.isBulkAcceptable('filler') === true);
// Multi-word discourse markers are NOT auto-safe filler → rejected (deletes content):
cls('filler (multi-word not auto-safe)', 'the answer, you know, is no', 'the answer, is no', 'rejected');

// ── false_start: VERBATIM adjacent repeat only (auto-safe) ───────────────────
cls('false_start', 'the the bill', 'the bill', 'false_start');
cls('false_start', 'we we need to act', 'we need to act', 'false_start');
cls('false_start', 'I— I think so', 'I think so', 'false_start');
cls('false_start', 'we will we will vote', 'we will vote', 'false_start');           // repeated 2-word run
ok('false_start IS bulk-acceptable', V.isBulkAcceptable('false_start') === true);
// A NON-verbatim "false start" (distinct abandoned phrase) must NOT collapse:
cls('false_start (non-verbatim → rejected)', 'I think— I believe we should', 'I believe we should', 'rejected');

// ── noop ─────────────────────────────────────────────────────────────────────
cls('noop', 'unchanged text', 'unchanged text', 'noop');

// ── applyEdits / locateEdits reconstruction guards ───────────────────────────
{
  const raw = 'Um, the the Senate will come to order';
  // Model returns edits in text order: drop "Um, ", collapse "the the" → "the".
  const proposed = [
    { original: 'Um, ', replacement: '' },
    { original: 'the the', replacement: 'the' },
  ];
  const { located, dropped } = V.locateEdits(raw, proposed);
  ok('locateEdits finds both edits', located.length === 2 && dropped.length === 0);
  const clean = V.applyEdits(raw, located);
  ok('applyEdits derives clean_text', clean === 'the Senate will come to order');
}
{
  // Non-overlap + reconstruction: a stale original must throw, not silently apply.
  const raw = 'the quick brown fox';
  let threw = false;
  try {
    V.applyEdits(raw, [{ raw_start: 4, raw_end: 9, original: 'quicky', replacement: 'x' }]);
  } catch { threw = true; }
  ok('applyEdits rejects an edit whose original no longer matches', threw);
}
{
  // Overlapping edits must throw.
  const raw = 'alpha beta gamma';
  let threw = false;
  try {
    V.applyEdits(raw, [
      { raw_start: 0, raw_end: 9, original: 'alpha bet', replacement: 'x' },
      { raw_start: 6, raw_end: 10, original: 'beta', replacement: 'y' },
    ]);
  } catch { threw = true; }
  ok('applyEdits rejects overlapping edits', threw);
}
{
  // An unlocatable original is dropped, not guessed.
  const raw = 'the cat sat';
  const { located, dropped } = V.locateEdits(raw, [{ original: 'the dog', replacement: 'a dog' }]);
  ok('locateEdits drops an unlocatable original', located.length === 0 && dropped.length === 1);
}

// ── anchorEdit: re-anchor by substring, never guess a position ───────────────
{
  const raw = 'the quick brown fox jumps'
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  ok('anchor: valid stored offset is kept', eq(V.anchorEdit(raw, { raw_start: 4, raw_end: 9, original: 'quick' }), { raw_start: 4, raw_end: 9 }))
  ok('anchor: stale offset re-locates a UNIQUE substring', eq(V.anchorEdit(raw, { raw_start: 999, raw_end: 1004, original: 'brown' }), { raw_start: 10, raw_end: 15 }))
  ok('anchor: missing substring → null (stale)', V.anchorEdit(raw, { raw_start: 0, raw_end: 3, original: 'zzz' }) === null)
  ok('anchor: AMBIGUOUS substring → null (never guesses)', V.anchorEdit('the cat the dog', { raw_start: 999, raw_end: 1002, original: 'the' }) === null)
  ok('anchor: empty original with bad offset → null', V.anchorEdit(raw, { raw_start: 999, raw_end: 1000, original: '' }) === null)
  // Sequential-accept safety: two non-overlapping edits both anchor + apply.
  const rawSeq = 'um, the the Senate will come to order'
  const a = V.anchorEdit(rawSeq, { raw_start: 0, raw_end: 4, original: 'um, ' })
  const b = V.anchorEdit(rawSeq, { raw_start: 4, raw_end: 11, original: 'the the' })
  const clean = V.applyEdits(rawSeq, [
    { ...a, original: 'um, ', replacement: '' },
    { ...b, original: 'the the', replacement: 'the' },
  ])
  ok('anchor+apply: two edits compose to the right result', clean === 'the Senate will come to order')
}

// ── normalizeSpanWhitespace: the splice never damages a word boundary ────────
// Whichever way a model frames the span around a word, accepting it must leave
// the separation raw_text had: one space between the words that close up, none
// where the deletion sits at an edge, and never a doubled space.
{
  // Apply a proposal the way acceptCleanup does, and report the composed text.
  const compose = (raw, original, replacement, limits) => {
    const at = raw.indexOf(original);
    const span = V.normalizeSpanWhitespace(raw, { raw_start: at, raw_end: at + original.length, replacement }, limits);
    return span ? V.applyEdits(raw, [span]) : raw;
  };
  const spaced = (name, raw, original, replacement, expect) =>
    ok(`${name}: ${JSON.stringify(original)}→${JSON.stringify(replacement)} ⇒ ${JSON.stringify(expect)}`,
       compose(raw, original, replacement) === expect);

  // Filler removal — every framing of "um" collapses to exactly one space.
  spaced('filler', 'the um bill', ' um', '', 'the bill');
  spaced('filler', 'the um bill', 'um ', '', 'the bill');
  spaced('filler', 'the um bill', ' um ', '', 'the bill');
  spaced('filler', 'the um bill', 'um', '', 'the bill');          // would have doubled
  spaced('filler', 'the um bill', 'um', ' ', 'the bill');         // whitespace-only replacement
  spaced('filler', 'um the bill', 'um ', '', 'the bill');         // at the start: no leading space
  spaced('filler', 'the bill um', ' um', '', 'the bill');         // at the end: no trailing space
  spaced('filler', 'the um  bill', ' um ', '', 'the bill');       // pre-existing double space closes to one

  // Replacements keep their neighbours' boundaries whatever the framing.
  spaced('replacement', 'the um bill', ' um bill', ' law', 'the law');
  spaced('replacement', 'the um bill', 'the um', 'the', 'the bill');
  spaced('replacement', 'we we need to act', 'we we', 'we', 'we need to act');
  spaced('replacement', 'their are three', 'their', 'there', 'there are three');

  // A genuine whitespace edit is left exactly as proposed — its framing IS the edit.
  spaced('whitespace edit', 'the  bill', '  ', ' ', 'the bill');
  ok('normalize: a span that reduces to no change returns null',
     V.normalizeSpanWhitespace('the um bill', { raw_start: 3, raw_end: 7, replacement: ' um ' }) === null);

  // Growth is bounded by the neighbouring applied edits, so it cannot overlap.
  {
    const raw = 'the um bill passed';                             // an edit already owns " bill"
    const applied = [{ raw_start: 7, raw_end: 11, original: 'bill', replacement: 'law' }];
    const at = raw.indexOf('um');
    const span = V.normalizeSpanWhitespace(raw, { raw_start: at, raw_end: at + 2, replacement: '' },
                                           V.spanLimits(applied, { raw_start: at, raw_end: at + 2 }));
    ok('normalize: growth stops at the neighbouring edit', span.raw_end <= 7);
    ok('normalize: bounded growth still composes correctly',
       V.applyEdits(raw, [span, ...applied].sort((a, b) => a.raw_start - b.raw_start)) === 'the law passed');
  }

  // The composed text never joins two words that raw_text kept apart.
  const merged = (raw, original, replacement) => {
    const out = compose(raw, original, replacement);
    return /\S{2,}/.test(out) && out.split(/\s+/).some((w) => w === 'thebill') ? 'merged' : 'clean';
  };
  ok('normalize: no framing of a filler removal can merge words',
     [' um', 'um ', ' um ', 'um'].every((o) => merged('the um bill', o, '') === 'clean'));
  ok('normalize: no composed result contains a double space',
     [' um', 'um ', ' um ', 'um'].every((o) => !/ {2}/.test(compose('the um bill', o, ''))));
}

// ── Report ───────────────────────────────────────────────────────────────────
const pad = (s, n) => { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
let lastSection = '';
console.log('');
console.log(pad('RESULT', 7) + pad('EXPECT', 21) + pad('GOT', 21) + 'CASE');
console.log('─'.repeat(110));
for (const r of rows) {
  if (r.section !== lastSection) { console.log(`\n  ${r.section}`); lastSection = r.section; }
  const label = r.replacement === '' && r.expect === 'true'
    ? r.original
    : `"${r.original}"  →  "${r.replacement}"`;
  console.log(
    pad(r.ok ? '  ok' : ' FAIL', 7) +
    pad(r.expect, 21) +
    pad(r.got, 21) +
    label +
    (r.ok ? '' : `   [${r.reason}]`)
  );
}
console.log('─'.repeat(110));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
