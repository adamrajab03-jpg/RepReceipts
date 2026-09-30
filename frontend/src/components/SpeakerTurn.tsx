import { useRef, useState, useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import type { SpeakerTurn as Turn } from '../types/api'
import { useAuthStore } from '../store/authStore'
import CommentThread from './CommentThread'
import CommentForm from './CommentForm'
import { cn } from '../utils/cn'
import { formatTimecode } from '../utils/timecode'
import { memberLabel, partyPillClass, partyStateLabel } from '../utils/memberDisplay'
import { createCitation, citationUrl } from '../hooks/useCitation'
import { copyPending } from '../utils/clipboard'
import { turnOriginNote } from '../utils/textOrigin'

// ── Types ─────────────────────────────────────────────────────────────────────
type QuoteState =
  | { phase: 'idle' }
  | { phase: 'popover'; charStart: number; charEnd: number; text: string; anchorRect: DOMRect }
  | { phase: 'form';    charStart: number; charEnd: number; text: string }

// What the popover's "Copy link" is doing. Once a share has started, the
// popover no longer depends on the selection (the offsets are captured), so it
// stays up until it finishes or the reader dismisses it.
type ShareState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'copied' }
  | { kind: 'manual'; url: string }      // clipboard refused — show the URL to copy by hand
  | { kind: 'error'; message: string }

// ── Quote popover placement ───────────────────────────────────────────────────
// Viewport coordinates for a position: fixed popover, centred under the
// selection — or above it when the selection sits near the bottom of the
// screen — and kept clear of the viewport's side edges.
const POPOVER_H = 34
function popoverPosition(rect: DOMRect, halfWidth: number): React.CSSProperties {
  const below = rect.bottom + 6
  const top = below + POPOVER_H > window.innerHeight - 8 ? rect.top - 6 - POPOVER_H : below
  const vw = document.documentElement.clientWidth
  const centre = Math.min(Math.max(rect.left + rect.width / 2, halfWidth + 8), vw - halfWidth - 8)
  return { top: Math.max(8, top), left: centre, transform: 'translateX(-50%)' }
}

// ── Is a mouse button held? ───────────────────────────────────────────────────
// One page-wide tracker (not one per turn). A mouse selection is read when the
// button is released; selectionchange is the path for everything else — touch
// long-press and its drag handles, and keyboard selection — and must stay quiet
// while a mouse drag is still in progress.
let mouseHeld = false
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && e.button === 0) mouseHeld = true }, true)
  document.addEventListener('pointerup', () => { mouseHeld = false }, true)
}

/** How long a touch selection must sit still before the popover appears — long
 *  enough to let the reader finish dragging the selection handles. */
