// ============================================================================
//  Deepgram Nova-3 batch (pre-recorded) client + word→turn grouping.
// ----------------------------------------------------------------------------
//  Slice 1: run a local audio file or a remote URL through Deepgram's
//  pre-recorded endpoint with diarization, and reshape the flat word list into
//  speaker turns ready for the speaker_turns table. No attribution here — turns
//  carry only Deepgram's "Speaker N" label.
//
//  Grouping logic is ported from the realtime DeepgramRealtimeSession
//  (see ingestion/_reference/, not committed) but simplified for batch: the
//  whole word list arrives at once, so there is no buffering/flush machinery.
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';

// Nova-3 pre-recorded, pay-as-you-go. Diarization is included at no extra
// charge on Nova models. Update if your Deepgram plan differs.
// https://deepgram.com/pricing
const NOVA3_PRERECORDED_USD_PER_MIN = 0.0043;

// Deepgram infers most formats, but sending an accurate Content-Type for local
// files avoids the occasional mis-detection.
const CONTENT_TYPES = {
  '.mp3': 'audio/mpeg',
  '.mp4': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
  '.aac': 'audio/aac',
};

function isUrl(s) {
  return /^https?:\/\//i.test(s);
}

/**
 * Resolve a CLI source argument (local path or http(s) URL) once, up front.
 * Local file bytes are read here and reused for both cache-keying and the
 * Deepgram upload, so a large file is only read from disk a single time.
 */
function loadSource(source) {
  if (isUrl(source)) return { isUrl: true, url: source };

  const abs = path.resolve(source);
  if (!fs.existsSync(abs)) throw new Error(`Audio file not found: ${abs}`);
  return {
    isUrl: false,
    buffer: fs.readFileSync(abs),
    contentType: CONTENT_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream',
  };
}

/**
 * Content-addressed cache key: the same audio bytes (or the same URL string)
 * always hash to the same key regardless of which hearing consumes them, so
 * the Deepgram artifact cache keeps hitting across dedup, delete, and re-ingest.
 */
function computeSourceKey(loaded) {
  return crypto
    .createHash('sha256')
    .update(loaded.isUrl ? loaded.url : loaded.buffer)
    .digest('hex');
}

/**
 * POST an already-loaded source to Deepgram's pre-recorded API and return the
 * parsed JSON response. Uses global fetch (Node 18+).
 */
async function transcribeSource(loaded, apiKey) {
  const params = new URLSearchParams({
    model: 'nova-3',
    diarize: 'true',      // per-word `speaker` field
    punctuate: 'true',    // per-word `punctuated_word`
    smart_format: 'true', // numbers, dates, currency
  });
  const url = `${DEEPGRAM_URL}?${params.toString()}`;

  const body = loaded.isUrl ? JSON.stringify({ url: loaded.url }) : loaded.buffer;
  const contentType = loaded.isUrl ? 'application/json' : loaded.contentType;

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': contentType },
    body,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Deepgram API error ${res.status}: ${detail.slice(0, 500)}`);
  }
  return res.json();
}

/**
 * Reshape one Deepgram word into a word_times entry. `w` is the punctuated form
 * so it matches raw_text (see buildTurn), `s`/`e` are millisecond offsets, and
 * `c` is the per-word ASR confidence.
 */
function toWordTime(w) {
  return {
    w: w.punctuated_word ?? w.word,
    s: Math.round((w.start ?? 0) * 1000),
    e: Math.round((w.end ?? 0) * 1000),
    c: Number((w.confidence ?? 0).toFixed(3)),
  };
}

/**
 * Turn a completed group of same-speaker words into a speaker_turns-shaped
 * object.
 */
function buildTurn(speaker, words) {
  const wordTimes = words.map(toWordTime);

  // raw_text MUST be built from the SAME punctuated tokens stored in
  // word_times, joined by single spaces. SpeakerTurn.tokenize() and
  // resolveToMs() both anchor each timestamp with raw_text.indexOf(wt.w); if
  // raw_text used different tokens (e.g. Deepgram's `transcript` string) those
  // lookups would drift and mis-place every timestamp.
  const rawText = wordTimes.map((t) => t.w).join(' ');

  const meanConf = wordTimes.length
    ? wordTimes.reduce((acc, t) => acc + t.c, 0) / wordTimes.length
    : null;

  return {
    speakerLabelRaw: `Speaker ${speaker + 1}`, // Deepgram speaker is 0-indexed
    startMs: wordTimes[0].s,
    endMs: wordTimes[wordTimes.length - 1].e,
    // Slice 1 placeholder: this is the turn's ASR mean confidence. When
    // attribution lands, speaker_turns.confidence becomes *attribution*
    // confidence and this ASR value moves out — the granular case is already
    // covered by per-word `c` in word_times above.
    confidence: meanConf != null ? Number(meanConf.toFixed(3)) : null,
    rawText,
    wordTimes,
  };
}

/**
 * Group a flat, diarized word list into consecutive same-speaker turns.
 * Returns [] for empty input.
 */
function groupWordsIntoTurns(words) {
  const turns = [];
  if (!words || !words.length) return turns;

  let curSpeaker = words[0].speaker ?? 0;
  let curWords = [];

  for (const w of words) {
    const speaker = w.speaker ?? curSpeaker;
    if (speaker !== curSpeaker && curWords.length) {
      turns.push(buildTurn(curSpeaker, curWords));
      curWords = [];
      curSpeaker = speaker;
    }
    curWords.push(w);
  }
  if (curWords.length) turns.push(buildTurn(curSpeaker, curWords));

  return turns;
}

module.exports = {
  loadSource,
  computeSourceKey,
  transcribeSource,
  groupWordsIntoTurns,
  NOVA3_PRERECORDED_USD_PER_MIN,
};
