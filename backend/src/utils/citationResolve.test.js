// Run: node src/utils/citationResolve.test.js
// Standalone (no test framework) — prints a table and exits 1 on any failure.
//
// Every row of the plan's scenario table, plus the speaker checks and the
// snapshot rules. Each scenario SHARES a quote from a transcript, applies the
// edit a real admin action would make — structural edits go through the real
// splitAtWord / mergeTexts from turnText.js, exactly as adminController uses
// them — and then resolves the ORIGINAL citation against the result.
const { resolveCitation, TUNING } = require('./citationResolve');
const { snapshotQuote, speakerSnapshot, displayText } = require('./citationSnapshot');
const { splitAtWord, mergeTexts } = require('./turnText');

let pass = 0, fail = 0;
const rows = [];

// ── Fixture builders ─────────────────────────────────────────────────────────
const MEMBERS = {
  cantwell:  { member_id: 'm-cantwell',  member_full_name: 'Maria Cantwell',  party: 'D', state: 'WA', chamber: 'senate', speaker_role: 'chair' },
  blackburn: { member_id: 'm-blackburn', member_full_name: 'Marsha Blackburn', party: 'R', state: 'TN', chamber: 'senate', speaker_role: 'member' },
  cruz:      { member_id: 'm-cruz',      member_full_name: 'Ted Cruz',         party: 'R', state: 'TX', chamber: 'senate', speaker_role: 'member' },
  klobuchar: { member_id: 'm-klobuchar', member_full_name: 'Amy Klobuchar',    party: 'D', state: 'MN', chamber: 'senate', speaker_role: 'member' },
};
const WITNESS = (name) => ({ member_id: null, member_full_name: null, speaker_name: name, speaker_role: 'witness' });
const UNATTRIBUTED = (label) => ({ member_id: null, member_full_name: null, speaker_name: null, speaker_role: 'unknown' });

/** A turn with Deepgram-shaped word_times: 300 ms per word from t0. */
function turn(id, raw, who, t0, { untimed = false } = {}) {
  const words = raw.split(/\s+/).filter(Boolean);
  return {
    id, raw_text: raw, clean_text: null,
    word_times: untimed ? null : words.map((w, i) => ({ w, s: t0 + i * 300, e: t0 + i * 300 + 250 })),
    start_ms: t0,
    speaker_label_raw: who.speaker_label_raw ?? `Speaker ${id}`,
    speaker_name: null, party: null, state: null, chamber: null,
    ...who,
  };
}

const BASE = () => [
  turn('T1', 'Thank you, Mr. Chairman. The committee will come to order and we will hear from our witnesses today.', MEMBERS.cantwell, 0),
  turn('T2', 'Thank you, Mr. Chairman. Big Tech has failed our children and the data shows it plainly. We need the Kids Online Safety Act passed this year, not next year.', MEMBERS.blackburn, 60_000),
  turn('T3', 'Senator, the research is clear that social media harms teen mental health in measurable ways.', WITNESS('Dr. Jane Smith'), 120_000),
  turn('T4', 'I would add that platforms have known about these harms for years and chose engagement over safety.', { ...UNATTRIBUTED(), speaker_label_raw: 'Speaker 2' }, 180_000),
  turn('T5', 'Thank you, Mr. Chairman. I yield back the balance of my time.', MEMBERS.cruz, 240_000),
];

/** Share `phrase` (by its `nth` occurrence) from turn `id` — what POST /api/citations does. */
function share(turns, id, phrase, nth = 0) {
  const t = turns.find((x) => x.id === id);
  const text = displayText(t);
  let at = -1;
  for (let k = 0; k <= nth; k++) at = text.indexOf(phrase, at + 1);
  if (at === -1) throw new Error(`fixture: "${phrase}" not in ${id}`);
  return { anchor_turn_id: id, ...snapshotQuote(t, at, at + phrase.length), ...speakerSnapshot(t) };
}

