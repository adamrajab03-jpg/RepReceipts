// Run: node src/utils/turnContent.test.js
// Standalone (no test framework) — prints a table and exits 1 on any failure.
//
// The content invariants of migration 015, driven through the SAME functions
// adminController runs: firstFillPlan (editTurnText), planMerge (mergeTurn),
// splitAtWord / splitAtChar (splitTurn). A turn here is shaped exactly like
// the row each endpoint reads and writes.
const { displayableSql, hasDisplayableText, firstFillPlan, planMerge, mergedOrigin } = require('./turnContent');
const { splitAtWord, splitAtChar } = require('./turnText');

let pass = 0, fail = 0;
const rows = [];
function check(section, name, cond, detail = '') {
  cond ? pass++ : fail++;
  rows.push({ section, name, ok: !!cond, detail });
}
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// ── Rows as the endpoints shape them ─────────────────────────────────────────
const asrTurn = (raw, t0 = 0) => ({
  raw_text: raw, clean_text: null, text_origin: 'asr',
  word_times: raw.split(/\s+/).filter(Boolean).map((w, i) => ({ w, s: t0 + i * 300, e: t0 + i * 300 + 250 })),
});
/** insertTurn: raw_text '', origin 'human', no timing. */
const insertedTurn = () => ({ raw_text: '', clean_text: null, text_origin: 'human', word_times: null });
/** editTurnText on an inserted turn: what the UPDATE writes. */
function typeInto(turn, text) {
  const fill = firstFillPlan(turn, text);
  return { ...turn, raw_text: fill.raw_text, clean_text: null, text_origin: fill.text_origin };
}
/** mergeTurn: what the survivor becomes (clean_text reset, as the UPDATE does). */
function merge(first, second, joiner = ' ') {
  const p = planMerge(first, second, joiner);
  return { raw_text: p.merged, clean_text: null, word_times: p.wordTimes, text_origin: p.textOrigin, _plan: p };
}
const display = (t) => t.clean_text ?? t.raw_text;
const words = (s) => s.split(/\s+/).filter(Boolean);
const containsInOrder = (hay, needle) => hay.join(' ').includes(needle.join(' '));

// ════════════════════════════════════════════════════════════════════════════
//  Visibility — one definition, "would the page render words?"
// ════════════════════════════════════════════════════════════════════════════
{
  const S = 'visible';
  check(S, 'ASR turn', hasDisplayableText({ raw_text: 'We must act.', clean_text: null }));
  check(S, 'words only in clean_text (the pre-015 seq-80 shape) → SHOWN', hasDisplayableText({ raw_text: '', clean_text: 'Yes. Are you saying…' }));
  check(S, 'unfilled inserted slot → hidden', !hasDisplayableText({ raw_text: '', clean_text: null }));
  check(S, 'whitespace-only → hidden', !hasDisplayableText({ raw_text: '  ', clean_text: '\n ' }));
  check(S, 'mirrors the page: clean_text wins when present', !hasDisplayableText({ raw_text: 'words', clean_text: '' }), '(renders "" → nothing to show)');
  check(S, 'SQL twin, aliased', displayableSql('st') === "btrim(coalesce(st.clean_text, st.raw_text, '')) <> ''");
  check(S, 'SQL twin, bare columns', displayableSql('') === "btrim(coalesce(clean_text, raw_text, '')) <> ''");
}

// ════════════════════════════════════════════════════════════════════════════
//  First fill — typing into an inserted turn writes its raw_text
// ════════════════════════════════════════════════════════════════════════════
{
  const S = 'first fill';
  const t = typeInto(insertedTurn(), '  Yes. Are you saying that a mask a cloth mask does not stop the spread?  ');
  check(S, 'typed words become raw_text (trimmed)', t.raw_text === 'Yes. Are you saying that a mask a cloth mask does not stop the spread?');
  check(S, 'origin recorded as human', t.text_origin === 'human');
  check(S, 'no clean_text-only copy left behind', t.clean_text === null);
  check(S, 'filled turn is visible', hasDisplayableText(t));
  check(S, 'an already-transcribed turn is NOT first-filled (normal edit path)', firstFillPlan(asrTurn('We must act.'), 'We must act now.') === null);
  const blank = throws(() => firstFillPlan(insertedTurn(), '   '));
  check(S, 'blank save on an empty turn refused (400)', blank?.status === 400, blank?.message ?? '');
}

