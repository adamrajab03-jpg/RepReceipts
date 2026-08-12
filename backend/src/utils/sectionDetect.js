// ============================================================================
//  HEARING SECTIONING — the heuristic detection core.
// ----------------------------------------------------------------------------
//  Shared by the CLI pass (ingestion/sections.js) and the admin "re-detect"
//  endpoint, so there is exactly ONE implementation of the heuristic.
//
//  Reads turns and derives navigable structure: opening statements, one section
//  per questioning round, closing. Deterministic pattern matching — NO model
//  call. Nothing here writes speaker_turns; writeSections() touches only
//  hearing_sections.
//
//  ── THE SIGNAL, IN DESCENDING RELIABILITY ─────────────────────────────────
//  Measured against the PoC transcript (161 turns), not assumed:
//
//  1. RECOGNITION FROM THE CHAIR'S BUCKET (0.95). The chair hands the floor
//     over ("the chair recognizes…", or in practice just "Thank you. Senator
//     Fisher."). 9 of 10 real handoffs came from ONE diarization bucket, which
//     is how the chair is identified — by speaker_key, never by the attributed
//     NAME, because attribution can be (and on the PoC hearing is) wrong.
//  2. RECOGNITION FROM ANOTHER BUCKET (0.75). The 10th real handoff sat in a
//     senator's bucket, so the chair bucket is a confidence tier, not a gate.
//  3. ROUND OPEN (0.70). A speaker begins with "Thank you, mister chairman".
//  4. YIELD BACK (0.50). The floor is given back and the speaker changes.
//
//  Two guards earn most of the precision, each from a real false positive:
//    · the name matcher is CASE-SENSITIVE — case-insensitivity matched
//      "Mister Davis spoke Yes." as a handoff;
//    · role words (chairman, chair, president, …) are never names.
//  And a terse handoff that resolves to NOBODY does not cut at all.
// ============================================================================
const { soundex, phoneticSimilar } = require('./cleanupValidate');

// ── Confidence tiers ────────────────────────────────────────────────────────
const C = {
  recognition_chair: 0.95,
  recognition_other: 0.75,
  opening_cue: 0.90,
  closing_cue: 0.80,
  round_open: 0.70,
  yield_back: 0.50,
  transcript_start: 0.60,
  inferred: 0.40,
};
// Below this a section is surfaced to the admin as "needs a look".
const SOFT = 0.7;
// A handoff turn no longer than this IS the handoff, so the new section starts
// at it. Longer turns end with a handoff, so the section starts at turn + 1.
const HANDOFF_WORDS = 15;

// ── Patterns ────────────────────────────────────────────────────────────────
const TITLE_SRC = `(?:[Ss]enator|[Ss]en\\.|[Rr]anking\\s+[Mm]ember|[Cc]ongress(?:man|woman)|[Rr]epresentative|[Rr]ep\\.|[Mm]ister|[Mm]r\\.|[Mm]isses|[Mm]rs\\.|[Mm]s\\.|[Mm]iss|[Mm]adam|[Dd]octor|[Dd]r\\.|[Pp]rofessor|[Pp]rof\\.)`;
// Case-SENSITIVE on purpose: a lowercase word is not a name.
const NAME_SRC = `([A-Z][\\w'’\\-]+(?:\\s+(?:[A-Z][\\w'’\\-]+|de|del|la|van|von))*)`;