// ── Edits, as the admin endpoints make them ──────────────────────────────────
const cloneTurns = (turns) => turns.map((t) => ({ ...t }));
/** An accepted text edit: only clean_text is written (adminController.js:38). */
function editText(turns, id, from, to) {
  const out = cloneTurns(turns);
  const t = out.find((x) => x.id === id);
  const text = displayText(t);
  if (!text.includes(from)) throw new Error(`fixture: "${from}" not in ${id}`);
  t.clean_text = text.replace(from, to);
  return out;
}
function replaceText(turns, id, text) {
  const out = cloneTurns(turns);
  out.find((x) => x.id === id).clean_text = text;
  return out;
}
/** splitTurn: half A keeps the id, half B is new; both halves lose clean_text. */
function split(turns, id, beforePhrase, assignB = null) {
  const out = cloneTurns(turns);
  const i = out.findIndex((x) => x.id === id);
  const o = out[i];
  const k = o.raw_text.slice(0, o.raw_text.indexOf(beforePhrase)).split(/\s+/).filter(Boolean).length;
  const p = splitAtWord(o.raw_text, o.word_times, k);
  const A = { ...o, raw_text: p.textA, word_times: p.wtA, clean_text: null };
  const B = { ...o, id: `${id}b`, raw_text: p.textB, word_times: p.wtB, clean_text: null, start_ms: p.wtB[0].s, ...(assignB ?? {}) };
  out.splice(i, 1, A, B);
  return out;
}
/** mergeTurn 'up': the victim's text joins the previous turn, which keeps ITS
 *  identity; the victim row is deleted; an untimed side poisons word_times. */
function mergeUp(turns, victimId) {
  const out = cloneTurns(turns);
  const i = out.findIndex((x) => x.id === victimId);
  const target = out[i - 1];
  const victim = out[i];
  const { merged } = mergeTexts(target.raw_text, victim.raw_text, ' ');
  out[i - 1] = {
    ...target, raw_text: merged, clean_text: null,
    word_times: target.word_times && victim.word_times ? [...target.word_times, ...victim.word_times] : null,
  };
  out.splice(i, 1);
  return out;
}
function reattribute(turns, id, who) {
  const out = cloneTurns(turns);
  const i = out.findIndex((x) => x.id === id);
  out[i] = { ...out[i], member_id: null, member_full_name: null, speaker_name: null, party: null, state: null, chamber: null, ...who };
  return out;
}
/** A fresh transcription of the same audio: new turn ids, times jittered. */
function retranscribe(turns, jitterMs, rewrite = (s) => s) {
  return turns.map((t) => {
    const raw = rewrite(displayText(t));
    const words = raw.split(/\s+/).filter(Boolean);
    return {
      ...t, id: `${t.id}-v2`, raw_text: raw, clean_text: null,
      word_times: words.map((w, k) => ({ w, s: t.start_ms + jitterMs + k * 300, e: t.start_ms + jitterMs + k * 300 + 250 })),
    };
  });
}
/** ON DELETE SET NULL, as the database applies it once the anchor turn is gone. */
const afterEdit = (citation, turns) =>
  turns.some((t) => t.id === citation.anchor_turn_id) ? citation : { ...citation, anchor_turn_id: null };

// ── Assertions ───────────────────────────────────────────────────────────────
/**
 * Resolve and compare the fields named in `expect`. Special keys:
 *   turns — the segment turn ids, in order
 *   text  — current_text
 *   speaker — the first located segment's current speaker name
 */
function scenario(section, name, citation, turns, expect) {
  const r = resolveCitation(afterEdit(citation, turns), turns);
  const got = {
    status: r.status, change: r.change, located_by: r.located_by,
    turns: r.segments.map((s) => s.turn_id).join('+') || '—',
    text: r.current_text, speaker: r.current_speakers[0]?.name ?? null,
    attribution_changed: r.attribution_changed, mixed_speakers: r.mixed_speakers,
    similarity: r.similarity,
  };
  const bad = Object.entries(expect).filter(([k, v]) => got[k] !== v);
  bad.length ? fail++ : pass++;
  rows.push({
    section, name,
    expect: Object.entries(expect).map(([k, v]) => `${k}=${v}`).join(' '),
    got: `${got.status}${got.change ? `/${got.change}` : ''} by=${got.located_by ?? '—'} turns=${got.turns}` +
         `${got.attribution_changed ? ' ATTR≠' : ''}${got.mixed_speakers ? ' MIXED' : ''}` +
         `${got.similarity != null && got.similarity < 1 ? ` sim=${got.similarity}` : ''}` +
         (bad.length ? `  ✗ ${bad.map(([k]) => `${k}=${JSON.stringify(got[k])}`).join(' ')}` : ''),
    ok: !bad.length,
  });
}
function check(section, name, cond, detail = '') {
  cond ? pass++ : fail++;
  rows.push({ section, name, expect: 'true', got: `${cond}${detail ? ` ${detail}` : ''}`, ok: !!cond });
}

