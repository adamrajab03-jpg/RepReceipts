import type { WordTime } from '../types/api'

/**
 * Given a turn's word_times array, its canonical text, and a char offset into
 * that text, return the start_ms of the word whose position in the text is
 * closest to charStart. Used to convert a quote's char_start into a video
 * timestamp for display.
 *
 * The text scan mirrors the tokenizer in SpeakerTurn: it finds each word's
 * exact index in the canonical string using indexOf(), so positions stay
 * accurate regardless of spacing variations.
 */
export function resolveToMs(
  wordTimes: WordTime[],
  text: string,
  charStart: number,
): number | null {
  if (!wordTimes.length) return null

  let searchFrom = 0
  let best = wordTimes[0]
  let bestDist = Infinity

  for (const wt of wordTimes) {
    const idx = text.indexOf(wt.w, searchFrom)
    if (idx === -1) continue
    const dist = Math.abs(idx - charStart)
    if (dist < bestDist) {
      bestDist = dist
      best = wt
    }
    searchFrom = idx + wt.w.length
  }

  return best.s
}

export function msToTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
