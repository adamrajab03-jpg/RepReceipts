// ============================================================================
//  Citation snapshot — what a shared quote records at the moment it is shared.
// ----------------------------------------------------------------------------
//  Everything here is derived from the TURN AS STORED, never from the client:
//  the client sends a turn id and a char range, and this decides the exact
//  words, the context around them, and when they were spoken. That is what
//  makes anonymous sharing safe — a citation cannot carry words the
//  transcript did not contain.
//
//  Text is the displayed text (clean_text ?? raw_text), the same string the
//  public page renders, so char offsets mean the same thing on both sides.
//  Timing comes from wordAlign (the backend twin of tokenizeTurn.ts), so a
//  word that survived an accepted edit keeps the time it was spoken.
// ============================================================================
const { tokenizeText } = require('./wordAlign');
const { displayText } = require('./turnContent');

/** Max snapshot length — long enough for a paragraph, short enough to be a quote. */
const MAX_QUOTE_CHARS = 1200;
/** Context kept either side of the quote, for disambiguating repeated phrases. */
const CONTEXT_CHARS = 64;

/**
 * Build the text + time snapshot for a selection [charStart, charEnd) of a
 * turn's displayed text. Throws { status, message } on an unusable selection.
 *
 * The selection is SNAPPED OUT to whole words: a quote never starts or ends
 * mid-word ("ator Smith said"). Whitespace at the edges falls away with it.
 */
function snapshotQuote(turn, charStart, charEnd) {
  const text = displayText(turn);
  if (!Number.isInteger(charStart) || !Number.isInteger(charEnd) ||
      charStart < 0 || charEnd > text.length || charEnd <= charStart) {
    throw { status: 400, message: 'Selection is out of range for this turn' };
  }

  const tokens = tokenizeText(text, turn.word_times);
  const first = tokens.findIndex((t) => t.charEnd > charStart && t.charStart < charEnd);
  if (first === -1) throw { status: 400, message: 'Selection contains no words' };
  let last = first;
  while (last + 1 < tokens.length && tokens[last + 1].charStart < charEnd) last++;

  const start = tokens[first].charStart;
  const end = tokens[last].charEnd;
  const quoted = text.slice(start, end);
  if (quoted.length > MAX_QUOTE_CHARS) {
    throw { status: 400, message: `Quote is too long — select at most ${MAX_QUOTE_CHARS.toLocaleString('en-US')} characters` };
  }

  // ── Time ───────────────────────────────────────────────────────────────────
  // The ANCHOR is the span of timed words inside the quote: the recording-clock
  // fact re-location relies on. min/max rather than first/last so a
  // non-monotonic ASR timestamp can't produce an inverted range.
  const timed = tokens.slice(first, last + 1).filter((t) => t.wt);
  const anchorStart = timed.length ? Math.min(...timed.map((t) => t.wt.s)) : null;
  const anchorEnd = timed.length ? Math.max(...timed.map((t) => t.wt.e)) : null;

  // SEEK is where playback should begin: the quote's own first word when it is
  // timed; otherwise EARLY rather than late — the nearest timed word before
  // it, then the turn's start — and only as a last resort the first timed word
  // inside the quote (which would clip its opening words).
  let seekMs = null;
  let timingBasis = 'none';
  const before = tokens.slice(0, first).reverse().find((t) => t.wt);
  if (tokens[first].wt) { seekMs = tokens[first].wt.s; timingBasis = 'word'; }
  else if (before) { seekMs = before.wt.s; timingBasis = 'nearby_word'; }
  else if (turn.start_ms != null) { seekMs = turn.start_ms; timingBasis = 'turn'; }
  else if (timed.length) { seekMs = timed[0].wt.s; timingBasis = 'nearby_word'; }

  return {
    char_start: start,
    char_end: end,
    quoted_text: quoted,
    prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: text.slice(end, end + CONTEXT_CHARS),
    text_basis: turn.clean_text != null ? 'clean' : 'raw',
    anchor_start_ms: anchorStart,
    anchor_end_ms: anchorEnd,
    seek_ms: seekMs,
    timing_basis: timingBasis,
  };
}

/**
 * Who a turn's words are attributed to, as the citation records it: the
 * member if attributed to one, else the name the page shows (a witness name,
 * or the raw diarization label for an unattributed speaker).
 */
function speakerSnapshot(turn) {
  return {
    member_id: turn.member_id ?? null,
    speaker_name: turn.member_full_name ?? turn.speaker_name ?? turn.speaker_label_raw ?? 'Unknown speaker',
    speaker_label_raw: turn.speaker_label_raw ?? null,
    speaker_role: turn.speaker_role ?? null,
    speaker_party: turn.member_id ? turn.party ?? null : null,
    speaker_state: turn.member_id ? turn.state ?? null : null,
    speaker_chamber: turn.member_id ? turn.chamber ?? null : null,
  };
}

module.exports = { snapshotQuote, speakerSnapshot, displayText, MAX_QUOTE_CHARS, CONTEXT_CHARS };