// ════════════════════════════════════════════════════════════════════════════
//  SCENARIO TABLE
// ════════════════════════════════════════════════════════════════════════════
{
  const S = 'text';
  const base = BASE();
  const q = share(base, 'T2', 'Big Tech has failed our children');

  scenario(S, 'nothing changed', q, base,
    { status: 'match', located_by: 'hint', turns: 'T2', attribution_changed: false });

  {
    const t = editText(base, 'T2', 'Thank you, Mr. Chairman.', 'Well, thank you very much, Mr. Chairman.');
    scenario(S, 'edit elsewhere in the turn (offsets shift)', q, t,
      { status: 'match', located_by: 'exact', turns: 'T2', text: 'Big Tech has failed our children' });
  }
  scenario(S, 'punctuation-only inside quote', q, editText(base, 'T2', 'our children and', 'our children, and'),
    { status: 'diverged', change: 'formatting', turns: 'T2', text: 'Big Tech has failed our children,' });
  scenario(S, 'capitalisation-only inside quote', q, editText(base, 'T2', 'Big Tech', 'big tech'),
    { status: 'diverged', change: 'formatting', text: 'big tech has failed our children' });
  scenario(S, 'word replaced inside quote', q, editText(base, 'T2', 'has failed', 'has betrayed'),
    { status: 'diverged', change: 'wording', located_by: 'time', text: 'Big Tech has betrayed our children' });
  {
    // The selection ends at "year" but the snapshot snaps out to the whole
    // token, "year," — the comma is part of the word as written.
    const q2 = share(base, 'T2', 'We need the Kids Online Safety Act passed this year');
    check(S, 'selection snapped to whole token "year,"', q2.quoted_text.endsWith('this year,'), `→ "${q2.quoted_text}"`);
    scenario(S, 'word removed inside quote', q2, editText(base, 'T2', 'need the Kids', 'need Kids'),
      { status: 'diverged', change: 'wording', text: 'We need Kids Online Safety Act passed this year,' });
    scenario(S, 'word added inside quote', q2, editText(base, 'T2', 'passed this year', 'passed by Congress this year'),
      { status: 'diverged', change: 'wording', text: 'We need the Kids Online Safety Act passed by Congress this year,' });
  }
  {
    // Boundaries pull the other way too: an edit JUST OUTSIDE the quote must
    // not be dragged into the highlight. These runs replaced no quoted word.
    const t = editText(editText(base, 'T2', 'Chairman. Big Tech has failed', 'Chairman. Frankly, Big Tech has betrayed'),
      'T2', 'our children and', 'our children entirely and');
    scenario(S, 'edits hugging BOTH edges stay outside the highlight', q, t,
      { status: 'diverged', change: 'wording', text: 'Big Tech has betrayed our children' });
    scenario(S, 'LAST word of quote replaced (its timing is lost)', q,
      editText(base, 'T2', 'our children and', 'our young people and'),
      { status: 'diverged', change: 'wording', text: 'Big Tech has failed our young people' });
  }
  {
    const qEdge = share(base, 'T2', 'Big Tech has failed our children');
    scenario(S, 'FIRST word of quote replaced (its timing is lost)', qEdge, editText(base, 'T2', 'Big Tech has', 'Large technology firms have'),
      { status: 'diverged', change: 'wording', text: 'Large technology firms have failed our children' });
  }
  {
    const q2 = share(base, 'T2', 'We need the Kids Online Safety Act');
    scenario(S, 'split BEFORE the quote (words move to new turn)', q2, split(base, 'T2', 'We need'),
      { status: 'match', located_by: 'exact', turns: 'T2b', attribution_changed: false });
  }
  {
    const q2 = share(base, 'T2', 'the data shows it plainly. We need the Kids');
    scenario(S, 'split INSIDE the quote (same speaker)', q2, split(base, 'T2', 'We need'),
      { status: 'match', turns: 'T2+T2b', text: 'the data shows it plainly. We need the Kids', attribution_changed: false, mixed_speakers: false });
  }
  {
    // A clean_text edit, then a split elsewhere in the turn: split resets
    // clean_text, so the raw ASR wording comes back. The displayed words DID
    // change — the honest answer is "diverged", not a silent match.
    const edited = editText(base, 'T2', 'passed this year, not next year.', 'passed this year — not next year.');
    const q2 = share(edited, 'T2', 'passed this year — not next year.');
    scenario(S, 'split resets an accepted edit inside the quote', q2, split(edited, 'T2', 'We need'),
      { status: 'diverged', change: 'formatting', turns: 'T2b', text: 'passed this year, not next year.' });
  }
  {
    // Same speaker continues in the next turn; that turn is merged up.
    const t = BASE();
    t.splice(2, 0, turn('T2c', 'And I will say it again for the record today.', MEMBERS.blackburn, 90_000));
    const q2 = share(t, 'T2c', 'I will say it again for the record');
    scenario(S, 'quoted turn merged away (id deleted)', q2, mergeUp(t, 'T2c'),
      { status: 'match', located_by: 'exact', turns: 'T2', attribution_changed: false });
  }
  {
    // THE TRAP: "Thank you, Mr. Chairman." is also said by Cantwell (T1) and
    // Blackburn (T2). Cruz's was edited. Matching one of the others would put
    // the words in the wrong mouth at the wrong moment.
    const q5 = share(base, 'T5', 'Thank you, Mr. Chairman.');
    const t = editText(base, 'T5', 'Thank you, Mr. Chairman.', 'Thank you, Madam Chair.');
    scenario(S, 'TRAP: same phrase elsewhere, original edited', q5, t,
      { status: 'diverged', change: 'wording', turns: 'T5', speaker: 'Ted Cruz', attribution_changed: false });
    scenario(S, 'TRAP control: same phrase elsewhere, untouched', q5, base,
      { status: 'match', located_by: 'hint', turns: 'T5' });
    scenario(S, 'TRAP control: untouched, hint gone', { ...q5, anchor_turn_id: null }, base,
      { status: 'match', located_by: 'exact', turns: 'T5', speaker: 'Ted Cruz' });
  }
  scenario(S, 're-transcribed (new ids, +400 ms jitter)', q, retranscribe(base, 400),
    { status: 'match', located_by: 'exact', turns: 'T2-v2' });
  scenario(S, 're-transcribed with a word heard differently', q,
    retranscribe(base, 400, (s) => s.replace('our children', 'our kids')),
    { status: 'diverged', change: 'wording', located_by: 'time', turns: 'T2-v2', text: 'Big Tech has failed our kids' });
  {
    const q3 = share(base, 'T3', 'the research is clear that social media harms teen mental health');
    scenario(S, 'wholly rewritten (different word count)', q3,
      replaceText(base, 'T3', 'Senator, I have nothing further to add.'),
      { status: 'not_found', turns: '—' });
    // Equal word count: the aligner hands the old timings to the new words
    // (an unambiguous n-for-n gap), so the time region DOES find them — and the
    // similarity gate is what refuses to call it the same passage.
    scenario(S, 'wholly rewritten (same word count)', q3,
      replaceText(base, 'T3', 'Senator, our lawyers advised me to decline comment on pending litigation matters currently before federal courts nationwide.'),
      { status: 'not_found', turns: '—' });
  }
  {
    // Untimed merge: the target turn has no word_times, so the merged turn has
    // none either — the quote's words lose their timing.
    const t = [
      turn('U1', 'For the record, I submitted written testimony last week.', WITNESS('Dr. Jane Smith'), 300_000, { untimed: true }),
      turn('U2', 'Platforms have known about these harms for years and chose engagement over safety.', WITNESS('Dr. Jane Smith'), 330_000),
    ];
    const qU = share(t, 'U2', 'known about these harms for years');
    scenario(S, 'untimed merge, words unchanged', qU, mergeUp(t, 'U2'),
      { status: 'match', located_by: 'exact', turns: 'U1' });
    scenario(S, 'untimed merge, words changed → honest miss', qU,
      editText(mergeUp(t, 'U2'), 'U1', 'known about these harms', 'long understood these harms'),
      { status: 'not_found', turns: '—' });
  }
}

