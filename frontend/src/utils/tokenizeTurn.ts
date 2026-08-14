import type { WordTime } from '../types/api'

export interface Token {
  word:      string
  charStart: number
  charEnd:   number
  wt?:       WordTime
}

/**
 * Split a turn's canonical text (clean_text when it has accepted edits, else
 * raw_text) into word tokens and attach per-word timings to them.
 *
 * The tokens ALWAYS come from the text being rendered, never from word_times:
 * charStart/charEnd are exact by construction, so the rendered paragraph's
 * textContent equals the canonical string character for character. That is the
 * contract comment quotes (char_start/char_end into the same string) and
 * resolveToMs both depend on.
 *
 * word_times is anchored to the IMMUTABLE raw_text, so once an accepted edit has
 * removed or changed a word, the two sequences no longer line up one-to-one.
 * They are aligned below; a word_time that cannot be placed is left unplaced
 * rather than guessed — the same "locate or drop, never invent a position"
 * discipline as cleanupValidate.locateEdits and turnText.wordPositions.
 *
 * (Deriving token positions FROM word_times was the public transcript's
 * run-together-words bug: a word that failed to locate fell back to "wherever
 * the cursor happens to be", which both printed the stale pre-edit word and ate
 * the space in front of the next one — "the bill" rendered as "thebill".)
 */
export function tokenizeText(text: string, wordTimes?: WordTime[] | null): Token[] {
  const tokens: Token[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    tokens.push({ word: m[0], charStart: m.index, charEnd: m.index + m[0].length })
  }
  if (wordTimes?.length) attachTimings(tokens, wordTimes)
  return tokens
}

// Comparison key for one word: edge punctuation stripped, lowercased — the same
// "core" the backend validator uses. Matching on this makes the whole mechanical
// class of edits (capitalisation, punctuation) transparent, so a word that only
// changed case keeps its timestamp. Internal apostrophes/hyphens are kept, so
// "don't" never matches "dont".
const key = (s: string) =>
  s.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '').toLowerCase()

// Above this the LCS table is skipped (see alignMiddle). Only reached when a
// turn's text and its word_times disagree over hundreds of words, which means
// something has rewritten the turn wholesale — exactly the case where an
// alignment would be guesswork anyway.
const MAX_LCS_CELLS = 250_000

/**
 * Align word_times against the tokens of the rendered text and hang each timing
 * on the token it belongs to.
 *
 * Accepted edits are local, so the two sequences share a long common prefix and
 * suffix; those are matched directly and only the disputed middle is aligned
 * with an LCS. Words the LCS pairs up keep their timing. Inside a gap the LCS
 * couldn't pair, the timings are handed out only when the counts make the
 * pairing unambiguous — n unplaced timings against exactly n untimed tokens, the
 * shape a word-for-word swap leaves ("Killamen" → "Kimmelman" keeps its
 * timestamp). A gap of different sizes — a filler removed, a stutter collapsed —
 * is left alone: those tokens render without a hover timestamp, which is honest
 * rather than wrong.
 */
function attachTimings(tokens: Token[], wordTimes: WordTime[]): void {
  if (!tokens.length) return
  const A = wordTimes.map((wt) => key(wt.w ?? ''))   // timed words, raw_text order
  const B = tokens.map((t) => key(t.word))           // rendered words

  let lo = 0
  while (lo < A.length && lo < B.length && A[lo] === B[lo]) { tokens[lo].wt = wordTimes[lo]; lo++ }
  let hiA = A.length
  let hiB = B.length
  while (hiA > lo && hiB > lo && A[hiA - 1] === B[hiB - 1]) { hiA--; hiB--; tokens[hiB].wt = wordTimes[hiA] }

  if (hiA > lo || hiB > lo) alignMiddle(tokens, wordTimes, A, B, lo, hiA, hiB)
}

function alignMiddle(
  tokens: Token[], wordTimes: WordTime[],
  A: string[], B: string[],
  lo: number, hiA: number, hiB: number,
): void {
  const m = hiA - lo
  const n = hiB - lo

  // Anchors: index pairs (word_time, token) the two sequences agree on.
  const anchors: [number, number][] = []
  if (m > 0 && n > 0 && m * n <= MAX_LCS_CELLS) {
    const w = n + 1
    const lcs = new Uint16Array((m + 1) * w)
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        lcs[i * w + j] = A[lo + i] === B[lo + j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < m && j < n) {
      if (A[lo + i] === B[lo + j]) { anchors.push([lo + i, lo + j]); i++; j++ }
      else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) i++
      else j++
    }
  }

  for (const [ai, bi] of anchors) tokens[bi].wt = wordTimes[ai]

  // Hand out the timings between anchors only when the pairing is unambiguous.
  let prevA = lo - 1
  let prevB = lo - 1
  const bounds = [...anchors, [hiA, hiB] as [number, number]]
  for (const [ai, bi] of bounds) {
    const gapA = ai - prevA - 1
    const gapB = bi - prevB - 1
    if (gapA > 0 && gapA === gapB) {
      for (let k = 1; k <= gapA; k++) tokens[prevB + k].wt = wordTimes[prevA + k]
    }
    prevA = ai
    prevB = bi
  }
}
