/**
 * Milliseconds into the hearing → the clock a video player shows: m:ss under an
 * hour, h:mm:ss beyond it. Hearings routinely run past an hour, where a plain
 * minute count ("79:04") stops being readable.
 */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