// ── Highlight edges with REAL timing ─────────────────────────────────────────
// The fixtures above space words 300 ms apart with 250 ms durations. Deepgram
// doesn't: words butt up against each other, and the next speaker can start
// 40 ms after the last word ends. A span test with ±250 ms of slack then
// counts the neighbouring words as "inside the quote" — the highlight bleeds a
// word into the previous word and into the NEXT TURN at an edited edge.
{
  const S = 'edges';
  const timed = (id, who, words) => ({
    id, raw_text: words.map(([w]) => w).join(' '), clean_text: null, start_ms: words[0][1],
    word_times: words.map(([w, s, e]) => ({ w, s, e })),
    speaker_label_raw: `Speaker ${id}`, speaker_name: null, party: null, state: null, chamber: null, ...who,
  });
  const t = [
    timed('E1', MEMBERS.blackburn, [['We', 0, 200], ['will', 220, 400], ['act', 420, 600], ['on', 620, 700], ['this', 720, 900], ['bill.', 920, 1200]]),
    timed('E2', MEMBERS.cruz,      [['I', 1240, 1330], ['agree', 1350, 1600], ['completely.', 1620, 2100]]),
  ];
  const qe = share(t, 'E1', 'act on this bill.');
  scenario(S, 'last word edited, next speaker starts 40 ms later → no bleed', qe,
    editText(t, 'E1', 'this bill.', 'this legislation.'),
    { status: 'diverged', change: 'wording', turns: 'E1', text: 'act on this legislation.' });
  scenario(S, 'first word edited, previous word 20 ms before → no bleed', qe,
    editText(t, 'E1', 'will act on', 'will move on'),
    { status: 'diverged', change: 'wording', turns: 'E1', text: 'move on this bill.' });
  scenario(S, 'control: unedited, tight timing → exact match', qe, t,
    { status: 'match', turns: 'E1', text: 'act on this bill.' });
}