const RECOGNIZE = /\b(?:(?:the\s+)?chair\s+recognizes|(?:I|we)(?:'ll|\s+will)?\s+(?:now\s+)?recognize|is\s+(?:now\s+)?recognized|now\s+call\s+on|turn\s+(?:it\s+)?over\s+to)\b/i;
const FLOOR_TIME = /\brecognized\s+for\s+(?:five|seven|ten|\d+)\s+minutes\b/i;
const FROM_STATE = /(?:senator|gentle(?:man|woman|lady))\s+from\s+(?:the\s+state\s+of\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/;
const TITLE_NAME = new RegExp(`${TITLE_SRC}\\s+${NAME_SRC}`);
const BARE_NAME = new RegExp(`\\b${NAME_SRC}`);
const TERSE = new RegExp(`^\\s*(?:(?:[Tt]hanks?|[Tt]hank\\s+you)\\b[^.!?]{0,28}?[,.]?\\s*)?(${TITLE_SRC})\\s+${NAME_SRC}\\s*[.!]?\\s*$`);
const ROUND_OPEN = /^\s*(?:thanks?|thank\s+you)[,.]?\s+(?:so\s+much[,.]?\s+)?(?:mister|madam|mr\.|ms\.)\s+chair(?:man|woman|person)?\b/i;
const YIELD_BACK = /\byield\s+back\b|\bthank\s+you,?\s+(?:mister|madam|mr\.|ms\.)\s+chair(?:man|woman)?\s*[.!]?\s*$/i;
const OPENING_CUE = /\bopening\s+(?:statement|remarks)\b|\b(?:deliver|for)\s+(?:his|her|their)\s+(?:opening|testimony|remarks)\b/i;
const CLOSING_CUE = /\b(?:hearing\s+is\s+adjourned|stands?\s+adjourned|we(?:'re|\s+are)\s+adjourned|before\s+we\s+close|that\s+concludes|record\s+will\s+remain\s+open|questions\s+for\s+the\s+record)\b/i;
const RANKING_CUE = /\branking\s+member\b/i;

// A "name" that is really a role is never a handoff target.
const ROLE_WORDS = new Set(['chair', 'chairman', 'chairwoman', 'chairperson', 'president', 'speaker',
  'secretary', 'counsel', 'clerk', 'witness', 'witnesses', 'members', 'member', 'colleague', 'colleagues', 'friend', 'staff']);

const STATES = { alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',colorado:'CO',connecticut:'CT',delaware:'DE',florida:'FL',georgia:'GA',hawaii:'HI',idaho:'ID',illinois:'IL',indiana:'IN',iowa:'IA',kansas:'KS',kentucky:'KY',louisiana:'LA',maine:'ME',maryland:'MD',massachusetts:'MA',michigan:'MI',minnesota:'MN',mississippi:'MS',missouri:'MO',montana:'MT',nebraska:'NE',nevada:'NV','new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC','north dakota':'ND',ohio:'OH',oklahoma:'OK',oregon:'OR',pennsylvania:'PA','rhode island':'RI','south carolina':'SC','south dakota':'SD',tennessee:'TN',texas:'TX',utah:'UT',vermont:'VT',virginia:'VA',washington:'WA','west virginia':'WV',wisconsin:'WI',wyoming:'WY' };

// ── Helpers ─────────────────────────────────────────────────────────────────
const sentences = (t) => String(t).split(/(?<=[.!?])\s+/).filter(Boolean);
const words = (t) => String(t).trim().split(/\s+/).filter(Boolean);
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s]/g, '').trim();
const tokens = (s) => norm(s).split(/\s+/).filter(Boolean);
const surname = (s) => tokens(s).pop() || '';

/**
 * Resolve a heard name to a roster member or a witness. ASR mangles these
 * badly ("Fisher"→Fischer, "Mackey"→Markey, "Lujan"→Luján, "Killamen"→
 * Kimmelman), so exact match falls through to the phonetic primitives already
 * used by the cleanup validator. Ambiguity is broken by who actually speaks
 * next — never by picking the first candidate.
 */
function resolvePerson(raw, ctx, allowWitness = false) {
  if (!raw) return { how: 'none' };
  const last = surname(raw);
  if (!last || ROLE_WORDS.has(last)) return { how: 'role-word' };

  const exact = ctx.roster.filter((m) => surname(m.full_name) === last);
  if (exact.length === 1) return { member: exact[0], name: exact[0].full_name, how: 'roster exact' };

  // Fuzzy matching only on tokens long enough to carry signal. Short fragments
  // are ASR debris, and letting them through is how a truncated "Mister Can"
  // once matched witness "Sean" at exactly the 0.5 similarity threshold.
  const MIN_FUZZY = 5;
  const fuzzy = (a, b) =>
    a.length >= MIN_FUZZY && b.length >= MIN_FUZZY && (soundex(a) === soundex(b) || phoneticSimilar(a, b));

  // A witness is only ever a handoff target when the chair is handing over for
  // an OPENING STATEMENT. Mid-hearing, "mister <name>" addresses a witness in
  // conversation — it is not a transfer of the floor.
  const raws = tokens(raw);
  const wit = allowWitness
    ? ctx.witnesses.find((w) => tokens(w).some((a) => raws.some((b) => (a === b && a.length >= 4) || fuzzy(a, b))))
    : null;

  const near = ctx.roster.filter((m) => fuzzy(surname(m.full_name), last));
  if (!exact.length && near.length === 1 && !wit) return { member: near[0], name: near[0].full_name, how: 'roster phonetic' };
  if (near.length > 1) {
    const pick = near.find((m) => ctx.lookahead.includes(m.full_name));
    if (pick) return { member: pick, name: pick.full_name, how: `phonetic+lookahead (of ${near.length})` };
  }
  if (wit) return { name: wit, witness: true, how: 'witness' };
  if (near.length > 1) return { how: `ambiguous(${near.length})` };
  return { how: 'no-match' };
}

function resolveState(stateWord, ctx) {
  const code = STATES[String(stateWord).toLowerCase()];
  if (!code) return { how: `unknown state "${stateWord}"` };
  const c = ctx.roster.filter((m) => m.state === code);
  if (c.length === 1) return { member: c[0], name: c[0].full_name, how: `state ${code}` };
  const pick = c.find((m) => ctx.lookahead.includes(m.full_name));
  if (pick) return { member: pick, name: pick.full_name, how: `state ${code}+lookahead` };
  return { how: c.length ? `state ${code} ambiguous(${c.length})` : `no roster member for ${code}` };
}

/**
 * Identify the chair's diarization bucket WITHOUT trusting the attributed name.
 * Primary: a turn explicitly roled 'chair'. Fallback: the bucket that issues
 * the most recognition phrases (self-bootstrapping, works with no role data).
 */
function findChairBucket(turns) {
  const roled = turns.find((t) => t.speaker_role === 'chair');
  if (roled) return { key: roled.speaker_key, how: "speaker_role='chair'" };
  const tally = new Map();
  for (const t of turns) {
    if (!RECOGNIZE.test(t.text) && !TERSE.test((sentences(t.text).pop() || '').trim())) continue;
    tally.set(t.speaker_key, (tally.get(t.speaker_key) || 0) + 1);
  }
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? { key: top[0], how: `most recognitions (${top[1]})` } : { key: null, how: 'none' };
}

// ── Candidate detection ─────────────────────────────────────────────────────
function detectCandidates(turns, roster, witnesses, chairKey) {
  const out = [];
  const notes = [];

  turns.forEach((t, i) => {
    const ss = sentences(t.text);
    const lastS = (ss[ss.length - 1] || '').trim();
    const lookahead = turns.slice(i + 1, i + 4).map((x) => x.attributed).filter(Boolean);
    const ctx = { roster, witnesses, lookahead };
    const fromChair = chairKey && t.speaker_key === chairKey;

    // ── Tier 1: an explicit recognition verb ──
    if (RECOGNIZE.test(t.text) || FLOOR_TIME.test(t.text)) {
      const idx = t.text.search(RECOGNIZE);
      const after = t.text.slice(idx >= 0 ? idx : 0);
      const st = after.match(FROM_STATE);
      const tn = after.match(TITLE_NAME);
      const isOpening = OPENING_CUE.test(t.text);
      let res, via;
      if (st) { res = resolveState(st[1], ctx); via = `from-state:${st[1]}`; }
      else if (tn) { res = resolvePerson(tn[1], ctx, isOpening); via = 'verb+title+name'; }
      else if (RANKING_CUE.test(after)) { res = { name: 'Ranking Member', how: 'role' }; via = 'verb+ranking'; }
      else {
        const bn = after.replace(RECOGNIZE, ' ').match(BARE_NAME);
        res = bn ? resolvePerson(bn[1], ctx, isOpening) : { how: 'no target' };
        via = 'verb+bare-name';
      }
      const method = fromChair ? 'recognition_chair' : 'recognition_other';
      if (res.name) {
        out.push({
          turn: t, method, confidence: C[method], person: res, via,
          opening: OPENING_CUE.test(t.text),
          note: fromChair ? null : 'recognition came from a non-chair speaker bucket',
        });
      } else {
        notes.push(`turn ${t.seq}: recognition verb but target unresolved (${res.how}) — no cut made`);
      }
      return;
    }

    // ── Tier 1b: terse handoff as the final sentence ──
    const m = lastS.match(TERSE);
    if (m && !/\?\s*$/.test(lastS) && !ROLE_WORDS.has(surname(m[2]))) {
      const res = resolvePerson(m[2], ctx, OPENING_CUE.test(t.text));
      if (res.name) {
        const method = fromChair ? 'recognition_chair' : 'recognition_other';
        out.push({
          turn: t, method, confidence: C[method], person: res, via: `terse(${words(lastS).length}w)`,
          opening: OPENING_CUE.test(t.text),
          note: fromChair ? null : 'handoff came from a non-chair speaker bucket',
        });
      } else {
        // Deliberately NOT a cut: an unresolvable name is usually a truncated
        // ASR fragment mid-round, and a bad cut splits a good section in two.
        notes.push(`turn ${t.seq}: terse handoff "${lastS.slice(0, 40)}" unresolved (${res.how}) — no cut made`);
      }
      return;
    }

    // ── Tier 2: the speaker opens by addressing the chair ──
    if (ROUND_OPEN.test(t.text) && t.speaker_role !== 'witness') {
      out.push({
        turn: t, method: 'round_open', confidence: C.round_open, person: null, via: 'round-open',
        opening: false, note: 'no recognition phrase in the transcript; inferred from the speaker greeting the chair',
      });
      return;
    }

    // ── Tier 3: the floor was yielded back and the speaker changed ──
    const next = turns[i + 1];
    if (YIELD_BACK.test(t.text) && next && next.speaker_key !== t.speaker_key) {
      out.push({
        turn: next, method: 'yield_back', confidence: C.yield_back, person: null, via: 'yield-back',
        opening: false, note: 'no recognition phrase; inferred from the previous speaker yielding back',
      });
    }
  });

  return { candidates: out, notes };
}

/**
 * Higher tier wins. Suppression is measured on the PLACED cut, not the matching
 * turn, and the window is 1: a recognition and the greeting that answers it are
 * the same boundary, but a witness finishing at turn 7 and the chair starting
 * to question at turn 8 are two real boundaries two turns apart.
 */
function dedupePlaced(placed, window = 1) {
  const sorted = [...placed].sort((a, b) => b.confidence - a.confidence || a.at.seq - b.at.seq);
  const kept = [];
  for (const c of sorted) {
    if (kept.some((k) => k.at.id === c.at.id || Math.abs(k.at.seq - c.at.seq) <= window)) continue;
    kept.push(c);
  }
  return kept.sort((a, b) => a.at.seq - b.at.seq);
}

/**
 * Where does the new section actually begin? A short turn IS the handoff, so it
 * opens the section. A long turn ENDS with one, so the previous speaker's
 * content stays in their own round and the section opens at the next turn.
 */
function placeCut(cand, turns) {
  if (cand.method === 'round_open' || cand.method === 'yield_back') return cand.turn;
  const isShort = words(cand.turn.text).length <= HANDOFF_WORDS;
  if (isShort) return cand.turn;
  const i = turns.findIndex((t) => t.id === cand.turn.id);
  return turns[i + 1] || cand.turn;
}

// ── Build the ordered partition ─────────────────────────────────────────────
function buildSections(turns, placedCands, chairKey, witnesses) {
  const cuts = placedCands.map((c) => ({ at: c.at, cand: c }));
  cuts.sort((a, b) => a.at.seq - b.at.seq);

  // Closing: the last closing cue at or after the final cut.
  const lastCutSeq = cuts.length ? cuts[cuts.length - 1].at.seq : -1;
  const closing = turns.find((t) => t.seq >= lastCutSeq && CLOSING_CUE.test(t.text));
  if (closing && !cuts.some((c) => c.at.id === closing.id)) {
    cuts.push({ at: closing, cand: { method: 'closing_cue', confidence: C.closing_cue, person: null, via: 'closing-cue', closing: true, note: null } });
    cuts.sort((a, b) => a.at.seq - b.at.seq);
  }

  // Every transcript starts with a section, whether or not anything matched.
  if (!cuts.length || cuts[0].at.seq > turns[0].seq) {
    cuts.unshift({ at: turns[0], cand: { method: 'transcript_start', confidence: C.transcript_start, person: null, via: 'start', note: null } });
  }

  // Materialise ranges, then classify.
  const sections = cuts.map((c, i) => {
    const startSeq = c.at.seq;
    const endSeq = i + 1 < cuts.length ? cuts[i + 1].at.seq - 1 : turns[turns.length - 1].seq;
    const body = turns.filter((t) => t.seq >= startSeq && t.seq <= endSeq);
    return { start: c.at, startSeq, endSeq, body, cand: c.cand, notes: [] };
  }).filter((s) => s.body.length);

  const firstQuestioningIdx = sections.findIndex((s) => !s.cand.opening && !s.cand.closing && s.cand.method !== 'transcript_start');

  sections.forEach((s, i) => {
    const c = s.cand;
    const beforeQuestioning = firstQuestioningIdx === -1 ? false : i < firstQuestioningIdx;

    if (c.closing) {
      s.type = 'closing'; s.label = 'Closing'; s.confidence = C.closing_cue; s.method = 'closing_cue';
      return;
    }

    // ── Opening block ──
    if (c.opening || (beforeQuestioning && c.method === 'transcript_start')) {
      if (c.opening && c.person) {
        // A named opening: witness statement, or an opening by chair/ranking.
        if (c.person.witness) {
          s.type = 'witness_statement'; s.label = c.person.name;
        } else if (RANKING_CUE.test(c.turnText || '') || /ranking/i.test(c.person.name || '')) {
          s.type = 'ranking_opening'; s.label = `${c.person.name} — opening`;
        } else {
          s.type = 'witness_statement'; s.label = c.person.name;
        }
        s.member = c.person.member ?? null;
        s.confidence = C.opening_cue; s.method = 'opening_cue';
        return;
      }
      // Unnamed leading block. Only call it a chair opening if the chair is
      // actually the dominant voice; otherwise say we don't know.
      const dom = dominant(s.body);
      if (c.method === 'transcript_start' && chairKey && dom.key === chairKey) {
        s.type = 'chair_opening'; s.label = 'Chair — opening statement';
        s.confidence = C.inferred; s.method = 'inferred';
        s.notes.push('no explicit opening cue; inferred from the chair dominating the block');
      } else {
        s.type = 'unassigned'; s.label = null;
        s.confidence = C.inferred; s.method = 'inferred';
        s.notes.push('could not be placed: no recognition, opening cue, or chair-dominated block');
      }
      return;
    }

    // ── Questioning round ──
    s.type = 'questioning';
    s.method = c.method;
    s.confidence = c.confidence;
    if (c.person?.name) {
      s.label = c.person.name;
      s.member = c.person.member ?? null;
    } else {
      // No recognition named anyone — fall back to whoever actually holds the
      // floor, and say plainly that the label is inferred.
      const dom = dominant(s.body.filter((t) => t.speaker_role !== 'witness'));
      s.label = dom.name || 'Unidentified questioner';
      s.member = dom.memberId ? { id: dom.memberId, full_name: dom.name } : null;
      s.confidence = Math.min(s.confidence, C.yield_back);
      s.notes.push(dom.name
        ? `questioner not named in the transcript; labelled from the dominant speaker's attribution (${dom.name})`
        : 'questioner could not be identified');
    }
    if (c.note) s.notes.push(c.note);
  });

  // Q1: per-witness sections only where they are cleanly bounded. If the
  // opening block holds several witness voices but fewer than two resolved
  // witness recognitions, the sub-boundaries are not supportable — collapse to
  // one combined section rather than guessing where each statement began.
  const wsIdx = sections.map((s, i) => (s.type === 'witness_statement' ? i : -1)).filter((i) => i >= 0);
  const clean = wsIdx.filter((i) => sections[i].method === 'opening_cue');
  const witnessVoices = new Set(sections.filter((s) => s.type === 'witness_statement')
    .flatMap((s) => s.body.filter((t) => t.speaker_role === 'witness').map((t) => t.speaker_key)));
  if (wsIdx.length > 1 && clean.length < 2 && witnessVoices.size > 1) {
    const first = sections[wsIdx[0]];
    first.label = 'Witness Statements';
    first.member = null;
    first.confidence = C.inferred;
    first.notes.push(`combined: ${witnessVoices.size} witness voices but sub-boundaries were not cleanly detectable`);
    for (const i of wsIdx.slice(1)) sections[i].merged = true;
  }
  return sections.filter((s) => !s.merged);
}

function dominant(body) {
  const tally = new Map();
  for (const t of body) {
    const k = t.speaker_key;
    const cur = tally.get(k) || { n: 0, name: t.attributed, memberId: t.member_id, key: k };
    cur.n += words(t.text).length || 1;
    tally.set(k, cur);
  }
  const top = [...tally.values()].sort((a, b) => b.n - a.n)[0];
  return top || { name: null, memberId: null, key: null };
}

// ── Persistence ─────────────────────────────────────────────────────────────
/**
 * Human-edited sections are decisions, not guesses. Re-detection keeps them
 * verbatim and drops any freshly detected cut that falls INSIDE one of their
 * spans, so an admin's merge/rename/boundary-move survives a re-run. Only
 * source='auto' rows are replaced. --force overrides, loudly.
 */
function reconcile(detected, existing, turns, { force = false } = {}) {
  const seqOf = new Map(turns.map((t) => [t.id, t.seq]));
  const humans = existing.filter((e) => e.source === 'human');
  if (force || !humans.length) return { keep: [], insert: detected, dropped: [] };

  // Each human section spans from its anchor to the next anchor (of any row).
  const anchors = [...existing].map((e) => ({ ...e, seq: seqOf.get(e.start_turn_id) ?? -1 }))
    .filter((e) => e.seq >= 0).sort((a, b) => a.seq - b.seq);
  const protectedRanges = [];
  for (const h of humans) {
    const i = anchors.findIndex((a) => a.id === h.id);
    if (i < 0) continue;
    const start = anchors[i].seq;
    const end = i + 1 < anchors.length ? anchors[i + 1].seq - 1 : Infinity;
    protectedRanges.push({ start, end, id: h.id });
  }
  const dropped = [];
  const insert = detected.filter((d) => {
    const s = d.startSeq;
    const hit = protectedRanges.find((r) => s > r.start && s <= r.end); // strictly inside
    const same = protectedRanges.find((r) => s === r.start);
    if (hit || same) { dropped.push({ seq: s, why: same ? 'anchor is human-edited' : 'inside a human-edited section' }); return false; }
    return true;
  });
  return { keep: humans, insert, dropped };
}

// ── Orchestration ───────────────────────────────────────────────────────────
/** The turn shape every section function expects. Read-only projection. */
async function loadSectionTurns(runner, transcriptId) {
  const { rows } = await runner.query(`
    SELECT st.id, st.seq, st.speaker_key, st.speaker_role, st.member_id,
           coalesce(m.full_name, st.speaker_name) AS attributed,
           st.speaker_name,
           coalesce(st.clean_text, st.raw_text) AS text
      FROM speaker_turns st
      LEFT JOIN members m ON m.id = st.member_id
     WHERE st.transcript_id = $1 ORDER BY st.seq`, [transcriptId]);
  return rows;
}

/** Run the whole heuristic. Pure: takes turns + roster, returns the partition. */
function detectSections(turns, roster) {
  const witnesses = [...new Set(turns.filter((t) => t.speaker_role === 'witness' && t.speaker_name).map((t) => t.speaker_name))];
  const chair = findChairBucket(turns);
  const { candidates, notes } = detectCandidates(turns, roster, witnesses, chair.key);
  const placed = candidates.map((c) => ({ ...c, at: placeCut(c, turns) })).filter((c) => c.at);
  const kept = dedupePlaced(placed);
  const sections = buildSections(turns, kept, chair.key, witnesses);
  return { sections, notes, chair, witnesses };
}

/**
 * Persist a detected partition. Writes ONLY hearing_sections: auto rows are
 * replaced, human-edited rows are preserved verbatim and their spans are never
 * re-cut (see reconcile). Caller owns the transaction.
 */
async function writeSections(runner, { hearingId, transcriptId, turns, detected, force = false }) {
  const { rows: existing } = await runner.query(
    `SELECT id, start_turn_id, source FROM hearing_sections WHERE transcript_id = $1`, [transcriptId]);
  const { keep, insert, dropped } = reconcile(detected, existing, turns, { force });

  await runner.query('SET CONSTRAINTS hearing_sections_order_uniq DEFERRED');
  if (force) await runner.query(`DELETE FROM hearing_sections WHERE transcript_id = $1`, [transcriptId]);
  else await runner.query(`DELETE FROM hearing_sections WHERE transcript_id = $1 AND source = 'auto'`, [transcriptId]);

  const seqOf = new Map(turns.map((t) => [t.id, t.seq]));
  const all = [
    ...keep.map((k) => ({ human: true, id: k.id, anchor: k.start_turn_id })),
    ...insert.map((s) => ({ human: false, s, anchor: s.start.id })),
  ].sort((a, b) => (seqOf.get(a.anchor) ?? 0) - (seqOf.get(b.anchor) ?? 0));

  let order = 0;
  for (const row of all) {
    if (row.human) {
      await runner.query(`UPDATE hearing_sections SET order_index = $2, updated_at = now() WHERE id = $1`, [row.id, order++]);
      continue;
    }
    const s = row.s;
    await runner.query(
      `INSERT INTO hearing_sections
         (hearing_id, transcript_id, order_index, type, label, member_id, start_turn_id,
          source, confidence, method, detection_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'auto',$8,$9,$10)`,
      [hearingId, transcriptId, order++, s.type, s.label, s.member?.id ?? null, s.start.id,
       s.confidence, s.method, s.notes.length ? s.notes.join(' · ') : null]);
  }
  return { inserted: insert.length, preserved: keep.length, dropped };
}

/**
 * Fingerprint every field of speaker_turns that sectioning must never touch.
 * Compared before/after a write to prove the isolation boundary held.
 */
async function turnsFingerprint(runner, transcriptId) {
  const { rows } = await runner.query(
    `SELECT count(*)::int n,
            md5(string_agg(coalesce(raw_text,'') || coalesce(clean_text,'') ||
                coalesce(member_id::text,'') || speaker_key || attribution_status ||
                coalesce(suggestions::text,''), '|' ORDER BY seq)) h
       FROM speaker_turns WHERE transcript_id = $1`, [transcriptId]);
  return `${rows[0].n}:${rows[0].h}`;
}

module.exports = {
  C, SOFT, HANDOFF_WORDS,
  detectSections, loadSectionTurns, writeSections, turnsFingerprint,
  reconcile, resolvePerson, dedupePlaced, placeCut, findChairBucket, detectCandidates, buildSections,
};

// ── The tiling invariant ────────────────────────────────────────────────────
/**
 * Sections must tile the transcript: every turn belongs to exactly one section,
 * no gaps, no overlaps, no empty ranges. Pure so it can be unit-tested; the DB
 * wrapper (adminController.assertContiguousTiling) runs it inside every
 * section-mutating transaction and rolls back on any violation.
 *
 * Note what CANNOT go wrong by construction: a section always spans at least
 * its own anchor turn, and two sections cannot share an anchor (UNIQUE
 * (transcript_id, start_turn_id)). So zero-turn sections are unrepresentable.
 * What this catches is a first section that does not start at the transcript's
 * first turn, an anchor belonging to another transcript, and duplicate anchors
 * if that constraint is ever dropped.
 *
 * @param anchors  [{ id, start_seq }] — one per section
 * @param turnSeqs sorted seq values of every turn in the transcript
 * @returns string[] — empty means the partition is sound
 */
function checkTiling(anchors, turnSeqs) {
  const problems = [];
  if (!turnSeqs.length) return problems;              // nothing to tile
  if (!anchors.length) return ['no sections cover this transcript'];

  const valid = new Set(turnSeqs);
  const first = turnSeqs[0];
  const last = turnSeqs[turnSeqs.length - 1];
  const sorted = [...anchors].sort((a, b) => a.start_seq - b.start_seq);

  if (sorted[0].start_seq !== first) {
    problems.push(`first section starts at turn ${sorted[0].start_seq}, but the transcript starts at turn ${first} — turns ${first}–${sorted[0].start_seq - 1} would belong to no section`);
  }
  const seen = new Set();
  for (const a of sorted) {
    if (!valid.has(a.start_seq)) problems.push(`section ${String(a.id).slice(0, 8)} is anchored to turn ${a.start_seq}, which is not in this transcript`);
    if (seen.has(a.start_seq)) problems.push(`two sections start at turn ${a.start_seq}`);
    seen.add(a.start_seq);
  }
  let covered = 0;
  sorted.forEach((a, i) => {
    const end = i + 1 < sorted.length ? sorted[i + 1].start_seq - 1 : last;
    if (end < a.start_seq) problems.push(`section ${String(a.id).slice(0, 8)} at turn ${a.start_seq} would cover no turns`);
    else covered += end - a.start_seq + 1;
  });
  if (!problems.length && covered !== turnSeqs.length) {
    problems.push(`sections cover ${covered} turns but the transcript has ${turnSeqs.length}`);
  }
  return problems;
}

module.exports.checkTiling = checkTiling;

/**
 * DB wrapper for checkTiling. Runs inside a transaction, immediately before
 * COMMIT, so a multi-step operation may pass through intermediate states and is
 * validated only once, whole. Throws (err.tiling set) so the caller rolls back.
 *
 * Shared by the admin endpoints and the CLI so there is one enforcement point.
 */
async function assertTiling(runner, transcriptId) {
  const { rows: anchors } = await runner.query(
    `SELECT hs.id, st.seq AS start_seq
       FROM hearing_sections hs
       JOIN speaker_turns st ON st.id = hs.start_turn_id
      WHERE hs.transcript_id = $1`, [transcriptId]);
  const { rows: seqs } = await runner.query(
    `SELECT seq FROM speaker_turns WHERE transcript_id = $1 ORDER BY seq`, [transcriptId]);
  const problems = checkTiling(anchors, seqs.map((r) => r.seq));
  if (problems.length) {
    const err = new Error(`Section tiling would break: ${problems.join('; ')}`);
    err.tiling = problems;
    throw err;
  }
}

module.exports.assertTiling = assertTiling;
