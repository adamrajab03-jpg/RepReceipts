// ============================================================================
//  SEARCH — cross-hearing full-text search of transcript text.
// ----------------------------------------------------------------------------
//  Results are TURNS. The foundation is speaker_turns.search_tsv — a GENERATED
//  STORED tsvector over coalesce(clean_text, raw_text, '') (migration 001), so
//  it indexes EXACTLY the words a reader sees (the displayable-text rule,
//  utils/turnContent) with no drift and no maintenance code. It is GIN-indexed
//  (idx_speaker_turns_search).
//
//  THREE THINGS THIS QUERY GETS RIGHT
//   1. Public transcript only. A hearing may have several transcripts (a live
//      one later superseded by GPO). The LATERAL below restricts every turn to
//      the ONE transcript the public page shows, reusing publicTranscript()'s
//      exact ordering — one definition of "the public transcript", not a copy.
//   2. Stricter visibility than the transcript page. A snippet torn out of an
//      unreviewed draft would read as authoritative, so search gates on
//      SEARCHABLE_STATUSES (published/attributed/verified) — drafts never leak.
//   3. ts_headline (the expensive per-document highlighter) is computed in the
//      OUTER select over the already-paginated rows only — never over the whole
//      match set. Same for the two-query count.
//
//  websearch_to_tsquery parses user input safely ("Section 230" as a phrase,
//  OR, -exclusion; never throws) and is passed as ONE bound param reused across
//  WHERE / ts_rank / ts_headline.
//
//  SCALE (deferred, left as a marker): ts_rank ordering can't be served from a
//  GIN index, so a very popular term sorts a large candidate set. If that bites,
//  add the RUM extension (ranked order straight from the index) and switch OFFSET
//  paging to keyset/cursor. Not needed at current volume.
// ============================================================================
const db = require('../utils/db');
const { PUBLIC_TURN_FILTER } = require('../utils/publicTranscript');
const { industryLabel } = require('../utils/witnessIndustries');

const SEARCHABLE_STATUSES = ['published', 'attributed', 'verified'];

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PARTIES = new Set(['D', 'R', 'I']);

// Private-use Unicode sentinels for ts_headline's match markers. ts_headline
// does NOT HTML-escape the document, so real '<'/'>' in a transcript would be
// emitted raw — an XSS hole if we highlighted with literal <mark>. These chars
// never occur in transcript text; the client escapes the whole snippet, THEN
// swaps the sentinels for <mark></mark>, so the only tags that can reach the DOM
// are ones we introduced. (Kept in sync with frontend utils/snippet.ts.)
const MARK_START = '\uE000';
const MARK_STOP = '\uE001';
// HighlightAll returns the WHOLE turn with every (stem-aware) match wrapped —
// no word-count fragmenting, so nothing is clipped mid-sentence. The controller
// then does sentence-aware windowing in JS (buildSnippet). Postgres still owns
// the stemming, so "vaccine" marks "vaccines"/"vaccinated".
const HEADLINE_OPTS =
  `StartSel=${MARK_START},StopSel=${MARK_STOP},HighlightAll=TRUE`;

// ── Sentence-aware snippets ──────────────────────────────────────────────────
// A period after one of these is an abbreviation, not a sentence end. Lowercased,
// trailing dot stripped. Not exhaustive — "a sensible job", per the brief — but
// covers the cases that actually show up ("Mr. Chairman", "U.S.", "e.g.").
const ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'sen', 'rep', 'gov', 'gen', 'lt', 'col', 'sgt', 'capt',
  'cmdr', 'adm', 'st', 'jr', 'sr', 'vs', 'etc', 'inc', 'corp', 'ltd', 'co', 'dept',
  'fig', 'no', 'nos', 'al', 'ave', 'blvd', 'rd', 'prof', 'hon', 'pres', 'rev',
  'u.s', 'u.s.a', 'd.c', 'a.m', 'p.m', 'i.e', 'e.g', 'ph.d',
]);