// ── Re-added text, and whose timing counts ───────────────────────────────────
// When a reviewer deletes a quoted phrase and later types it back somewhere
// else in the same turn, the aligner can lend the re-added words timings from
// OTHER occurrences of those words ("Big Tech has to answer…", "has failed to
// do"). Treating that borrowed timing as evidence rejected the exact quote,
// sitting in its own turn, as "said at a different moment" → not_found.
// Timing is evidence only when it is the run's own (every word timed, by
// consecutive entries); a genuinely spoken repeat still gets the strict check.
{
  const S = 're-added';
  const RAW = 'Thank you Mr. Chairman. Big Tech has failed our children and the data shows it plainly. We need our children safe and Big Tech has to answer for what it has failed to do.';
  const t = [
    turn('R1', 'Opening remarks from the chair today.', MEMBERS.cantwell, 0),
    turn('R2', RAW, MEMBERS.blackburn, 60_000),
    turn('R3', 'Next speaker says something else entirely here.', MEMBERS.cruz, 120_000),
  ];
  const qr = share(t, 'R2', 'Big Tech has failed our children');
  const readded = replaceText(t, 'R2',
    'Thank you Mr. Chairman. X and the data shows it plainly. We need our children safe and Big Tech has to answer for what it Big Tech has failed our children answer failed to do.');
  scenario(S, 'exact quote re-added elsewhere in its stored turn → match', qr, readded,
    { status: 'match', located_by: 'exact', turns: 'R2', text: 'Big Tech has failed our children' });
  scenario(S, 'same, but the stored turn is gone → honest miss (no evidence left)', { ...qr, anchor_turn_id: null },
    readded.map((x) => (x.id === 'R2' ? { ...x, id: 'R2-other' } : x)),
    { status: 'not_found' });

  // The counter-case: the speaker GENUINELY said the phrase again later in the
  // same turn (own, consecutive timing, 4+ s later). The quoted occurrence was
  // edited. The repeat is a different utterance — it must not be taken.
  const REPEAT = 'Big Tech has failed our children and I will keep saying it until something changes here. Big Tech has failed our children again.';
  const tr = [turn('P1', REPEAT, MEMBERS.blackburn, 0)];
  const qp = share(tr, 'P1', 'Big Tech has failed our children');
  scenario(S, 'TRAP in the same turn: genuine later repeat is NOT the quote', qp,
    editText(tr, 'P1', 'Big Tech has failed our children and', 'Big Tech has hurt our children and'),
    { status: 'diverged', change: 'wording', text: 'Big Tech has hurt our children' });
}

