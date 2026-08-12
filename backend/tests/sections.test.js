// Q2 guarantee, tested: re-running detection must never clobber an admin's
// section edits. Pure functions, no DB.
const { reconcile, resolvePerson, dedupePlaced, placeCut } = require('../src/utils/sectionDetect');

let fail = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fail++;
};

// A 20-turn transcript: turn id "t<seq>" at seq <seq>.
const turns = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, seq: i }));
const det = (seq) => ({ startSeq: seq, start: { id: `t${seq}`, seq } });

// ── 1. No admin edits → everything re-derives ──
{
  const existing = [{ id: 'a1', start_turn_id: 't0', source: 'auto' }, { id: 'a2', start_turn_id: 't5', source: 'auto' }];
  const r = reconcile([det(0), det(6), det(12)], existing, turns, { force: false });
  check('no admin edits → all detected sections inserted', r.insert.length === 3 && r.keep.length === 0);
  check('no admin edits → nothing dropped', r.dropped.length === 0);
}

// ── 2. An admin-edited section is preserved, and detection may not re-cut
//       inside its span (this is what makes a MERGE survive a re-run) ──
{
  const existing = [
    { id: 'a1', start_turn_id: 't0', source: 'auto' },
    { id: 'h1', start_turn_id: 't5', source: 'human' },   // spans 5..11 (next anchor is t12)
    { id: 'a2', start_turn_id: 't12', source: 'auto' },
  ];
  const r = reconcile([det(0), det(5), det(8), det(12)], existing, turns, { force: false });
  check('admin-edited section is kept', r.keep.length === 1 && r.keep[0].id === 'h1');
  check('detected cut ON the human anchor is dropped', r.dropped.some(d => d.seq === 5));
  check('detected cut INSIDE the human span is dropped (merge survives)', r.dropped.some(d => d.seq === 8));
  check('cuts outside the human span still apply', r.insert.map(i => i.startSeq).join(',') === '0,12',
    r.insert.map(i => i.startSeq).join(','));
}

// ── 3. A moved boundary survives, because the admin API marks BOTH adjacent
//       sections human (see migration 012's provenance note) ──
{
  const existing = [
    { id: 'h0', start_turn_id: 't0', source: 'human' },   // spans 0..9 after the move
    { id: 'h1', start_turn_id: 't10', source: 'human' },  // admin moved this from t7 → t10
  ];
  const r = reconcile([det(0), det(7), det(10)], existing, turns, { force: false });
  check('moved boundary: the old cut at 7 is suppressed', r.dropped.some(d => d.seq === 7));
  check('moved boundary: both human rows preserved', r.keep.length === 2);
  check('moved boundary: nothing re-inserted over them', r.insert.length === 0, JSON.stringify(r.insert.map(i => i.startSeq)));
}

// ── 4. --force is the only way past an admin edit ──
{
  const existing = [{ id: 'h1', start_turn_id: 't5', source: 'human' }];
  const r = reconcile([det(0), det(5), det(8)], existing, turns, { force: true });
  check('--force replaces even human sections', r.insert.length === 3 && r.keep.length === 0);
}

// ── 5. Boundary placement: a short turn IS the handoff; a long one ends with it ──
{
  const ts = [{ id: 'x', seq: 3, text: 'Thank you. Senator Fisher.' }, { id: 'y', seq: 4, text: 'Thank you, mister chairman.' }];
  const short = placeCut({ method: 'recognition_chair', turn: ts[0] }, ts);
  check('short handoff turn starts the section', short.id === 'x');
  const longTurn = { id: 'x', seq: 3, text: Array(40).fill('word').join(' ') + ' Senator Fisher.' };
  const long = placeCut({ method: 'recognition_chair', turn: longTurn }, [longTurn, ts[1]]);
  check('long turn ending in a handoff starts the section at turn+1', long.id === 'y');
}

// ── 6. Suppression is by placed position, window 1 ──
{
  const mk = (seq, conf, method) => ({ at: { id: `t${seq}`, seq }, confidence: conf, method });
  const kept = dedupePlaced([mk(6, 0.95, 'recognition_chair'), mk(7, 0.7, 'round_open'), mk(8, 0.5, 'yield_back')]);
  check('adjacent weaker cut suppressed, 2-away cut survives',
    kept.map(k => k.at.seq).join(',') === '6,8', kept.map(k => k.at.seq).join(','));
}

// ── 7. Fuzzy name matching does not fire on ASR debris ──
{
  const ctx = { roster: [{ id: 'm1', full_name: 'Deb Fischer', state: 'NE' }], witnesses: ['Sean Davis'], lookahead: [] };
  check('truncated "Can" does not match witness "Sean"', !resolvePerson('Can', ctx, true).name,
    JSON.stringify(resolvePerson('Can', ctx, true)));
  check('"Fisher" still resolves to Fischer', resolvePerson('Fisher', ctx, false).name === 'Deb Fischer');
  check('a witness is not a handoff target outside an opening', !resolvePerson('Davis', ctx, false).name);
  check('a witness IS a target when an opening cue is present', resolvePerson('Davis', ctx, true).name === 'Sean Davis');
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall section-provenance checks passed');
process.exit(fail ? 1 : 0);
