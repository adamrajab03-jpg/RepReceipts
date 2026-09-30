import type { TextOrigin } from '../types/api'

// Where a turn's words came from, said plainly to a reader. A passage
// transcribed from the audio is anchored to the recording word by word; one
// typed by a reviewer rests on that person's judgement and has no per-word
// audio timing. That difference is material to how much weight the words
// bear — so the page says it, and a shared quote's receipt says it too.
// One wording, shared by both, so they can never disagree.

/** The note shown on a public turn, or null for an ordinary ASR turn. */
export function turnOriginNote(origin: TextOrigin | undefined, timed: boolean): string | null {
  if (origin === 'human') return 'Transcribed by a reviewer — no audio timing'
  if (origin === 'mixed') return timed ? 'Partly transcribed by a reviewer' : 'Partly transcribed by a reviewer — no audio timing'
  return null
}

/** The short label on a shared quote's receipt, or null for ASR. */
export function receiptOriginLabel(origin: TextOrigin | undefined): { label: string; title: string } | null {
  if (origin === 'human') {
    return { label: 'Reviewer-transcribed', title: 'These words were typed by a reviewer, not transcribed from the audio, and have no per-word audio timing.' }
  }
  if (origin === 'mixed') {
    return { label: 'Partly reviewer-transcribed', title: 'Part of this turn was typed by a reviewer rather than transcribed from the audio.' }
  }
  return null
}