// ── Reviewer-transcribed turns (migration 015) ───────────────────────────────
// Seq 80's shape after 015: raw_text is the reviewer's text, origin 'human',
// no word_times, no start_ms. A quote from it is untimed by nature.
{
  const S = 'reviewer';
  const human = {
    id: 'H1', raw_text: 'Yes. Are you saying that a mask a cloth mask does not stop the spread of COVID?',
    clean_text: null, word_times: null, start_ms: null, text_origin: 'human',
    speaker_label_raw: null, speaker_name: null, party: 'R', state: 'OH', chamber: 'senate',
    member_id: 'm-moreno', member_full_name: 'Bernie Moreno', speaker_role: 'member',
  };
  const answer = turn('H2', 'I said that the mRNA vaccine did not stop infection.', WITNESS('Alex Berenson'), 2_440_085);
  const t = [turn('H0', 'The tweet that got me banned from Twitter said so plainly.', WITNESS('Alex Berenson'), 2_430_890), human, answer];
  const qh = share(t, 'H1', 'a cloth mask does not stop the spread');
  check(S, 'quote from a reviewer turn: no audio timing, no seek', qh.timing_basis === 'none' && qh.seek_ms === null && qh.anchor_start_ms === null, `(${qh.timing_basis})`);
  scenario(S, 'resolves in place', qh, t, { status: 'match', located_by: 'hint', turns: 'H1', speaker: 'Bernie Moreno' });
  // Merge it DOWN into the witness's answer: its words now live in H2 under
  // the witness's name (merge keeps the survivor's identity), untimed.
  const merged = (() => {
    const out = t.filter((x) => x.id !== 'H1').map((x) => ({ ...x }));
    const h2 = out.find((x) => x.id === 'H2');
    Object.assign(h2, { raw_text: `${human.raw_text} ${answer.raw_text}`, word_times: null, text_origin: 'mixed' });
    return out;
  })();
  scenario(S, 'merged into a neighbour: words kept, found, attribution change flagged', qh, merged,
    { status: 'match', located_by: 'exact', turns: 'H2', speaker: 'Alex Berenson', attribution_changed: true });
}

// ── Evidence ranking ─────────────────────────────────────────────────────────
{
  const S = 'evidence';
  // A similar sentence later in the SAME turn. The quoted sentence was
  // rewritten at its recorded moment. Falling back to "anywhere in the turn"
  // would highlight the other sentence — a different moment, at 5/6 similar.
  const t = [turn('W1', 'The agency ignored our letters completely. We then wrote again in March and in May. The agency ignored our emails completely.', MEMBERS.klobuchar, 0)];
  const qw = share(t, 'W1', 'The agency ignored our letters completely.');
  scenario(S, 'time beats turn: similar sentence elsewhere in the turn is NOT it', qw,
    editText(t, 'W1', 'The agency ignored our letters completely.', 'We have received responses to every request.'),
    { status: 'not_found' });
  scenario(S, 'control: same edit shape, quoted sentence merely edited', qw,
    editText(t, 'W1', 'ignored our letters completely.', 'ignored our letters entirely.'),
    { status: 'diverged', change: 'wording', text: 'The agency ignored our letters entirely.' });

  // A few surviving words must not anchor a paragraph-long insertion.
  const base = BASE();
  const q = share(base, 'T2', 'Big Tech has failed our children');
  scenario(S, `span-growth cap (> ${TUNING.MAX_SPAN_GROWTH}× + 2 words)`, q,
    editText(base, 'T2', 'has failed our', 'has, as every parent in every state across this country has seen for a decade now with growing alarm, failed our'),
    { status: 'not_found' });
}

