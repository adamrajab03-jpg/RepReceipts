// Synthetic edge cases for composeEdits. Pure functions, no DB.
const { composeEdits } = require('../src/utils/textDiff');
const { applyEdits } = require('../src/utils/cleanupValidate');

let fail = 0;
function t(name, raw, existing, submitted, expect) {
  const c = composeEdits(raw, existing, submitted, 'T');
  if (!c) { console.log(`FAIL  ${name} — compose refused`); fail++; return; }
  let rebuilt = null;
  try { rebuilt = applyEdits(raw, c.edits); } catch (e) { console.log(`FAIL  ${name} — applyEdits threw: ${e.message}`); fail++; return; }
  const llm = c.edits.filter(e => e.source === 'llm');
  const human = c.edits.filter(e => e.source === 'human');
  const errs = [];
  if (rebuilt !== submitted) errs.push(`text ${JSON.stringify(rebuilt)} != ${JSON.stringify(submitted)}`);
  if (expect.llm != null && llm.length !== expect.llm) errs.push(`llm ${llm.length} != ${expect.llm}`);
  if (expect.human != null && human.length !== expect.human) errs.push(`human ${human.length} != ${expect.human}`);
  if (expect.supersedes != null) {
    const n = human.filter(e => e.supersedes).length;
    if (n !== expect.supersedes) errs.push(`supersedes ${n} != ${expect.supersedes}`);
  }
  if (errs.length) { console.log(`FAIL  ${name} — ${errs.join('; ')}`); fail++; }
  else console.log(`  ok  ${name}  (${llm.length} llm / ${human.length} human)`);
}

// Anchor spans by substring so the fixtures can't drift from hand-counted offsets.
const at = (raw, original, replacement, source) => {
  const i = raw.indexOf(original);
  if (i < 0) throw new Error(`fixture: ${JSON.stringify(original)} not in raw`);
  return { source, raw_start: i, raw_end: i + original.length, original, replacement, at: 'A', ...(source === 'llm' ? { class: 'mechanical' } : {}) };
};
const llmEdit = (raw, o, r) => at(raw, o, r, 'llm');
const humanEdit = (raw, o, r) => at(raw, o, r, 'human');

const RAW = 'the the bill is is good';
const FS = llmEdit(RAW, 'the the ', 'the ');    // → base "the bill is is good"
const FS2 = llmEdit(RAW, ' is is', ' is');      // → base "the bill is good"

// One accepted cleanup, human edits a DIFFERENT word → cleanup must survive.
t('adjacent word edit keeps the cleanup edit', RAW, [FS], 'the BILL is is good', { llm: 1, human: 1 });

// Human edits the word immediately after the cleanup span.
t('immediately-following edit keeps the cleanup edit', RAW, [FS], 'the billX is is good', { llm: 1, human: 1 });

// Two cleanups, human edit on untouched text BETWEEN them → both survive.
t('edit between two cleanups keeps both', RAW, [FS, FS2], 'the BILL is good', { llm: 2, human: 1 });

// Editing text that IS a cleanup's output consumes that cleanup (a person
// authored those words now) and leaves the other one alone.
t('editing a cleanup output consumes only that one', RAW, [FS, FS2], 'the bill IS good', { llm: 1, human: 1, supersedes: 1 });

// Human edit that swallows one cleanup's output.
t('overwriting one cleanup consumes only that one', RAW, [FS, FS2], 'THE bill is good', { llm: 1, human: 1, supersedes: 1 });

// Human edit spanning BOTH cleanups.
t('edit spanning both cleanups consumes both', RAW, [FS, FS2], 'X good', { llm: 0, human: 1, supersedes: 1 });

// Manually re-typing the raw wording is text-exact, but stays represented as
// "cleanup still applies + human re-inserted it" rather than collapsing back —
// the tidy way to undo an accepted cleanup is to dismiss the suggestion.
t('manually re-typing raw wording is text-exact', RAW, [FS, FS2], 'the the bill is good', { llm: 2, human: 1 });

// Pure insertions.
t('insert at end', RAW, [FS], 'the bill is is good NOW', { llm: 1, human: 1 });
t('insert at start', RAW, [FS], 'NOW the bill is is good', { llm: 1, human: 1 });
t('two insertions at once', RAW, [FS], 'NOW the bill is is good NOW', { llm: 1, human: 2 });

// Repeated saves must not degrade.
(() => {
  let edits = [FS];
  let text = 'the bill is is good';
  for (let i = 0; i < 4; i++) {
    const next = text + ` P${i}`;
    const c = composeEdits(RAW, edits, next, 'T');
    if (!c) { console.log('FAIL  repeated saves — refused'); fail++; return; }
    edits = c.edits; text = applyEdits(RAW, edits);
    if (text !== next) { console.log(`FAIL  repeated saves — text drift at ${i}`); fail++; return; }
  }
  const llm = edits.filter(e => e.source === 'llm').length;
  if (llm !== 1) { console.log(`FAIL  repeated saves — llm ${llm} != 1`); fail++; }
  else console.log(`  ok  4 repeated saves keep llm provenance  (${llm} llm / ${edits.filter(e => e.source === 'human').length} human)`);
})();

// Human edits stack alongside LLM ones.
t('existing human + llm both survive an unrelated edit', RAW, [FS, humanEdit(RAW, 'ood', 'OOD')].sort((a, b) => a.raw_start - b.raw_start),
  'the bill IS is gOOD', { llm: 1, human: 2 });

// No existing stack → plain manual edit.
t('empty stack behaves like a plain edit', RAW, [], 'the the bill is is GOOD', { llm: 0, human: 1 });

// No change at all.
t('no-op save changes nothing', RAW, [FS, FS2], 'the bill is good', { llm: 2, human: 0 });

// Unicode / multi-byte safety.
const U = 'the — em dash café is is here';
t('unicode edit keeps the cleanup edit', U, [llmEdit(U, ' is is', ' is')], 'the — em dash CAFÉ is here', { llm: 1, human: 1 });

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall synthetic edge cases passed');
process.exit(fail ? 1 : 0);
