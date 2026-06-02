import { Link } from 'react-router-dom'
import type { SpeakerTurn as Turn } from '../types/api'
import WordToken from './WordToken'
import { cn } from '../utils/cn'

const roleStyles: Record<string, string> = {
  chair:   'bg-slate-200 text-slate-700',
  member:  'bg-blue-100 text-blue-700',
  witness: 'bg-purple-100 text-purple-700',
  staff:   'bg-gray-100 text-gray-600',
  unknown: 'bg-gray-100 text-gray-500',
}

function fmtMs(ms: number) {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// Build token list from word_times if available, else split on whitespace.
function tokenize(turn: Turn) {
  if (turn.word_times?.length) {
    return turn.word_times.map(wt => ({ word: wt.w, wt }))
  }
  const text = turn.clean_text ?? turn.raw_text
  return text.split(/\s+/).filter(Boolean).map(word => ({ word, wt: undefined }))
}

export default function SpeakerTurn({ turn, index }: { turn: Turn; index: number }) {
  const displayName = turn.member_full_name ?? turn.speaker_name ?? 'Unknown Speaker'
  const tokens = tokenize(turn)
  const hasWordTimes = !!turn.word_times?.length

  return (
    <div
      id={`turn-${turn.seq}`}
      className={cn('py-5 px-5', index % 2 === 0 ? 'bg-white' : 'bg-gray-50/60')}
    >
      {/* Speaker header */}
      <div className="flex items-center gap-2 mb-2">
        {turn.member_id ? (
          <Link
            to={`/members/${turn.member_id}`}
            className="text-sm font-semibold text-slate-800 hover:text-slate-600 hover:underline"
          >
            {displayName}
          </Link>
        ) : (
          <span className="text-sm font-semibold text-slate-800">{displayName}</span>
        )}

        {turn.speaker_role && (
          <span className={cn('text-xs px-2 py-0.5 rounded-full capitalize',
            roleStyles[turn.speaker_role] ?? roleStyles.unknown)}>
            {turn.speaker_role}
          </span>
        )}

        {turn.start_ms != null && (
          <span className="ml-auto text-xs text-gray-400 font-mono tabular-nums">
            {fmtMs(turn.start_ms)}
          </span>
        )}
      </div>

      {/* Word-token body */}
      <p className="text-sm text-gray-700 leading-relaxed">
        {tokens.map((t, i) => (
          <WordToken
            key={i}
            word={t.word}
            turnId={turn.id}
            timing={t.wt}
          />
        ))}
      </p>

      {hasWordTimes && (
        <p className="mt-1.5 text-xs text-amber-600/60">
          {turn.word_times!.length} word timestamps — hover each word to inspect ms range
        </p>
      )}
    </div>
  )
}