// ── Similarity threshold ─────────────────────────────────────────────────────
{
  const S = 'threshold';
  const base = BASE();
  const q3 = share(base, 'T3', 'the research is clear that social media harms teen mental health');
  scenario(S, `3 of 11 words changed (≥ ${TUNING.MIN_SIMILARITY})`, q3,
    editText(base, 'T3', 'the research is clear that social media harms', 'the evidence is strong that social platforms harm'),
    { status: 'diverged', change: 'wording' });
  scenario(S, `8 of 11 words changed (< ${TUNING.MIN_SIMILARITY})`, q3,
    editText(base, 'T3', 'the research is clear that social media harms teen mental health', 'our findings suggest apps may affect adolescent wellbeing somewhat'),
    { status: 'not_found' });
}

// ── Speaker checks ───────────────────────────────────────────────────────────
{
  const S = 'speaker';
  const base = BASE();
  {
    // A merge moves a witness's words under a senator's name, and nobody
    // touched the text. The words match — the attribution does not.
    const q3 = share(base, 'T3', 'social media harms teen mental health');
    scenario(S, 'merged under a DIFFERENT speaker', q3, mergeUp(base, 'T3'),
      { status: 'match', turns: 'T2', speaker: 'Marsha Blackburn', attribution_changed: true, mixed_speakers: false });
  }
  {
    const q4 = share(base, 'T4', 'chose engagement over safety');
    scenario(S, 'unattributed → attributed (re-attribution only)', q4,
      reattribute(base, 'T4', MEMBERS.klobuchar),
      { status: 'match', located_by: 'hint', speaker: 'Amy Klobuchar', attribution_changed: true });
    scenario(S, 'attribution unchanged', q4, base,
      { status: 'match', speaker: 'Speaker 2', attribution_changed: false });
  }
  {
    const q2 = share(base, 'T2', 'the data shows it plainly. We need the Kids');
    scenario(S, 'split inside quote, 2nd half given to another speaker', q2,
      split(base, 'T2', 'We need', MEMBERS.cruz),
      { status: 'match', turns: 'T2+T2b', attribution_changed: true, mixed_speakers: true });
  }
  {
    const q3 = share(base, 'T3', 'the research is clear');
    scenario(S, 'witness renamed cosmetically (case/space)', q3,
      reattribute(base, 'T3', WITNESS('dr.  jane smith')),
      { status: 'match', attribution_changed: false });
  }
}

// ── No drift ─────────────────────────────────────────────────────────────────
{
  const S = 'no drift';
  const base = BASE();
  const q = share(base, 'T2', 'Big Tech has failed our children');
  const edited = editText(base, 'T2', 'has failed', 'has betrayed');
  const twice = editText(edited, 'T2', 'our children', 'our kids');
  scenario(S, 'edited twice', q, twice,
    { status: 'diverged', change: 'wording', text: 'Big Tech has betrayed our kids' });
  scenario(S, 'edited, then reverted', q, editText(edited, 'T2', 'has betrayed', 'has failed'),
    { status: 'match' });
  check(S, 'snapshot is never touched by resolution', q.quoted_text === 'Big Tech has failed our children');
}