const SETTLE_MS = 400

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
export default function SpeakerTurn({ turn, index, startsSection = false, highlight, receipt }: {
  turn: Turn
  index: number
  /** A section header sits directly above — it already provides the separation. */
  startsSection?: boolean
  /** A shared quote's located passage in this turn (char range into the text). */
  highlight?: { start: number; end: number }
  /** The shared quote's receipt bar, shown above the text of the quote's first turn. */
  receipt?: ReactNode
}) {
  const user         = useAuthStore(s => s.user)
  const paragraphRef = useRef<HTMLParagraphElement>(null)
  const popoverRef   = useRef<HTMLDivElement>(null)
  // When the popover was last pressed. On touch, tapping a button can clear the
  // text selection BEFORE the tap's click fires; without this, the collapse
  // would dismiss the popover out from under the reader's finger.
  const pressedAt    = useRef(0)
  const [quoteState, setQuoteState] = useState<QuoteState>({ phase: 'idle' })
  const [share, setShare] = useState<ShareState>({ kind: 'idle' })

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
  const originNote  = turnOriginNote(turn.text_origin, !!turn.word_times?.length)
  // A highlight is only trusted if it fits the text this page actually has.
  const mark        = highlight && highlight.start < highlight.end && highlight.end <= text.length ? highlight : null

  // ── Quote selection ─────────────────────────────────────────────────────────
  // The paragraph's selected part, kept so the popover can follow it on scroll.
  const quoteRangeRef = useRef<Range | null>(null)

  // Read the current selection as a quote of THIS turn: char offsets into
  // `text` (the paragraph's textContent === clean_text ?? raw_text, even with
  // a <mark> inside it). A selection that spills past the paragraph — dragged
  // up into the speaker label, or on into the next turn — is clipped to it
  // rather than rejected (a quote is one speaker's words), and surrounding
  // whitespace is trimmed off the span, so the offsets are exactly the words.
  function captureSelection() {
    if (share.kind === 'busy') return           // a link is being made from the current capture
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

    setShare({ kind: 'idle' })
    setQuoteState({
      phase: 'popover',
      charStart,
      charEnd,
      text: text.slice(charStart, charEnd),
      anchorRect: clipped.getBoundingClientRect(),
    })
  }
  // The listeners below outlive a render; they always call the latest version.
  const captureRef = useRef(captureSelection)
  captureRef.current = captureSelection

  // Mouse: a drag that starts in the paragraph often ENDS outside it — the
  // measure is capped at 70ch, so pulling to the end of a line releases over
  // the margin. Arm a one-shot document-level listener on press.
  function handlePointerDown(e: React.PointerEvent) {
    if (e.pointerType !== 'mouse' || e.button !== 0) return
    const onUp = () => {
      document.removeEventListener('pointerup', onUp)
      // After the browser has finalised the selection for this release.
      requestAnimationFrame(() => captureRef.current())
    }
    document.addEventListener('pointerup', onUp)
  }

  // Touch (long-press, then dragging the selection handles) and keyboard: no
  // pointerup marks "done", so wait for the selection to settle. Only the turn
  // where the selection STARTED responds, so a selection across turns yields
  // one popover, not several.
  useEffect(() => {
    let timer = 0
    const onChange = () => {
      if (mouseHeld) return
      const sel = window.getSelection()
      const p = paragraphRef.current
      if (!sel || sel.isCollapsed || !p || !sel.anchorNode || !p.contains(sel.anchorNode)) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => captureRef.current(), SETTLE_MS)
    }
    document.addEventListener('selectionchange', onChange)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('selectionchange', onChange)
    }
  }, [])

  // While the popover is up: keep it pinned to the selection as the page
  // scrolls (it is position: fixed, so its coordinates go stale on scroll), and
  // dismiss it — when the selection is cleared if no share has started, else
  // on a tap/click outside it.
  const shareStarted = share.kind !== 'idle'
  useEffect(() => {
    if (quoteState.phase !== 'popover') return
    const onSelection = () => {
      if (shareStarted || Date.now() - pressedAt.current < 800) return
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) setQuoteState({ phase: 'idle' })
    }
    const onOutside = (e: PointerEvent) => {
      if (shareStarted && !popoverRef.current?.contains(e.target as Node)) setQuoteState({ phase: 'idle' })
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
    document.addEventListener('pointerdown', onOutside)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', onSelection)
      document.removeEventListener('pointerdown', onOutside)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [quoteState.phase, shareStarted])

  // "✓ Link copied" lingers briefly, then the popover and selection clear.
  useEffect(() => {
    if (share.kind !== 'copied') return
    const t = setTimeout(() => {
      window.getSelection()?.removeAllRanges()
      setQuoteState({ phase: 'idle' })
      setShare({ kind: 'idle' })
    }, 1600)
    return () => clearTimeout(t)
  }, [share.kind])

  function openQuoteForm() {
    if (quoteState.phase !== 'popover') return
    window.getSelection()?.removeAllRanges()
    setQuoteState({ phase: 'form', charStart: quoteState.charStart, charEnd: quoteState.charEnd, text: quoteState.text })
  }

  // Create the citation and copy its link. The clipboard write has to START
  // inside this click (Safari), so copyPending is called before any await and
  // is handed the link as a promise.
  function copyQuoteLink() {
    if (quoteState.phase !== 'popover' || share.kind === 'busy') return
    setShare({ kind: 'busy' })
    const link = createCitation({
      turn_id: turn.id,
      char_start: quoteState.charStart,
      char_end: quoteState.charEnd,
      expected_text: quoteState.text,
    }).then((c) => citationUrl(c.code))
    copyPending(link).then(
      (r) => setShare(r.copied ? { kind: 'copied' } : { kind: 'manual', url: r.text }),
      (e: Error) => setShare({ kind: 'error', message: e.message }),
    )
  }

  const closePopover = () => { setQuoteState({ phase: 'idle' }); setShare({ kind: 'idle' }) }

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

      {/* Not from the audio: say so, quietly but on every such turn. */}
      {originNote && (
        <p className="-mt-1 mb-2 text-[11px] italic text-slate-500">
          <span aria-hidden className="not-italic">✎ </span>{originNote}
        </p>
      )}

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

      {receipt}

      {/* The testimony as plain prose — textContent === clean_text ?? raw_text
          character for character (a shared quote's <mark> only wraps a slice of
          it), so a selection's char offsets index straight into the canonical
          text. Word timing is NOT rendered; it stays in turn.word_times.
          Serif, ~1.75 leading, measure capped near 70ch: the reading layer. */}
      <p
        ref={paragraphRef}
        onPointerDown={handlePointerDown}
        className="max-w-[70ch] cursor-text select-text font-serif text-[17px] leading-[1.75] text-slate-800"
      >
        {mark ? (
          <>
            {text.slice(0, mark.start)}
            <mark
              data-cite-mark
              className="scroll-mt-32 rounded-sm bg-amber-200/70 px-0.5 -mx-0.5 text-slate-900 box-decoration-clone"
            >
              {text.slice(mark.start, mark.end)}
            </mark>
            {text.slice(mark.end)}
          </>
        ) : text}
      </p>

      {/* Quote form (inline, replaces popover after "Comment" click) */}
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

      {/* Selection popover — fixed, portalled to avoid overflow clipping.
          getBoundingClientRect() is ALREADY viewport-relative, which is what
          position: fixed wants. "Copy link" is for everyone (sharing a quote
          needs no account); "Comment" needs one. */}
      {quoteState.phase === 'popover' && createPortal(
        <div
          ref={popoverRef}
          role="toolbar"
          aria-label="Quote actions"
          className="fixed z-50 flex items-center gap-1 rounded-lg bg-slate-800 px-1.5 py-1 text-xs text-white shadow-lg"
          style={popoverPosition(quoteState.anchorRect, share.kind === 'manual' ? 150 : share.kind === 'error' ? 140 : 90)}
          onPointerDown={() => { pressedAt.current = Date.now() }}
          // Keep the text selected while pressing a button (desktop).
          onMouseDown={e => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault() }}
        >
          {share.kind === 'copied' ? (
            <span className="px-2 py-1 font-medium text-green-300" role="status">✓ Link copied</span>
          ) : share.kind === 'manual' ? (
            <>
              <input
                readOnly
                value={share.url}
                aria-label="Quote link — copy it"
                onFocus={e => e.currentTarget.select()}
                autoFocus
                className="w-56 rounded bg-slate-700 px-2 py-1 text-xs text-white outline-none ring-1 ring-slate-500"
              />
              <button onClick={closePopover} aria-label="Close" className="px-1.5 py-1 text-slate-300 hover:text-white">×</button>
            </>
          ) : share.kind === 'error' ? (
            <>
              <span className="max-w-[16rem] px-2 py-1 text-amber-200" role="alert">{share.message}</span>
              <button onClick={closePopover} aria-label="Close" className="px-1.5 py-1 text-slate-300 hover:text-white">×</button>
            </>
          ) : (
            <>
              <button
                onClick={copyQuoteLink}
                disabled={share.kind === 'busy'}
                className="rounded px-2 py-1 font-medium transition-colors hover:bg-slate-700 hover:text-amber-300 disabled:opacity-70"
              >
                <span aria-hidden>🔗</span> {share.kind === 'busy' ? 'Creating link…' : 'Copy link'}
              </button>
              {user && (
                <>
                  <span aria-hidden className="h-4 w-px bg-slate-600" />
                  <button
                    onClick={openQuoteForm}
                    className="rounded px-2 py-1 font-medium transition-colors hover:bg-slate-700 hover:text-amber-300"
                  >
                    <span aria-hidden>💬</span> Comment
                  </button>
                </>
              )}
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