// ════════════════════════════════════════════════════════════════════════════
//  Merge never drops a turn's only content
// ════════════════════════════════════════════════════════════════════════════
{
  const S = 'merge';
  const neighbour = asrTurn('I said that the mRNA vaccine did not stop infection.', 2_440_085);
  const typedText = 'Yes. Are you saying that a mask a cloth mask does not stop the spread of COVID?';

  // THE REQUESTED TEST: insert a turn, type text, merge into a neighbour.
  const typed = typeInto(insertedTurn(), typedText);
  const down = merge(typed, neighbour);     // typed turn merged DOWN (it reads first)
  check(S, 'insert → type → merge down: every typed word survives, in order',
    containsInOrder(words(display(down)), words(typedText)), `→ "${display(down).slice(0, 60)}…"`);
  check(S, '…and every neighbour word survives too', containsInOrder(words(display(down)), words(neighbour.raw_text)));
  check(S, '…merged record is exactly typed + " " + neighbour', down.raw_text === `${typedText} ${neighbour.raw_text}`);
  const up = merge(neighbour, typed);       // typed turn merged UP (it reads second)
  check(S, 'insert → type → merge up: every typed word survives, in order', containsInOrder(words(display(up)), words(typedText)));
  check(S, 'reviewer + ASR → origin "mixed"', down.text_origin === 'mixed' && up.text_origin === 'mixed');
  check(S, 'reviewer side has no timing → merged turn untimed, flagged', down.word_times === null && down._plan.wtLost === true);

  // The legacy shape — words only in clean_text — is refused, never dropped.
  const legacy = { raw_text: '', clean_text: typedText, text_origin: 'human', word_times: null };
  const refused = throws(() => planMerge(legacy, neighbour, ' '));
  check(S, 'words only in clean_text → merge REFUSED (422), not silently deleted', refused?.status === 422, refused?.message?.slice(0, 60) ?? '');

  // Ordinary merges are unchanged.
  const a = asrTurn('We must act now.', 0);
  const b = asrTurn('The data is clear.', 5_000);
  const ab = merge(a, b);
  check(S, 'ASR + ASR → origin "asr", timing concatenated', ab.text_origin === 'asr' && ab.word_times.length === 8 && ab._plan.wtLost === false);
  const withSlot = merge(a, insertedTurn());
  check(S, 'merging an unfilled slot changes nothing but removes it', withSlot.raw_text === a.raw_text && withSlot.text_origin === 'asr' && withSlot.word_times.length === 4);
  check(S, 'origin table: human+human → human, slot+slot → human',
    mergedOrigin(typed, typed) === 'human' && mergedOrigin(insertedTurn(), insertedTurn()) === 'human');
}

// ════════════════════════════════════════════════════════════════════════════
//  Split keeps every word, and halves inherit the origin
// ════════════════════════════════════════════════════════════════════════════
{
  const S = 'split';
  const typedText = 'Yes. Are you saying that a mask does not stop the spread?';
  const typed = typeInto(insertedTurn(), typedText);
  // A reviewer's turn has no timing → splitTurn takes the char-offset path.
  const at = typedText.indexOf(' Are');
  const p = splitAtChar(typed.raw_text, at);
  check(S, 'reviewer turn splits (untimed path) with no word lost', p.textA + p.joiner + p.textB === typedText && p.textA === 'Yes.' && p.textB.startsWith('Are'));

  // The merged (mixed, untimed) turn can be split back at the seam.
  const neighbour = asrTurn('I said that the vaccine did not stop infection.', 10_000);
  const merged = merge(typed, neighbour);
  const seam = merged.raw_text.indexOf(' I said');
  const back = splitAtChar(merged.raw_text, seam);
  check(S, 'merge then split at the seam → both texts back, byte for byte', back.textA === typedText && back.textB === neighbour.raw_text);

  // The new joiner guard: word_times that don't cover every word must not let
  // a split silently drop the uncovered words into the (discarded) joiner.
  const partial = { raw_text: 'We must act now today.', word_times: [{ w: 'We', s: 0, e: 1 }, { w: 'must', s: 2, e: 3 }, { w: 'today.', s: 8, e: 9 }] };
  const guard = throws(() => splitAtWord(partial.raw_text, partial.word_times, 2));   // between "must" and "today." sit untimed "act now"
  check(S, 'split refuses when untimed words would fall into the joiner (422)', guard?.status === 422, guard?.message ?? '');
  const ok = splitAtWord('We must act now.', asrTurn('We must act now.').word_times, 2);
  check(S, 'normal timed split unaffected', ok.textA === 'We must' && ok.textB === 'act now.');
}

// ── Report ───────────────────────────────────────────────────────────────────
const w = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
console.log(`\n${w('', 3)}${w('section', 12)}${w('check', 78)}detail`);
console.log('─'.repeat(140));
let last = '';
for (const r of rows) {
  if (r.section !== last && last) console.log('');
  last = r.section;
  console.log(`${r.ok ? ' ✓ ' : ' ✗ '}${w(r.section, 12)}${w(r.name, 78)}${r.detail}`);
}
console.log('─'.repeat(140));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