// ── Untimed citations ────────────────────────────────────────────────────────
{
  const S = 'untimed';
  const t = [
    turn('V1', 'Opening remarks from the chair about the agenda today.', MEMBERS.cantwell, 0, { untimed: true }),
    turn('V2', 'The agency has not answered a single letter we sent this year.', MEMBERS.klobuchar, 30_000, { untimed: true }),
  ];
  const qv = share(t, 'V2', 'has not answered a single letter');
  check(S, 'untimed turn → timing_basis "turn", seek = turn start',
    qv.timing_basis === 'turn' && qv.seek_ms === 30_000 && qv.anchor_start_ms === null, `(${qv.timing_basis}, ${qv.seek_ms})`);
  scenario(S, 'unchanged', qv, t, { status: 'match', located_by: 'hint' });
  scenario(S, 'edited inside (found via its turn)', qv, editText(t, 'V2', 'a single letter', 'one letter'),
    { status: 'diverged', change: 'wording', located_by: 'turn', text: 'has not answered one letter' });
  scenario(S, 'turn deleted, no timing, words gone → honest miss', { ...qv, anchor_turn_id: null },
    [t[0]], { status: 'not_found' });
}

// ── Snapshot rules ───────────────────────────────────────────────────────────
{
  const S = 'snapshot';
  const base = BASE();
  const t2 = base[1];
  const text = displayText(t2);
  const at = text.indexOf('Tech has failed');
  const snap = snapshotQuote(t2, at + 2, at + 'Tech has fail'.length);   // "ch has fail"
  check(S, 'partial words snap out to whole words', snap.quoted_text === 'Tech has failed', `→ "${snap.quoted_text}"`);
  check(S, 'offsets are exact into the displayed text', text.slice(snap.char_start, snap.char_end) === snap.quoted_text);
  check(S, 'prefix/suffix are the surrounding text', text.endsWith(snap.prefix + snap.quoted_text + snap.suffix) || text.includes(snap.prefix + snap.quoted_text + snap.suffix));
  check(S, 'timed first word → basis "word", seek = its start',
    snap.timing_basis === 'word' && snap.seek_ms === snap.anchor_start_ms);

  // The quote's first word was edited (its timing is gone): seek EARLY, to the
  // nearest timed word before it — never late, clipping the opening words.
  const edited = editText(base, 'T2', 'Big Tech has', 'Large technology firms have');
  const qe = share(edited, 'T2', 'Large technology firms have failed our children');
  check(S, 'untimed first word → "nearby_word", seek before the quote',
    qe.timing_basis === 'nearby_word' && qe.seek_ms < qe.anchor_start_ms, `(seek ${qe.seek_ms} < anchor ${qe.anchor_start_ms})`);

  const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  const long = throws(() => snapshotQuote(turn('L', 'word '.repeat(400), MEMBERS.cruz, 0), 0, 1999));
  check(S, 'over-long quote refused (400)', long?.status === 400, long?.message ?? '');
  const blank = throws(() => snapshotQuote(t2, text.indexOf(' Big'), text.indexOf(' Big') + 1));
  check(S, 'whitespace-only selection refused (400)', blank?.status === 400, blank?.message ?? '');
  const oob = throws(() => snapshotQuote(t2, 5, text.length + 10));
  check(S, 'out-of-range selection refused (400)', oob?.status === 400);

  const sp = speakerSnapshot(base[3]);
  check(S, 'unattributed speaker recorded by its diarization label', sp.speaker_name === 'Speaker 2' && sp.member_id === null);
  const sm = speakerSnapshot(base[1]);
  check(S, 'member recorded with party/state/chamber', sm.member_id === 'm-blackburn' && sm.speaker_party === 'R' && sm.speaker_state === 'TN');
}

// ── Report ───────────────────────────────────────────────────────────────────
const w = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
console.log(`\n${w('', 3)}${w('section', 11)}${w('scenario', 56)}result`);
console.log('─'.repeat(150));
let last = '';
for (const r of rows) {
  if (r.section !== last && last) console.log('');
  last = r.section;
  console.log(`${r.ok ? ' ✓ ' : ' ✗ '}${w(r.section, 11)}${w(r.name, 56)}${r.got}`);
  if (!r.ok) console.log(`${' '.repeat(70)}expected: ${r.expect}`);
}
console.log('─'.repeat(150));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
