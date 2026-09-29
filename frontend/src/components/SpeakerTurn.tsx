import { useRef, useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import type { SpeakerTurn as Turn } from '../types/api'
import { useAuthStore } from '../store/authStore'
import WordToken from './WordToken'
import CommentThread from './CommentThread'
import CommentForm from './CommentForm'
import { cn } from '../utils/cn'
import { tokenizeText, type Token } from '../utils/tokenizeTurn'
import { formatTimecode } from '../utils/timecode'
import { memberLabel, partyPillClass, partyStateLabel } from '../utils/memberDisplay'

// ── Types ─────────────────────────────────────────────────────────────────────
type QuoteState =
  | { phase: 'idle' }
  | { phase: 'popover'; charStart: number; charEnd: number; text: string; anchorRect: DOMRect }
  | { phase: 'form';    charStart: number; charEnd: number; text: string }

// ── Renderer — interleaves span tokens with literal text gaps ─────────────────
// Tokens tile the canonical text exactly (see utils/tokenizeTurn), so every
// character between them — every space — is emitted verbatim from `text` and
// paragraph.textContent === text, character for character. Tokens carry their
// own slice of the text rather than a word from word_times, so a turn with
// accepted edits reads exactly as clean_text does.
function renderTokens(text: string, tokens: Token[], turnId: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let pos = 0
  tokens.forEach((t, i) => {
    if (t.charStart > pos) nodes.push(text.substring(pos, t.charStart))
    nodes.push(<WordToken key={i} word={text.substring(t.charStart, t.charEnd)} turnId={turnId} timing={t.wt} />)
    pos = t.charEnd
  })
  if (pos < text.length) nodes.push(text.substring(pos))
  return nodes
}

// ── Speaker label ─────────────────────────────────────────────────────────────
// The label is the reader's scanning anchor, so it stays sans-serif and clearly
// weighted against the serif testimony below it. Role reads as a quiet caption
// rather than a badge — a wall of coloured pills is noise in a public record.
const ROLE_LABEL: Record<string, string> = {
  chair: 'Chair',
  member: 'Member',
  witness: 'Witness',
  staff: 'Staff',
  unknown: '',
}

// Naming and party tint live in utils/memberDisplay, shared with the hearing
// context header — the same person must read identically in both places.

// ── Component ─────────────────────────────────────────────────────────────────
export default function SpeakerTurn({ turn, index, startsSection = false }: {
  turn: Turn
  index: number
  /** A section header sits directly above — it already provides the separation. */
  startsSection?: boolean
}) {
  const user         = useAuthStore(s => s.user)
  const paragraphRef = useRef<HTMLParagraphElement>(null)
  const [quoteState, setQuoteState] = useState<QuoteState>({ phase: 'idle' })

  // Fall back through: attributed member → witness/non-member name → Deepgram's
  // raw diarization label ("Speaker 2") → last-resort. Without speaker_label_raw
  // every un-attributed batch turn would render "Unknown Speaker", hiding the
  // diarization entirely.
  const displayName =
    turn.member_full_name ?? turn.speaker_name ?? turn.speaker_label_raw ?? 'Unknown Speaker'
  // Only an attributed member earns "Sen."/"Rep." — a witness or a bare
  // diarization label is shown exactly as it is.
  const label       = turn.member_id ? memberLabel(displayName, turn.chamber) : displayName
  const partyPill   = partyPillClass(turn.party)
  const partyState  = partyStateLabel(turn.party, turn.state)
  const roleLabel   = turn.speaker_role ? ROLE_LABEL[turn.speaker_role] ?? '' : ''
  const text        = turn.clean_text ?? turn.raw_text
  // Aligning word_times to the text costs real work on a long turn — do it once
  // per turn, not on every hover/selection re-render.
  const tokens      = useMemo(() => tokenizeText(text, turn.word_times), [text, turn.word_times])
  // Words that survived this turn's accepted edits keep their timing; a word an
  // edit removed or replaced beyond recovery has none, so count what is actually
  // hoverable rather than the raw word_times length.
  const timedWords  = tokens.reduce((n, t) => (t.wt ? n + 1 : n), 0)

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
      className={cn(
        'py-6',
        // Turns are separated by space and a hairline, not by a fill: alternating
        // stripes read as a spreadsheet, and this is meant to read as a record.
        !startsSection && index > 0 && 'border-t border-gray-100',
      )}
    >
      {/* Speaker label — sans, the scanning anchor above the serif testimony */}
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {turn.member_id ? (
          <Link
            to={`/members/${turn.member_id}`}
            className="text-sm font-semibold tracking-tight text-slate-900 underline decoration-slate-300 decoration-1 underline-offset-[3px] transition-colors hover:decoration-slate-900"
          >
            {label}
          </Link>
        ) : (
          <span className="text-sm font-medium text-slate-600">{label}</span>
        )}

        {partyPill && partyState && (
          <span className={cn('rounded px-1 text-[10px] font-bold leading-4 ring-1 ring-inset', partyPill)}>
            {partyState}
          </span>
        )}

        {roleLabel && (
          <span className="text-[11px] uppercase tracking-[0.08em] text-slate-500">{roleLabel}</span>
        )}

        {turn.start_ms != null && (
          <span className="ml-auto text-xs tabular-nums text-slate-500">
            {formatTimecode(turn.start_ms)}
          </span>
        )}
      </div>

      {turn.topics?.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {turn.topics.map(t => (
            <Link
              key={t.id}
              to={`/hearings?topic=${t.slug}`}
              className="rounded-full border border-teal-100 bg-teal-50/70 px-2 py-0.5 text-[11px] text-teal-700 transition-colors hover:bg-teal-100"
            >
              {t.name}
            </Link>
          ))}
        </div>
      )}

      {/* Word-token paragraph — textContent === clean_text ?? raw_text.
          Serif, ~1.75 leading, measure capped near 70ch: the reading layer. */}
      <p
        ref={paragraphRef}
        onMouseUp={handleMouseUp}
        className="max-w-[70ch] cursor-text select-text font-serif text-[17px] leading-[1.75] text-slate-800"
      >
        {renderTokens(text, tokens, turn.id)}
      </p>

      {timedWords > 0 && (
        <p className="mt-1.5 text-[11px] text-slate-400">
          {timedWords} word timestamps — hover each word to inspect ms range
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
