import { useRef, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import type { SpeakerTurn as Turn, WordTime } from '../types/api'
import { useAuthStore } from '../store/authStore'
import WordToken from './WordToken'
import CommentThread from './CommentThread'
import CommentForm from './CommentForm'
import { cn } from '../utils/cn'

// ── Types ─────────────────────────────────────────────────────────────────────
interface Token {
  word:      string
  charStart: number
  charEnd:   number
  wt?:       WordTime
}

type QuoteState =
  | { phase: 'idle' }
  | { phase: 'popover'; charStart: number; charEnd: number; text: string; anchorRect: DOMRect }
  | { phase: 'form';    charStart: number; charEnd: number; text: string }

// ── Tokeniser — finds each word's EXACT position in the canonical text ────────
// The resulting charStart/charEnd values are char offsets into
// (clean_text ?? raw_text), so the DOM paragraph.textContent === that string
// and char_start/char_end stored in comment_quotes reference the same string
// that resolveToMs walks when resolving timestamps.
function tokenize(turn: Turn): Token[] {
  const text = turn.clean_text ?? turn.raw_text

  if (turn.word_times?.length) {
    let searchFrom = 0
    return turn.word_times.map(wt => {
      const idx = text.indexOf(wt.w, searchFrom)
      const charStart = idx !== -1 ? idx : searchFrom
      const charEnd   = charStart + wt.w.length
      searchFrom = charEnd
      return { word: wt.w, charStart, charEnd, wt }
    })
  }

  // No word_times: locate each non-whitespace run using exec so we get exact
  // match.index positions in the original text.
  const tokens: Token[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    tokens.push({ word: m[0], charStart: m.index, charEnd: m.index + m[0].length })
  }
  return tokens
}

// ── Renderer — interleaves span tokens with literal text gaps ─────────────────
// Result: paragraph.textContent === text, character for character.
function renderTokens(text: string, tokens: Token[], turnId: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let pos = 0
  tokens.forEach((t, i) => {
    if (t.charStart > pos) nodes.push(text.substring(pos, t.charStart))
    nodes.push(<WordToken key={i} word={t.word} turnId={turnId} timing={t.wt} />)
    pos = t.charEnd
  })
  if (pos < text.length) nodes.push(text.substring(pos))
  return nodes
}

// ── Role badges ───────────────────────────────────────────────────────────────
const ROLE_STYLES: Record<string, string> = {
  chair:   'bg-slate-200 text-slate-700',
  member:  'bg-blue-100 text-blue-700',
  witness: 'bg-purple-100 text-purple-700',
  staff:   'bg-gray-100 text-gray-600',
  unknown: 'bg-gray-100 text-gray-500',
}

function fmtMs(ms: number) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function SpeakerTurn({ turn, index }: { turn: Turn; index: number }) {
  const user         = useAuthStore(s => s.user)
  const paragraphRef = useRef<HTMLParagraphElement>(null)
  const [quoteState, setQuoteState] = useState<QuoteState>({ phase: 'idle' })
  const [showComments, setShowComments] = useState(false)

  // Fall back through: attributed member → witness/non-member name → Deepgram's
  // raw diarization label ("Speaker 2") → last-resort. Without speaker_label_raw
  // every un-attributed batch turn would render "Unknown Speaker", hiding the
  // diarization entirely.
  const displayName =
    turn.member_full_name ?? turn.speaker_name ?? turn.speaker_label_raw ?? 'Unknown Speaker'
  const text        = turn.clean_text ?? turn.raw_text
  const tokens      = tokenize(turn)
  const hasWordTimes = !!turn.word_times?.length

  // ── Quote selection ─────────────────────────────────────────────────────────
  function handleMouseUp() {
    if (!user) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return

    const range     = sel.getRangeAt(0)
    const container = paragraphRef.current
    if (!container?.contains(range.commonAncestorContainer)) return

    const selectedText = range.toString()
    if (!selectedText.trim()) return

    // char offsets into paragraph.textContent (=== clean_text ?? raw_text)
    const before = document.createRange()
    before.setStart(container, 0)
    before.setEnd(range.startContainer, range.startOffset)
    const charStart = before.toString().length
    const charEnd   = charStart + selectedText.length

    setQuoteState({
      phase: 'popover',
      charStart,
      charEnd,
      text: selectedText,
      anchorRect: range.getBoundingClientRect(),
    })
  }

  // Dismiss popover when the user clears their selection
  useEffect(() => {
    if (quoteState.phase !== 'popover') return
    const handler = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) setQuoteState({ phase: 'idle' })
    }
    document.addEventListener('selectionchange', handler)
    return () => document.removeEventListener('selectionchange', handler)
  }, [quoteState.phase])

  function openQuoteForm() {
    if (quoteState.phase !== 'popover') return
    window.getSelection()?.removeAllRanges()
    setQuoteState({ phase: 'form', charStart: quoteState.charStart, charEnd: quoteState.charEnd, text: quoteState.text })
  }

  // ── Render ──────────────────────────────────────────────────────────────────
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
            ROLE_STYLES[turn.speaker_role] ?? ROLE_STYLES.unknown)}>
            {turn.speaker_role}
          </span>
        )}

        {turn.start_ms != null && (
          <span className="ml-auto text-xs text-gray-400 font-mono tabular-nums">
            {fmtMs(turn.start_ms)}
          </span>
        )}
      </div>

      {turn.topics?.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {turn.topics.map(t => (
            <Link
              key={t.id}
              to={`/hearings?topic=${t.slug}`}
              className="text-xs px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200 hover:bg-teal-100 transition-colors"
            >
              {t.name}
            </Link>
          ))}
        </div>
      )}

      {/* Word-token paragraph — textContent === clean_text ?? raw_text */}
      <p
        ref={paragraphRef}
        onMouseUp={handleMouseUp}
        className="text-sm text-gray-700 leading-relaxed select-text cursor-text"
      >
        {renderTokens(text, tokens, turn.id)}
      </p>

      {hasWordTimes && (
        <p className="mt-1 text-xs text-amber-600/60">
          {turn.word_times!.length} word timestamps — hover each word to inspect ms range
        </p>
      )}

      {/* Quote form (inline, replaces popover after "Quote & Comment" click) */}
      {quoteState.phase === 'form' && (
        <div className="mt-3">
          <CommentForm
            scope={{ type: 'turn', id: turn.id }}
            quote={{
              char_start:  quoteState.charStart,
              char_end:    quoteState.charEnd,
              quoted_text: quoteState.text,
            }}
            onDone={() => setQuoteState({ phase: 'idle' })}
            autoFocus
          />
        </div>
      )}

      {/* Comment thread (lazy: query only fires after first expand) */}
      <CommentThread
        scope={{ type: 'turn', id: turn.id }}
        turnRef={{
          id:         turn.id,
          seq:        turn.seq,
          raw_text:   turn.raw_text,
          clean_text: turn.clean_text,
          word_times: turn.word_times,
        }}
        defaultCollapsed
      />

      {/* Quote & Comment popover — fixed, portalled to avoid overflow clipping */}
      {/* TODO: add touchend handler for mobile quote-selection */}
      {quoteState.phase === 'popover' && createPortal(
        <div
          className="fixed z-50 flex items-center gap-1.5 bg-slate-800 text-white text-xs px-3 py-1.5 rounded-lg shadow-lg pointer-events-auto"
          style={{
            top:       quoteState.anchorRect.bottom + window.scrollY + 6,
            left:      quoteState.anchorRect.left + quoteState.anchorRect.width / 2 + window.scrollX,
            transform: 'translateX(-50%)',
          }}
        >
          <span>💬</span>
          <button
            onMouseDown={e => e.preventDefault()}  // prevent selection loss before click
            onClick={openQuoteForm}
            className="font-medium hover:text-amber-300 transition-colors"
          >
            Quote &amp; Comment
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}