const CLOSERS = new Set(['"', "'", ')', ']', '”', '’', MARK_START, MARK_STOP]);

/**
 * Split text into complete sentences on . ! ? — never mid-sentence. A terminator
 * only ends a sentence when it's followed (past any closing quotes/brackets) by
 * whitespace+capital/number or the end of text, and the word before a '.' isn't
 * an abbreviation or a single-letter initial ("John F. Kennedy"). Sentinel
 * highlight chars ride along inside the text untouched.
 */
function splitSentences(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    let j = i;
    while (j + 1 < text.length && '.!?'.includes(text[j + 1])) j++; // run: "?!", "..."
    let k = j + 1;
    while (k < text.length && CLOSERS.has(text[k])) k++;            // closing quotes/marks
    const rest = text.slice(k);
    const isEnd = /^\s*$/.test(rest);
    const isBoundary = isEnd || /^\s+["'“‘(]?[A-Z0-9]/.test(rest);
    if (!isBoundary) { i = j; continue; }
    if (ch === '.') {
      const m = text.slice(start, i).match(/([A-Za-z.]+)$/);
      const word = m ? m[1].toLowerCase().replace(/\.+$/, '') : '';
      const isInitial = m ? /^[A-Za-z]$/.test(m[1].replace(/\.+$/, '')) : false;
      if (isInitial || ABBREV.has(word)) { i = j; continue; }
    }
    const sentence = text.slice(start, j + 1).trim();
    if (sentence) out.push(sentence);
    start = k;
    i = k - 1;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * The snippet shown for a result: the matched sentence with the one before and
 * after it (continuous, no "…" stitching), centred on the FIRST matched
 * sentence. At a turn's edge there's no before/after, so it shows as much of the
 * window as exists — never a clipped half-sentence, never the rest of a long
 * turn. The whole turn is shown only when it has fewer than three sentences. With
 * no query (filters only) there's nothing to centre on, so lead with the start.
 */
function buildSnippet(doc, hasQuery) {
  const text = (doc ?? '').trim();
  if (!text) return '';
  const sentences = splitSentences(text);
  if (!hasQuery) return sentences.length <= 3 ? text : sentences.slice(0, 3).join(' ');

  const idx = sentences.findIndex((s) => s.includes(MARK_START));
  if (idx === -1) return text;                 // match not locatable — show it whole
  if (sentences.length < 3) return text;       // short turn — whole turn
  return sentences.slice(Math.max(0, idx - 1), idx + 2).join(' ');
}

const bad = (res, msg) => res.status(400).json({ error: msg });

async function search(req, res) {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const sort = req.query.sort === 'date' ? 'date' : 'relevance';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(req.query.page_size, 10) || DEFAULT_PAGE_SIZE),
  );
  const offset = (page - 1) * pageSize;

  // ── Speaker: one param, member (m:<uuid>) or witness (w:<uuid>) ─────────────
  // A witness isn't a global entity — it's a per-hearing (hearing_id,
  // speaker_name) record (migration 013). So w:<id> resolves to that pair and
  // matches by name within its hearing; a member matches by member_id.
  let memberId = null;
  let witnessFilter = null;
  const speaker = typeof req.query.speaker === 'string' ? req.query.speaker.trim() : '';
  if (speaker) {
    const id = speaker.slice(2);
    if (speaker.startsWith('m:')) {
      if (!UUID_RE.test(id)) return bad(res, 'Invalid speaker filter');
      memberId = id;
    } else if (speaker.startsWith('w:')) {
      if (!UUID_RE.test(id)) return bad(res, 'Invalid speaker filter');
      const { rows } = await db.query(
        'SELECT hearing_id, speaker_name FROM hearing_witnesses WHERE id = $1',
        [id],
      );
      // No record, or a record with no transcript link (written testimony /
      // orphaned): nothing to match — answer honestly with zero results.
      if (!rows.length || !rows[0].speaker_name) return empty(res, q, sort, page, pageSize);
      witnessFilter = rows[0];
    } else {
      return bad(res, 'Invalid speaker filter');
    }
  }

  const committee = optionalUuid(req.query.committee);
  if (committee === false) return bad(res, 'Invalid committee filter');
  const hearing = optionalUuid(req.query.hearing);
  if (hearing === false) return bad(res, 'Invalid hearing filter');

  const party = typeof req.query.party === 'string' && req.query.party ? req.query.party : null;
  if (party && !PARTIES.has(party)) return bad(res, 'Invalid party filter');

  const dateFrom = optionalDate(req.query.date_from);
  if (dateFrom === false) return bad(res, 'Invalid date_from (expected YYYY-MM-DD)');
  const dateTo = optionalDate(req.query.date_to);
  if (dateTo === false) return bad(res, 'Invalid date_to (expected YYYY-MM-DD)');

  const hasFilter = !!(memberId || witnessFilter || committee || party || dateFrom || dateTo || hearing);
  if (!q && !hasFilter) {
    return bad(res, 'Enter a search term or choose a filter');
  }

  // ── Compose WHERE ──────────────────────────────────────────────────────────
  const conditions = [PUBLIC_TURN_FILTER]; // reader-visible turns only (utils/turnContent)
  const params = [];

  params.push(SEARCHABLE_STATUSES);
  conditions.push(`h.status = ANY($${params.length})`);

  let tsqIdx = null;
  if (q) {
    params.push(q);
    tsqIdx = params.length;
    conditions.push(`st.search_tsv @@ websearch_to_tsquery('english', $${tsqIdx})`);
  }
  if (memberId) {
    params.push(memberId);
    conditions.push(`st.member_id = $${params.length}`);
  }
  if (witnessFilter) {
    params.push(witnessFilter.hearing_id);
    const hIdx = params.length;
    params.push(witnessFilter.speaker_name);
    conditions.push(`h.id = $${hIdx} AND st.speaker_name = $${params.length} AND st.member_id IS NULL`);
  }
  if (committee) {
    params.push(committee);
    conditions.push(`h.committee_id = $${params.length}`);
  }
  if (party) {
    params.push(party);
    conditions.push(`m.party = $${params.length}`); // witnesses have no party → excluded
  }
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`h.held_on >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`h.held_on <= $${params.length}`);
  }
  if (hearing) {
    params.push(hearing);
    conditions.push(`h.id = $${params.length}`);
  }

  const baseSql = `
    FROM speaker_turns st
    JOIN transcripts t ON t.id = st.transcript_id
    JOIN hearings   h  ON h.id = t.hearing_id
    -- Restrict to each hearing's PUBLIC transcript, the same one publicTranscript()
    -- picks — so search can't surface superseded or duplicate transcripts.
    JOIN LATERAL (
      SELECT id FROM transcripts
       WHERE hearing_id = h.id
       ORDER BY is_primary DESC, created_at DESC
       LIMIT 1
    ) pub ON pub.id = st.transcript_id
    LEFT JOIN members    m ON m.id = st.member_id
    LEFT JOIN committees c ON c.id = h.committee_id
    -- Witness affiliation for the result's speaker card. Linked the same way the
    -- public page links witnesses (migration 013): by exact speaker_name within
    -- the hearing. At most one match (partial unique index), so no row fan-out.
    LEFT JOIN hearing_witnesses hw ON hw.hearing_id = h.id AND hw.speaker_name = st.speaker_name
    WHERE ${conditions.join(' AND ')}
  `;

  // Relevance only means something with a query; filters-only falls back to date.
  const rankExpr = q ? `ts_rank(st.search_tsv, websearch_to_tsquery('english', $${tsqIdx}))` : '0';
  const orderBy = (p) =>
    sort === 'relevance' && q
      ? `${p}rank DESC, ${p}held_on DESC NULLS LAST, ${p}seq`
      : `${p}held_on DESC NULLS LAST, ${p}seq`;

  const limIdx = params.length + 1;
  const offIdx = params.length + 2;

  // Inner: filter, rank, order, paginate. Outer: highlight ONLY these rows.
  const innerSql = `
    SELECT st.id AS turn_id, st.seq, st.clean_text, st.raw_text,
           st.speaker_name, st.speaker_role, st.attribution_status,
           h.id AS hearing_id, h.title AS hearing_title, h.held_on, h.status AS hearing_status,
           c.name AS committee_name,
           m.id AS member_id, m.full_name AS member_full_name, m.party, m.state, m.chamber,
           hw.organization AS witness_org, hw.industry AS witness_industry,
           hw.industry_custom AS witness_industry_custom,
           ${rankExpr} AS rank
    ${baseSql}
    ORDER BY ${orderBy('')}
    LIMIT $${limIdx} OFFSET $${offIdx}
  `;

  // The whole displayable turn — with matches marked when there's a query — for
  // the controller's sentence-aware windowing (buildSnippet).
  const docExpr = q
    ? `ts_headline('english', coalesce(r.clean_text, r.raw_text, ''),
                   websearch_to_tsquery('english', $${tsqIdx}), '${HEADLINE_OPTS}')`
    : `coalesce(r.clean_text, r.raw_text, '')`;

  const pageSql = `
    SELECT r.turn_id, r.seq, r.speaker_name, r.speaker_role, r.attribution_status,
           r.hearing_id, r.hearing_title, r.held_on, r.hearing_status, r.committee_name,
           r.member_id, r.member_full_name, r.party, r.state, r.chamber, r.rank,
           r.witness_org, r.witness_industry, r.witness_industry_custom,
           ${docExpr} AS doc
    FROM ( ${innerSql} ) r
    ORDER BY ${orderBy('r.')}
  `;

  const countSql = `SELECT count(*)::int AS total, count(DISTINCT h.id)::int AS hearings ${baseSql}`;

  const [countRes, pageRes] = await Promise.all([
    db.query(countSql, params),
    db.query(pageSql, [...params, pageSize, offset]),
  ]);

  const { total, hearings } = countRes.rows[0];
  const data = pageRes.rows.map((row) => ({
    turn_id: row.turn_id,
    seq: row.seq,
    snippet: buildSnippet(row.doc, !!q),
    rank: row.rank,
    hearing: {
      id: row.hearing_id,
      title: row.hearing_title,
      held_on: row.held_on,
      status: row.hearing_status,
      committee_name: row.committee_name,
    },
    speaker: {
      member_id: row.member_id,
      full_name: row.member_full_name,
      party: row.party,
      state: row.state,
      chamber: row.chamber,
    },
    speaker_name: row.speaker_name,
    speaker_role: row.speaker_role,
    attribution_status: row.attribution_status,
    // Affiliation for a witness's (non-linking) speaker card: organization and
    // the resolved industry label. Null for a member, or a witness with no record.
    witness: row.member_id
      ? null
      : {
        organization: row.witness_org,
        industry_label: row.witness_industry
          ? industryLabel(row.witness_industry, row.witness_industry_custom)
          : null,
      },
    jump_url: `/hearings/${row.hearing_id}#turn-${row.seq}`,
  }));

  res.json({ data, total, hearings, page, page_size: pageSize, q, sort });
}

// A well-formed request that provably can't match (e.g. a witness with no
// transcript link) — same envelope as a real empty result.
function empty(res, q, sort, page, pageSize) {
  return res.json({ data: [], total: 0, hearings: 0, page, page_size: pageSize, q, sort });
}

// Returns the trimmed uuid, null when absent, or false when malformed.
function optionalUuid(v) {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const s = v.trim();
  return UUID_RE.test(s) ? s : false;
}

// Returns the date string, null when absent, or false when malformed.
function optionalDate(v) {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const s = v.trim();
  return DATE_RE.test(s) ? s : false;
}

module.exports = { search };
