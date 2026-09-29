import { useRef, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import type { SpeakerTurn as Turn } from '../types/api'
import { useAuthStore } from '../store/authStore'
import CommentThread from './CommentThread'
import CommentForm from './CommentForm'
import { cn } from '../utils/cn'
import { formatTimecode } from '../utils/timecode'
import { memberLabel, partyPillClass, partyStateLabel } from '../utils/memberDisplay'

// ── Types ─────────────────────────────────────────────────────────────────────
type QuoteState =
  | { phase: 'idle' }
  | { phase: 'popover'; charStart: number; charEnd: number; text: string; anchorRect: DOMRect }
  | { phase: 'form';    charStart: number; charEnd: number; text: string }

// ── Quote popover placement ───────────────────────────────────────────────────
// Viewport coordinates for a position: fixed popover, centred under the
// selection — or above it when the selection sits near the bottom of the
// screen — and kept clear of the viewport's side edges.
const POPOVER_H = 32
const POPOVER_HALF_W = 80
function popoverPosition(rect: DOMRect): React.CSSProperties {
  const below = rect.bottom + 6
  const top = below + POPOVER_H > window.innerHeight - 8 ? rect.top - 6 - POPOVER_H : below
  const vw = document.documentElement.clientWidth
  const centre = Math.min(Math.max(rect.left + rect.width / 2, POPOVER_HALF_W + 8), vw - POPOVER_HALF_W - 8)
  return { top: Math.max(8, top), left: centre, transform: 'translateX(-50%)' }
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

  // ── Quote selection ─────────────────────────────────────────────────────────
  // The paragraph's selected part, kept so the popover can follow it on scroll.
  const quoteRangeRef = useRef<Range | null>(null)

  // Read the current selection as a quote of THIS turn: char offsets into
  // `text` (the paragraph's textContent === clean_text ?? raw_text). A selection
  // that spills past the paragraph — dragged up into the speaker label, or on
  // into the next turn — is clipped to it rather than rejected, and surrounding
  // whitespace is trimmed off the span, so the stored offsets are exactly the
  // quoted words.
  function captureSelection() {
    if (!user) return
    const sel = window.getSelection()
    const container = paragraphRef.current
    if (!sel || sel.isCollapsed || !sel.rangeCount || !container) return

    const range = sel.getRangeAt(0)
    if (!range.intersectsNode(container)) return

    const whole = document.createRange()
    whole.selectNodeContents(container)
    const offsetOf = (node: Node, offset: number) => {
      const r = document.createRange()
      r.setStart(container, 0)
      r.setEnd(node, offset)
      return r.toString().length
    }
    const startsInside = range.compareBoundaryPoints(Range.START_TO_START, whole) > 0
    const endsInside   = range.compareBoundaryPoints(Range.END_TO_END, whole) < 0
    let charStart = startsInside ? offsetOf(range.startContainer, range.startOffset) : 0
    let charEnd   = endsInside ? offsetOf(range.endContainer, range.endOffset) : text.length
    while (charStart < charEnd && /\s/.test(text[charStart])) charStart++
    while (charEnd > charStart && /\s/.test(text[charEnd - 1])) charEnd--
    if (charStart >= charEnd) return

    const clipped = range.cloneRange()
    if (!startsInside) clipped.setStart(whole.startContainer, whole.startOffset)
    if (!endsInside)   clipped.setEnd(whole.endContainer, whole.endOffset)
    quoteRangeRef.current = clipped

    setQuoteState({
      phase: 'popover',
      charStart,
      charEnd,
      text: text.slice(charStart, charEnd),
      anchorRect: clipped.getBoundingClientRect(),
    })
  }

  // A drag that starts in the paragraph often ENDS outside it — the measure is
  // capped at 70ch, so pulling to the end of a line releases over the margin.
  // Listening for mouseup on the paragraph missed exactly those selections, so
  // arm a one-shot document-level listener on press instead.
  function handlePointerDown(e: React.PointerEvent) {
    if (!user || e.button !== 0) return
    const onUp = () => {
      document.removeEventListener('pointerup', onUp)
      // After the browser has finalised the selection for this release.
      requestAnimationFrame(captureSelection)
    }
    document.addEventListener('pointerup', onUp)
  }

  // While the popover is up: dismiss it when the selection is cleared, and keep
  // it pinned to the selection as the page scrolls (it is position: fixed, so
  // its coordinates are viewport-relative and go stale on scroll).
  useEffect(() => {
    if (quoteState.phase !== 'popover') return
    const onSelection = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) setQuoteState({ phase: 'idle' })
    }
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const r = quoteRangeRef.current
        if (r) setQuoteState(s => (s.phase === 'popover' ? { ...s, anchorRect: r.getBoundingClientRect() } : s))
      })
    }
    document.addEventListener('selectionchange', onSelection)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', onSelection)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
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

      {/* The testimony as plain prose — one text node, so textContent ===
          clean_text ?? raw_text and a selection's char offsets (quotes) index
          straight into the canonical text. Word timing is NOT rendered; it stays
          in turn.word_times, and utils/tokenizeTurn maps text positions onto it
          (edit-aware) whenever a feature needs a word's time.
          Serif, ~1.75 leading, measure capped near 70ch: the reading layer. */}
      <p
        ref={paragraphRef}
        onPointerDown={handlePointerDown}
        className="max-w-[70ch] cursor-text select-text font-serif text-[17px] leading-[1.75] text-slate-800"
      >
        {text}
      </p>

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

      {/* Quote & Comment popover — fixed, portalled to avoid overflow clipping.
          getBoundingClientRect() is ALREADY viewport-relative, which is what
          position: fixed wants — adding window.scrollY (as this used to) pushed
          the popover off the bottom of the screen on any turn more than a
          viewport down the page, i.e. effectively all testimony. */}
      {/* TODO: mobile quote-selection (long-press selection handles fire no pointerup) */}
      {quoteState.phase === 'popover' && createPortal(
        <div
          className="fixed z-50 flex items-center gap-1.5 bg-slate-800 text-white text-xs px-3 py-1.5 rounded-lg shadow-lg pointer-events-auto"
          style={popoverPosition(quoteState.anchorRect)}
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
