import type { WordTime } from '../types/api'
import { cn } from '../utils/cn'

interface WordTokenProps {
  word:    string
  turnId:  string
  timing?: WordTime
}

// Renders the word ONLY — no trailing space. The parent paragraph is
// responsible for the gap characters between tokens so that
// paragraphRef.current.textContent === clean_text ?? raw_text exactly.
export default function WordToken({ word, turnId, timing }: WordTokenProps) {
  return (
    <span
      data-turn={turnId}
      data-start={timing?.s}
      data-end={timing?.e}
      title={timing ? `${timing.s} ms – ${timing.e} ms` : undefined}
      className={cn(
        'rounded-sm transition-colors',
        timing
          ? 'cursor-pointer hover:bg-amber-100 hover:text-amber-900'
          : 'cursor-default hover:bg-gray-100'
      )}
    >
      {word}
    </span>
  )
}
