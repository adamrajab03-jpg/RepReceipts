import {
  useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback,
  type ReactNode, type MouseEvent as ReactMouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useParams, Link } from 'react-router-dom'
import {
  useReview, useApplySpeaker, useOverrideTurn, useAcceptAll, useSetStatus,
  useSplitTurn, useMergeTurn, useInsertTurn,
  useEditTurnText, useReviewTurnText, useAcceptCleanup, useRejectCleanup, useRestoreCleanup, useOverrideCleanup,
  type SpeakerDecision, type TurnDecision, type SplitPayload,
} from '../hooks/useAdmin'
import type { ReviewTurn, RosterMember, CleanupEdit, AppliedEdit } from '../types/api'
import { makeSpeakerColors } from '../utils/speakerColors'
import { tierBadge } from '../utils/hearingTier'
import { cn } from '../utils/cn'

// ── Decisions ────────────────────────────────────────────────────────────────
type BareDecision =
  | { decision: 'member'; member_id: string }
  | { decision: 'witness'; witness_name: string }
  | { decision: 'unknown' }
  | { decision: 'reset' }

type TurnEditorDecision = { target_speaker_key: string } | BareDecision

/** One speaker bucket, for pickers ("Speaker 2 · Andy Kim"). */
interface BucketInfo {
  key: string
  ordinal: number
  name: string | null
  memberId: string | null
  role: string | null
  count: number
}

function fmtMs(ms: number | null) {
  if (ms == null) return ''
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function confPct(c: number) { return `${Math.round(c * 100)}%` }
function confColor(c: number) { return c >= 0.85 ? 'text-green-700' : c >= 0.6 ? 'text-amber-700' : 'text-red-600' }

const ordinalLabel = (n: number) => `Speaker ${n}`

// ── Shared assign control (roster typeahead + witness + unknown [+ reset]) ────
function MiniAssign({ roster, onDecision, allowReset }: {
  roster: RosterMember[]
  onDecision: (d: BareDecision) => void
  allowReset?: boolean
}) {
  const [q, setQ] = useState('')
  const [witness, setWitness] = useState('')
  const matches = useMemo(() => {
    const n = q.trim().toLowerCase()
    const list = n ? roster.filter(m => m.full_name.toLowerCase().includes(n) || (m.state ?? '').toLowerCase().includes(n)) : roster
    return list.slice(0, 6)
  }, [q, roster])

  return (
    <div className="space-y-2">
      <input
        value={q} onChange={e => setQ(e.target.value)} autoFocus
        placeholder="Search roster by name or state…"
        className="w-full text-sm px-2.5 py-1.5 rounded-md border border-gray-300 focus:outline-none focus:ring-2 focus:ring-slate-400"
      />
      <div className="max-h-44 overflow-auto rounded-md border border-gray-100 divide-y divide-gray-50 bg-white">
        {matches.map(m => (
          <button key={m.id} onClick={() => onDecision({ decision: 'member', member_id: m.id })}
            className="w-full text-left px-2.5 py-1.5 text-sm hover:bg-slate-50 flex items-center gap-2">
            <span className="font-medium text-slate-800">{m.full_name}</span>
            <span className="text-xs text-gray-500">{m.party ?? ''}{m.state ? `-${m.state}` : ''}</span>
            {m.role === 'chair' && <span className="text-xs text-slate-500">· chair</span>}
            {m.role === 'ranking_member' && <span className="text-xs text-slate-500">· ranking</span>}
          </button>
        ))}
        {!matches.length && <div className="px-2.5 py-2 text-xs text-gray-400">No matches</div>}
      </div>
      <div className="flex items-center gap-2">
        <input
          value={witness} onChange={e => setWitness(e.target.value)} placeholder="…or witness name"
          className="flex-1 text-sm px-2.5 py-1.5 rounded-md border border-gray-300 focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
        <button
          onClick={() => witness.trim() && onDecision({ decision: 'witness', witness_name: witness.trim() })}
          disabled={!witness.trim()}
          className="text-sm px-2.5 py-1.5 rounded-md bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-50"
        >Witness</button>
      </div>
      <div className="flex items-center gap-3 text-sm">
        <button onClick={() => onDecision({ decision: 'unknown' })} className="text-gray-500 hover:text-gray-700 underline">Mark unknown</button>
        {allowReset && <button onClick={() => onDecision({ decision: 'reset' })} className="text-blue-600 hover:text-blue-800 underline">Reset to original speaker</button>}
      </div>
    </div>
  )
}

// ── Per-turn editor: buckets first, then the full assign control ─────────────
function TurnAssign({ turn, buckets, roster, onDecision }: {
  turn: ReviewTurn
  buckets: BucketInfo[]
  roster: RosterMember[]
  onDecision: (d: TurnEditorDecision) => void
}) {
  const others = buckets.filter(b => b.key !== turn.speaker_key)
  return (
    <div className="mt-2 rounded-lg border-2 border-amber-400 bg-amber-50/60 p-2 space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">This turn only</p>
      {others.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-white divide-y divide-gray-50 max-h-36 overflow-auto">
          {others.map(b => (
            <button key={b.key} onClick={() => onDecision({ target_speaker_key: b.key })}
              className="w-full text-left px-2.5 py-1.5 text-sm hover:bg-amber-50 flex items-center gap-2">
              <span className="font-mono text-xs text-slate-500">{ordinalLabel(b.ordinal)}</span>
              <span className="font-medium text-slate-800">{b.name ?? 'unidentified'}</span>
              <span className="ml-auto text-xs text-gray-400">{b.count} turns</span>
            </button>
          ))}
        </div>
      )}
      <MiniAssign
        roster={roster}
        allowReset={turn.pinned && turn.speaker_label_raw != null}
        onDecision={onDecision}
      />
    </div>
  )
}

// ── Split mode: click the word the second half should start with ─────────────
function SplitMode({ turn, buckets, roster, busy, onSplit, onCancel }: {
  turn: ReviewTurn
  buckets: BucketInfo[]
  roster: RosterMember[]
  busy: boolean
  onSplit: (payload: { word_index: number; assign: SplitPayload['assign'] }) => void
  onCancel: () => void
}) {
  const [cut, setCut] = useState<number | null>(null)
  const words = turn.word_times ?? []

  // Resolve an identity choice for half B to a split assign: join the bucket
  // that already has this exact identity, else create a new speaker bucket.
  const assignFor = (d: TurnEditorDecision): SplitPayload['assign'] | null => {
    if ('target_speaker_key' in d) return { mode: 'existing', speaker_key: d.target_speaker_key }
    if (d.decision === 'reset') return null
    if (d.decision === 'member') {
      const b = buckets.find(x => x.memberId === d.member_id)
      return b ? { mode: 'existing', speaker_key: b.key } : { mode: 'new', decision: 'member', member_id: d.member_id }
    }
    if (d.decision === 'witness') {
      const b = buckets.find(x => x.role === 'witness' && x.name === d.witness_name)
      return b ? { mode: 'existing', speaker_key: b.key } : { mode: 'new', decision: 'witness', witness_name: d.witness_name }
    }
    return { mode: 'new', decision: 'unknown' }
  }

  return (
    <div className="mt-2 rounded-lg border-2 border-sky-400 bg-sky-50/50 p-2 space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-700">
          Split — click the word the new turn should start with
        </p>
        <button onClick={onCancel} className="ml-auto text-xs text-gray-500 hover:text-gray-700 underline">cancel</button>
      </div>
      <p className="text-sm leading-relaxed text-gray-800">
        {words.map((wt, i) => (
          <span key={i}>
            {i > 0 && ' '}
            <button
              onClick={() => i > 0 && setCut(i)}
              disabled={i === 0}
              className={cn(
                'rounded-sm px-0',
                i === 0 && 'cursor-default',
                i > 0 && 'hover:bg-sky-200 hover:shadow-[inset_2px_0_0_0_#0369a1] cursor-pointer',
                cut !== null && i >= cut && 'bg-sky-100',
                cut === i && 'shadow-[inset_2px_0_0_0_#0369a1] font-medium',
              )}
            >{wt.w}</button>
          </span>
        ))}
      </p>
      {cut !== null && (
        <div className="rounded-md border border-sky-200 bg-white p-2 space-y-2">
          <p className="text-xs text-gray-600">
            …{words.slice(Math.max(0, cut - 4), cut).map(w => w.w).join(' ')}
            <span className="mx-1.5 font-bold text-sky-700">‖</span>
            {words.slice(cut, cut + 4).map(w => w.w).join(' ')}…
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => onSplit({ word_index: cut, assign: { mode: 'inherit' } })} disabled={busy}
              className="text-sm font-medium px-3 py-1.5 rounded-lg bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-50">
              Split — same speaker
            </button>
            <span className="text-xs text-gray-500">or assign the new turn to:</span>
          </div>
          <TurnAssign
            turn={turn} buckets={buckets} roster={roster}
            onDecision={(d) => { const a = assignFor(d); if (a) onSplit({ word_index: cut, assign: a }) }}
          />
        </div>
      )}
    </div>
  )
}

// ── Speaker header (rendered at each bucket's first turn) ────────────────────
interface SpeakerInfo {
  count: number
  firstTurnId: string
  ordinal: number
  pending: boolean
  suggestion: ReviewTurn['suggestion']
  appliedName: string | null
  memberId: string | null
  role: string | null
}

function SpeakerHeader({ info, roster, busy, onSpeaker }: {
  info: SpeakerInfo
  roster: RosterMember[]
  busy: boolean
  onSpeaker: (d: Exclude<BareDecision, { decision: 'reset' }>) => void
}) {
  const [open, setOpen] = useState(false)
  const sug = info.suggestion?.suggested_identity
  const label = ordinalLabel(info.ordinal)

  const editor = open && (
    <div className="w-full mt-2 rounded-lg border-2 border-slate-500 bg-slate-50 p-2 space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">
          Applies to all {info.count} turns of {label}
        </p>
        <button onClick={() => setOpen(false)} className="ml-auto text-xs text-gray-500 hover:text-gray-700 underline">cancel</button>
      </div>
      <MiniAssign roster={roster} onDecision={(d) => { if (d.decision !== 'reset') { onSpeaker(d); setOpen(false) } }} />
    </div>
  )

  if (!info.pending) {
    // Reviewed: compact confirmation. The NAME is the edit affordance.
    return (
      <div className="mt-4 mb-1 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono font-semibold text-slate-700">{label}</span>
        <span className="text-green-700">
          ✓ attributed as{' '}
          <button onClick={() => setOpen(v => !v)} disabled={busy}
            title={`Edit all ${info.count} turns of ${label}`}
            className="font-medium underline decoration-dotted underline-offset-2 hover:text-green-900 hover:decoration-solid">
            {info.appliedName ?? 'Unknown'} ✎
          </button>
        </span>
        <span className="text-gray-400">· {info.count} turns</span>
        {editor}
      </div>
    )
  }

  // Pending: Claude's suggestion + reasoning, right where the bucket first appears.
  const acceptDecision: Exclude<BareDecision, { decision: 'reset' }> | null =
    !sug ? null
    : sug.type === 'member' && sug.member_id ? { decision: 'member', member_id: sug.member_id }
    : sug.type === 'witness' && sug.display_name ? { decision: 'witness', witness_name: sug.display_name }
    : { decision: 'unknown' }
  const sugName = sug?.type === 'unknown' ? 'Unknown' : (sug?.display_name ?? '—')

  return (
    <div className="mt-4 mb-1 rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 p-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-mono font-semibold text-slate-800">{label}</span>
        <span className="text-xs text-gray-400">first appears · {info.count} turns</span>
      </div>
      {sug ? (
        <>
          <div className="mt-1 text-sm">
            <span className="text-gray-500">Claude suggests </span>
            <span className="font-semibold text-slate-800">{sugName}</span>
            <span className="text-xs text-gray-400"> ({sug!.type})</span>
            <span className={cn('ml-2 text-xs font-semibold tabular-nums', confColor(info.suggestion!.confidence))}>{confPct(info.suggestion!.confidence)}</span>
          </div>
          <p className="mt-1 text-sm text-slate-600 bg-white border-l-2 border-slate-300 pl-3 py-1 rounded-r">{info.suggestion!.reasoning}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {acceptDecision && (
              <button onClick={() => onSpeaker(acceptDecision)} disabled={busy}
                className="text-sm font-medium px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-500 disabled:opacity-50">
                Attribute all {info.count} turns to {sugName}
              </button>
            )}
            <button onClick={() => setOpen(v => !v)} disabled={busy}
              className="text-sm font-medium px-3 py-1.5 rounded-lg border border-gray-300 text-slate-700 hover:bg-white disabled:opacity-50">
              {open ? 'Cancel' : 'Override'}
            </button>
          </div>
        </>
      ) : (
        <div className="mt-1 flex items-center gap-2 text-sm text-gray-500">
          No suggestion — attribute manually.
          <button onClick={() => setOpen(v => !v)} className="underline text-slate-700">{open ? 'Cancel' : 'Assign'}</button>
        </div>
      )}
      {editor}
    </div>
  )
}

// ── Two-color hoverable diff ──────────────────────────────────────────────────
// Applied edits show the CLEANED text (emerald = accepted LLM, violet = human);
// still-proposed LLM edits show the ORIGINAL raw span marked up with inline
// accept/reject; validator-`rejected` edits are shown flagged (red, no accept),
// never silently dropped. Applied edits hover to a styled card with the original
// raw text (see EditHoverCard); proposals keep the compact native tip since the
// span they mark up already IS the original.
// Full literal class strings so Tailwind keeps them.
const EDIT_STYLE = {
  llm: 'bg-emerald-100 text-emerald-900',
  human: 'bg-violet-100 text-violet-900',
  mechanical: 'bg-sky-50 text-sky-900 decoration-sky-500',
  filler: 'bg-sky-50 text-sky-900 decoration-sky-500',
  false_start: 'bg-sky-50 text-sky-900 decoration-sky-500',
  transcription_error: 'bg-amber-50 text-amber-900 decoration-amber-500',
  rejected: 'bg-red-50 text-red-800 decoration-red-400',
} as const

// ── Hover card: review one edit without leaving the transcript ────────────────
// Replaces the native `title` tooltip on EVERY marked span — instant instead of
// the ~1s OS delay, readable width, and tinted to match the span it belongs to:
//
//   applied edit     → the ORIGINAL raw text behind the cleaned reading
//                      (emerald = accepted LLM cleanup, violet = human edit)
//   pending proposal → ORIGINAL vs PROPOSED side by side + the validator class,
//                      with accept / remove-suggestion actions in the card
//                      (sky = auto-safe, amber = ASR fix, red = blocked)
//
// Portalled to <body> as a fixed element so the transcript container can never
// clip it. The proposal card is INTERACTIVE, so dismissal is delayed by
// HOVER_CLOSE_MS and cancelled while the pointer is over the card — the cursor
// can cross the gap from span to button without the card vanishing.
//
// v1 shows the edited span only. Surrounding-sentence context would slot in
// under the compare block — an extra field on HoverTarget, no caller changes.
type HoverTarget =
  | { kind: 'applied'; e: AppliedEdit }
  | { kind: 'proposal'; e: CleanupEdit }

interface HoverCard {
  /** Viewport rect of the hovered span, measured on mouseenter. */
  rect: DOMRect
  target: HoverTarget
}

const TINT_SKY = { card: 'border-sky-300 bg-sky-50', label: 'text-sky-800', tag: 'text-sky-600', bar: 'border-sky-300' }
const CARD_TINT: Record<AppliedEdit['source'] | CleanupEdit['class'], typeof TINT_SKY> = {
  llm: { card: 'border-emerald-300 bg-emerald-50', label: 'text-emerald-800', tag: 'text-emerald-600', bar: 'border-emerald-300' },
  human: { card: 'border-violet-300 bg-violet-50', label: 'text-violet-800', tag: 'text-violet-600', bar: 'border-violet-300' },
  mechanical: TINT_SKY,
  filler: TINT_SKY,
  false_start: TINT_SKY,
  transcription_error: { card: 'border-amber-300 bg-amber-50', label: 'text-amber-800', tag: 'text-amber-600', bar: 'border-amber-300' },
  rejected: { card: 'border-red-300 bg-red-50', label: 'text-red-800', tag: 'text-red-600', bar: 'border-red-300' },
}

// What the validator's class means, in the reviewer's language.
const CLASS_GLOSS: Record<CleanupEdit['class'], string> = {
  mechanical: 'Punctuation, capitalization or whitespace only — no word changed.',
  filler: 'Removes a filler word (um, uh…). No content word changed.',
  false_start: 'Removes a verbatim repeat (stutter / self-repair).',
  transcription_error: 'Swaps one content word — a plausible ASR mishearing. Your call.',
  rejected: 'Blocked by the validator — this suggestion cannot be accepted.',
}

// Each TurnBody owns its own hover state, but only ONE card may be open across
// the transcript: opening one dismisses whatever else is still lingering inside
// its close delay, so sweeping between turns never stacks two cards.
let dismissOpenCard: (() => void) | null = null

const CARD_W = 320       // applied edit: enough for a phrase-length original
const CARD_W_WIDE = 400  // proposal: two readable columns side by side
const CARD_GAP = 8       // space between the span and the card
const EDGE = 8           // min distance from any viewport edge
const HOVER_CLOSE_MS = 220 // grace period to cross from the span onto the card

function EditHoverCard({ card, busy, onAccept, onReject, onOverride, onHold, onRelease, onClose }: {
  card: HoverCard
  busy: boolean
  onAccept: (editId: string) => void
  onReject: (editId: string) => void
  /** Apply a blocked suggestion's text as the admin's own human edit. */
  onOverride: (editId: string) => void
  /** Pointer entered the card — cancel the pending close. */
  onHold: () => void
  /** Pointer left the card — schedule the close. */
  onRelease: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const { target } = card
  const proposal = target.kind === 'proposal' ? target.e : null
  // The validator's own verdict is the only gate: `rejected` can never be applied.
  const blocked = proposal?.class === 'rejected'
  const tint = CARD_TINT[target.kind === 'applied' ? target.e.source : target.e.class] ?? TINT_SKY
  const width = Math.min(proposal ? CARD_W_WIDE : CARD_W, window.innerWidth - EDGE * 2)

  // Measure first, then place: sit above the span, flip below when the card
  // would clip the top, and clamp sideways so spans near either edge stay whole.
  // useLayoutEffect runs before paint, so the pre-measure position never shows.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const h = el.offsetHeight
    const { innerWidth: vw, innerHeight: vh } = window
    const fitsAbove = card.rect.top - h - CARD_GAP >= EDGE
    const top = fitsAbove ? card.rect.top - h - CARD_GAP : Math.min(card.rect.bottom + CARD_GAP, vh - h - EDGE)
    const left = Math.min(card.rect.left + card.rect.width / 2 - width / 2, vw - width - EDGE)
    setPos({ top: Math.max(EDGE, top), left: Math.max(EDGE, left) })
  }, [card, width])

  // Fixed positioning would drift away from the span, so any scroll dismisses.
  useEffect(() => {
    window.addEventListener('scroll', onClose, true)
    return () => window.removeEventListener('scroll', onClose, true)
  }, [onClose])

  const boxCls = 'mt-0.5 rounded border bg-white px-1.5 py-1 text-sm leading-snug text-slate-800 whitespace-pre-wrap break-words'
  const capCls = 'text-[10px] font-semibold uppercase tracking-wide'

  return createPortal(
    <div
      ref={ref} role={proposal ? 'group' : 'tooltip'}
      onMouseEnter={onHold} onMouseLeave={onRelease}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, width, visibility: pos ? 'visible' : 'hidden' }}
      className={cn('fixed z-50 rounded-lg border shadow-lg p-2.5', tint.card, !proposal && 'pointer-events-none')}
    >
      {proposal ? (
        <>
          <div className="flex items-baseline gap-2">
            <span className={cn(capCls, tint.label)}>{blocked ? 'Blocked suggestion' : 'Pending suggestion'}</span>
            <span className={cn('ml-auto font-mono text-[10px]', tint.tag)}>{proposal.class}</span>
          </div>

          {/* Original vs proposed, side by side — the comparison IS the review. */}
          <div className="mt-1.5 grid grid-cols-2 gap-2">
            <div className="min-w-0">
              <p className={cn(capCls, 'text-gray-500')}>Original</p>
              <p className={cn(boxCls, 'border-gray-200')}>
                {proposal.original || <span className="italic text-gray-400">(empty)</span>}
              </p>
            </div>
            <div className="min-w-0">
              <p className={cn(capCls, tint.label)}>Proposed</p>
              <p className={cn(boxCls, tint.bar)}>
                {proposal.replacement || <span className="italic text-gray-400">(deleted)</span>}
              </p>
            </div>
          </div>

          <p className={cn('mt-1.5 text-[11px] leading-snug', blocked ? 'text-red-700' : 'text-gray-600')}>
            {blocked && proposal.reject_reason ? proposal.reject_reason : CLASS_GLOSS[proposal.class]}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={() => { onClose(); onAccept(proposal.id) }}
              disabled={busy || blocked}
              title={blocked ? 'The validator blocked this edit — it cannot be accepted' : 'Apply this edit to the cleaned reading'}
              className="px-2 py-1 rounded text-[11px] font-medium bg-green-600 text-white hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed"
            >✓ Accept</button>
            {blocked && (
              // The guardrail stays absolute — there is no "accept anyway", and
              // no path that records a blocked change as an AI cleanup. This
              // applies the same text as YOUR edit: violet, owned by you.
              <button
                onClick={() => { onClose(); onOverride(proposal.id) }}
                disabled={busy}
                title="Apply this replacement as your own human edit — recorded as an admin override of the validator block, never as an AI cleanup"
                className="px-2 py-1 rounded text-[11px] font-medium bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-40"
              >Apply as my edit</button>
            )}
            <button
              onClick={() => { onClose(); onReject(proposal.id) }}
              disabled={busy}
              title="Dismiss this suggestion — the text stays exactly as spoken, and you can restore it from the turn's dismissed list"
              className="px-2 py-1 rounded text-[11px] font-medium border border-gray-300 bg-white text-slate-600 hover:bg-gray-50 hover:text-red-700 disabled:opacity-40"
            >Remove suggestion</button>
            {!blocked && <span className="ml-auto text-[10px] text-gray-400">recoverable</span>}
          </div>
        </>
      ) : target.kind === 'applied' && (
        <>
          <div className="flex items-baseline gap-2">
            <span className={cn(capCls, tint.label)}>{target.e.replacement ? 'Original:' : 'Removed:'}</span>
            <span className={cn('ml-auto text-[10px]', tint.tag)}>
              {target.e.source === 'human' ? (target.e.override ? 'human override' : 'manual edit') : 'LLM cleanup'}
            </span>
          </div>
          <p className={cn('mt-1 rounded-r border-l-2 bg-white/80 py-1 pl-2 pr-1 text-sm leading-snug text-slate-800 whitespace-pre-wrap break-words', tint.bar)}>
            {target.e.original || <span className="italic text-gray-400">(nothing — this text was inserted)</span>}
          </p>
          {/* An override of a validator block is stated plainly — the human made
              this call against the guardrail, and the record says so. */}
          {target.e.override ? (
            <p className="mt-1.5 text-[10px] leading-snug text-violet-700">
              Human override of a blocked edit
              {target.e.override.blocked_reason ? <>: <span className="text-violet-600">{target.e.override.blocked_reason}</span></> : null}
            </p>
          ) : null}
          {/* A manual edit written over accepted cleanup keeps that origin visible. */}
          {target.e.supersedes?.length ? (
            <p className="mt-1.5 text-[10px] leading-snug text-gray-500">
              Written over an accepted LLM {target.e.supersedes[0].class ?? 'cleanup'} edit:{' '}
              <span className="text-gray-600">“{target.e.supersedes[0].original}” → “{target.e.supersedes[0].replacement}”</span>
              {target.e.supersedes.length > 1 && ` (+${target.e.supersedes.length - 1} more)`}
            </p>
          ) : null}
        </>
      )}
    </div>,
    document.body,
  )
}

function TurnBody({ turn, busy, onAccept, onReject, onOverride }: {
  turn: ReviewTurn
  busy: boolean
  onAccept: (editId: string) => void
  onReject: (editId: string) => void
  onOverride: (editId: string) => void
}) {
  const raw = turn.raw_text
  const applied: AppliedEdit[] = turn.text_edits ?? []
  const proposals: CleanupEdit[] = (turn.cleanup?.edits ?? []).filter(e => e.status === 'proposed')
  const seam = turn.structural?.op === 'merge' ? turn.structural : null

  // One card at a time — only one span can be hovered. Opens with no delay;
  // closing is deferred so the pointer can travel onto the card's buttons.
  const [hover, setHover] = useState<HoverCard | null>(null)
  const closeTimer = useRef<number | null>(null)
  const holdCard = useCallback(() => {
    if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null }
  }, [])
  const closeCard = useCallback(() => { holdCard(); setHover(null) }, [holdCard])
  const releaseCard = useCallback(() => {
    holdCard()
    closeTimer.current = window.setTimeout(() => setHover(null), HOVER_CLOSE_MS)
  }, [holdCard])
  useEffect(() => holdCard, [holdCard]) // never leave a timer running past unmount

  // Attached to every marked span — applied edits AND pending proposals, so no
  // marker is ever hoverable-looking but card-less.
  const cardProps = (target: HoverTarget, label: string) => ({
    onMouseEnter: (ev: ReactMouseEvent<HTMLElement>) => {
      dismissOpenCard?.()          // no-op when the open card is already ours
      dismissOpenCard = closeCard
      holdCard()
      setHover({ rect: ev.currentTarget.getBoundingClientRect(), target })
    },
    onMouseLeave: releaseCard,
    // The card is mouse-only, so keep the detail reachable for screen readers.
    'aria-label': label,
  })

  // No text layer → keep the existing seam / plain rendering.
  if (!applied.length && !proposals.length) {
    if (seam && seam.seam_offset != null && seam.seam_offset > 0 && seam.seam_offset < raw.length) {
      return (
        <>
          {raw.slice(0, seam.seam_offset)}
          <span
            title={`Merged ${seam.absorbed_side === 'before' ? 'start' : 'end'}: absorbed from ${seam.absorbed_name ?? seam.absorbed_key ?? 'deleted turn'}`}
            className={cn('mx-0.5 select-none font-bold', seam.absorbed_distinct ? 'text-amber-600' : 'text-gray-300')}
          >⌇</span>
          {raw.slice(seam.seam_offset)}
        </>
      )
    }
    return <>{raw || <span className="italic text-gray-400">empty turn — add text with ✎, or delete-merge it</span>}</>
  }

  type Marker =
    | { start: number; end: number; kind: 'applied'; e: AppliedEdit }
    | { start: number; end: number; kind: 'proposal'; e: CleanupEdit }
  const markers: Marker[] = applied.map(e => ({ start: e.raw_start, end: e.raw_end, kind: 'applied' as const, e }))
  for (const p of proposals) {
    if (markers.some(m => p.raw_start < m.end && m.start < p.raw_end)) continue // overlaps an applied edit → skip
    markers.push({ start: p.raw_start, end: p.raw_end, kind: 'proposal', e: p })
  }
  markers.sort((a, b) => a.start - b.start || a.end - b.end)
  const kept: Marker[] = []
  let lastEnd = -1
  for (const m of markers) { if (m.start >= lastEnd) { kept.push(m); lastEnd = m.end } }

  const nodes: ReactNode[] = []
  let cursor = 0
  kept.forEach((m, i) => {
    if (m.start > cursor) nodes.push(<span key={`t${i}`}>{raw.slice(cursor, m.start)}</span>)
    if (m.kind === 'applied') {
      const e = m.e
      const label = `${e.replacement ? 'edited' : 'removed'} — original: ${e.original}`
      nodes.push(
        e.replacement
          ? <span key={`a${i}`} {...cardProps({ kind: 'applied', e }, label)}
              className={cn('rounded-sm px-0.5 underline decoration-dotted underline-offset-2 cursor-help', EDIT_STYLE[e.source])}>{e.replacement}</span>
          : <span key={`a${i}`} {...cardProps({ kind: 'applied', e }, label)}
              className={cn('px-0.5 font-bold cursor-help', e.source === 'human' ? 'text-violet-500' : 'text-emerald-500')}>·</span>
      )
    } else {
      const e = m.e
      const rejected = e.class === 'rejected'
      const label = `${rejected ? 'blocked' : 'suggested'} ${e.class}: "${e.original}" → "${e.replacement || 'delete'}"`
      nodes.push(
        <span key={`p${i}`} className="inline-flex items-baseline gap-0.5">
          <span {...cardProps({ kind: 'proposal', e }, label)}
            className={cn('rounded-sm px-0.5 underline decoration-dotted underline-offset-2 cursor-help',
              EDIT_STYLE[e.class], !e.replacement && !rejected && 'line-through')}>
            {e.original || '∅'}
          </span>
          {!rejected && (
            <button onClick={() => onAccept(e.id)} disabled={busy} title="Accept this edit"
              className="px-0.5 text-[11px] leading-none text-green-700 hover:text-green-900 disabled:opacity-40">✓</button>
          )}
          <button onClick={() => onReject(e.id)} disabled={busy}
            title={rejected ? 'Dismiss this blocked suggestion (recoverable)' : 'Dismiss this suggestion (recoverable)'}
            className="px-0.5 text-[11px] leading-none text-red-600 hover:text-red-800 disabled:opacity-40">✗</button>
        </span>
      )
    }
    cursor = m.end
  })
  if (cursor < raw.length) nodes.push(<span key="tail">{raw.slice(cursor)}</span>)
  return <>{nodes}{hover && (
    <EditHoverCard
      card={hover} busy={busy}
      onAccept={onAccept} onReject={onReject} onOverride={onOverride}
      onHold={holdCard} onRelease={releaseCard} onClose={closeCard}
    />
  )}</>
}

// ── One transcript turn ───────────────────────────────────────────────────────
type Panel = 'name' | 'split' | 'merge' | 'insert' | null

function TurnRow({ turn, colorCls, roster, buckets, busy, prev, next, autoOpen, onTurn, onSplit, onMerge, onInsert, onEditText, onAcceptEdit, onRejectEdit, onRestoreEdit, onOverrideEdit, onAcceptAllSafe, onDismissAllPending, onMarkReviewed }: {
  turn: ReviewTurn
  colorCls: string
  roster: RosterMember[]
  buckets: BucketInfo[]
  busy: boolean
  prev: { name: string; key: string } | null
  next: { name: string; key: string } | null
  autoOpen: boolean
  onTurn: (d: TurnEditorDecision) => void
  onSplit: (p: { word_index: number; assign: SplitPayload['assign'] }) => void
  onMerge: (direction: 'up' | 'down') => void
  onInsert: (position: 'before' | 'after') => void
  onEditText: (text: string, base: string) => Promise<unknown>
  onAcceptEdit: (editId: string) => void
  onRejectEdit: (editId: string) => void
  onRestoreEdit: (editId: string) => void
  onOverrideEdit: (editId: string) => void
  onAcceptAllSafe: () => void
  onDismissAllPending: () => void
  onMarkReviewed: () => void
}) {
  const [panel, setPanel] = useState<Panel>(autoOpen ? 'name' : null)
  const [showDismissed, setShowDismissed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pending = turn.attribution_status === 'unverified'
  const sug = turn.suggestion?.suggested_identity
  const resolved = turn.member_full_name ?? turn.speaker_name
  const pendingName = sug?.type === 'unknown' ? 'Unknown' : (sug?.display_name ?? ordinalLabel(turn.speaker_ordinal))
  const canSplit = (turn.word_times?.length ?? 0) >= 2

  const toggle = (p: Panel) => setPanel(cur => (cur === p ? null : p))
  const nameBtnCls = 'underline decoration-dotted underline-offset-2 hover:decoration-solid'

  // Text editing: prefilled with the current cleaned reading; on save the server
  // diffs the submitted text against the immutable raw_text. We read the LIVE
  // textarea value at save time (never a stale closure), send it unconditionally
  // (no equality guard), and keep the editor open + show the error on failure so
  // the edit is never silently lost.
  const currentText = turn.clean_text ?? turn.raw_text
  const dirty = draft !== currentText
  const startEdit = () => { setDraft(currentText); setSaveErr(null); setPanel(null); setEditing(true) }
  const save = async () => {
    const value = textareaRef.current?.value ?? draft
    setSaveErr(null); setSaving(true)
    // The base we opened on goes with the change, so the server composes onto
    // the right stack (and 409s if someone accepted an edit meanwhile).
    try { await onEditText(value, currentText); setEditing(false) }
    catch (e) { setSaveErr(e instanceof Error ? e.message : 'Save failed') }
    finally { setSaving(false) }
  }


  const proposed = (turn.cleanup?.edits ?? []).filter(e => e.status === 'proposed')
  const safeCount = proposed.filter(e => e.class === 'mechanical' || e.class === 'filler' || e.class === 'false_start').length
  const transCount = proposed.filter(e => e.class === 'transcription_error').length
  // class 'rejected' = the VALIDATOR blocked it (still pending, never acceptable).
  // status 'rejected' = a human dismissed it (recoverable). Different axes.
  const blockedCount = proposed.filter(e => e.class === 'rejected').length
  const dismissed = (turn.cleanup?.edits ?? []).filter(e => e.status === 'rejected')

  return (
    <div className={cn('group border-l-4 pl-3 pr-2 py-2.5', colorCls, turn.pinned && 'ring-1 ring-inset ring-amber-400/70 rounded-r')}>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-gray-400 font-mono tabular-nums w-10 shrink-0">{fmtMs(turn.start_ms)}</span>

        {pending ? (
          <span className="flex items-center gap-1.5">
            <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[11px]">pending</span>
            <button onClick={() => toggle('name')} disabled={busy}
              title="Reassign this turn only"
              className={cn('font-medium text-slate-700', nameBtnCls)}>{pendingName}</button>
            {turn.suggestion && <span className={cn('tabular-nums', confColor(turn.suggestion.confidence))}>{confPct(turn.suggestion.confidence)}</span>}
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <button onClick={() => toggle('name')} disabled={busy}
              title="Reassign this turn only"
              className={cn('font-semibold text-slate-800', nameBtnCls)}>{resolved ?? 'Unknown speaker'}</button>
            {turn.pinned && <span className="px-1.5 py-0.5 rounded bg-amber-500 text-white text-[11px] font-medium">⟳ moved</span>}
          </span>
        )}

        <span className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <button onClick={startEdit} disabled={busy}
            title="Edit this turn's text (raw_text stays canonical)"
            className="px-1.5 py-0.5 rounded text-slate-500 hover:text-violet-700 hover:bg-violet-50 disabled:opacity-30">✎</button>
          <button onClick={() => canSplit && toggle('split')} disabled={busy || !canSplit}
            title={canSplit ? 'Split this turn at a word' : 'No word timing — cannot split'}
            className="px-1.5 py-0.5 rounded text-slate-500 hover:text-sky-700 hover:bg-sky-50 disabled:opacity-30">✂</button>
          <button onClick={() => toggle('merge')} disabled={busy || (!prev && !next)}
            title="Delete this turn — its words merge into a neighbor"
            className="px-1.5 py-0.5 rounded text-slate-500 hover:text-red-700 hover:bg-red-50 disabled:opacity-30">⌫</button>
          <button onClick={() => toggle('insert')} disabled={busy}
            title="Insert a blank turn before/after"
            className="px-1.5 py-0.5 rounded text-slate-500 hover:text-emerald-700 hover:bg-emerald-50">+</button>
        </span>
      </div>

      {editing ? (
        <div className="mt-1">
          <textarea
            ref={textareaRef}
            autoFocus value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (dirty) void save() }
              if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
            }}
            rows={Math.min(8, Math.max(2, Math.ceil((draft.length + 1) / 80)))}
            className="w-full text-sm p-2 rounded-md border border-violet-300 focus:outline-none focus:ring-2 focus:ring-violet-400"
          />
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
            <button onClick={() => void save()} disabled={!dirty || saving}
              className="px-2 py-1 rounded bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setDraft(turn.raw_text)} disabled={saving}
              className="text-gray-500 hover:text-gray-700 underline disabled:opacity-50">Reset to raw</button>
            <button onClick={() => setEditing(false)} disabled={saving}
              className="text-gray-500 hover:text-gray-700 underline disabled:opacity-50">Cancel</button>
            {dirty && !saving && <span className="text-violet-600">● unsaved changes</span>}
            {saveErr
              ? <span className="text-red-600">Save failed: {saveErr}</span>
              : <span className="text-gray-400">raw_text is preserved — every edit is reversible</span>}
          </div>
        </div>
      ) : (
        <>
          <p className="mt-1 text-sm text-gray-700 leading-relaxed">
            <TurnBody turn={turn} busy={busy} onAccept={onAcceptEdit} onReject={onRejectEdit} onOverride={onOverrideEdit} />
          </p>
          {(proposed.length > 0 || dismissed.length > 0 || !turn.text_reviewed) && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
              {safeCount > 0 && (
                <button onClick={onAcceptAllSafe} disabled={busy}
                  className="px-1.5 py-0.5 rounded bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-50">
                  Accept {safeCount} safe edit{safeCount > 1 ? 's' : ''}
                </button>
              )}
              {proposed.length > 0 && (
                <button onClick={onDismissAllPending} disabled={busy}
                  title="Clear this turn's remaining suggestions — recoverable below; accepted edits are untouched"
                  className="px-1.5 py-0.5 rounded border border-gray-300 bg-white text-slate-600 hover:bg-gray-50 hover:text-red-700 disabled:opacity-50">
                  Remove all remaining ({proposed.length})
                </button>
              )}
              {(safeCount + transCount) > 0 && (
                <span className="text-gray-500">
                  {safeCount + transCount} proposed{transCount ? ` (${transCount} ASR-fix — needs your call)` : ''}
                </span>
              )}
              {blockedCount > 0 && <span className="text-red-600">{blockedCount} blocked by validator</span>}
              {dismissed.length > 0 && (
                <button onClick={() => setShowDismissed(v => !v)}
                  title="Dismissed suggestions are kept, not deleted — you can put any of them back"
                  className="text-gray-500 hover:text-gray-700 underline">
                  {dismissed.length} dismissed · {showDismissed ? 'hide' : 'show'}
                </button>
              )}
              {!turn.text_reviewed
                ? <button onClick={onMarkReviewed} disabled={busy} className="ml-auto text-slate-500 hover:text-slate-700 underline">Mark reviewed</button>
                : <span className="ml-auto text-green-600">✓ text reviewed</span>}
            </div>
          )}

          {/* Dismissed ≠ deleted: every one of these can go back in the queue. */}
          {showDismissed && dismissed.length > 0 && (
            <div className="mt-1 rounded-md border border-gray-200 bg-gray-50 divide-y divide-gray-100">
              {dismissed.map(e => (
                <div key={e.id} className="flex flex-wrap items-baseline gap-1.5 px-2 py-1 text-[11px]">
                  <span className={cn('font-mono', e.class === 'rejected' ? 'text-red-500' : 'text-gray-400')}>{e.class}</span>
                  <span className="text-gray-600 line-through decoration-gray-400">{e.original || '∅'}</span>
                  <span className="text-gray-400">→</span>
                  <span className="text-gray-700">{e.replacement || <span className="italic text-gray-400">(delete)</span>}</span>
                  <button onClick={() => onRestoreEdit(e.id)} disabled={busy}
                    title="Put this suggestion back in the pending queue"
                    className="ml-auto text-slate-600 hover:text-slate-900 underline disabled:opacity-50">Restore</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {panel === 'name' && (
        <TurnAssign turn={turn} buckets={buckets} roster={roster}
          onDecision={(d) => { onTurn(d); setPanel(null) }} />
      )}
      {panel === 'split' && (
        <SplitMode turn={turn} buckets={buckets} roster={roster} busy={busy}
          onSplit={(p) => { onSplit(p); setPanel(null) }} onCancel={() => setPanel(null)} />
      )}
      {panel === 'merge' && (
        <div className="mt-2 rounded-lg border-2 border-red-300 bg-red-50/50 p-2 space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-red-700">
            Delete this turn — its words are never lost, they merge into a neighbor
          </p>
          {prev && (
            <button onClick={() => { onMerge('up'); setPanel(null) }} disabled={busy}
              className="block w-full text-left text-sm px-2.5 py-1.5 rounded-md bg-white border border-red-200 hover:bg-red-50">
              ↑ Merge into previous — <span className="font-medium">{prev.name}</span>
              {prev.key !== turn.speaker_key && <span className="ml-2 text-xs text-amber-700">⚠ different speaker — a seam mark will show</span>}
            </button>
          )}
          {next && (
            <button onClick={() => { onMerge('down'); setPanel(null) }} disabled={busy}
              className="block w-full text-left text-sm px-2.5 py-1.5 rounded-md bg-white border border-red-200 hover:bg-red-50">
              ↓ Merge into next — <span className="font-medium">{next.name}</span>
              {next.key !== turn.speaker_key && <span className="ml-2 text-xs text-amber-700">⚠ different speaker — a seam mark will show</span>}
            </button>
          )}
          <button onClick={() => setPanel(null)} className="text-xs text-gray-500 hover:text-gray-700 underline">cancel</button>
        </div>
      )}
      {panel === 'insert' && (
        <div className="mt-2 rounded-lg border-2 border-emerald-300 bg-emerald-50/50 p-2 space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">Insert a blank turn (new speaker, empty text)</p>
          <div className="flex gap-2">
            <button onClick={() => { onInsert('before'); setPanel(null) }} disabled={busy}
              className="text-sm px-2.5 py-1.5 rounded-md bg-white border border-emerald-200 hover:bg-emerald-50">↑ before this turn</button>
            <button onClick={() => { onInsert('after'); setPanel(null) }} disabled={busy}
              className="text-sm px-2.5 py-1.5 rounded-md bg-white border border-emerald-200 hover:bg-emerald-50">↓ after this turn</button>
            <button onClick={() => setPanel(null)} className="text-xs text-gray-500 hover:text-gray-700 underline">cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Derived per-bucket info ───────────────────────────────────────────────────
function buildSpeakerInfo(turns: ReviewTurn[]): Map<string, SpeakerInfo> {
  const m = new Map<string, SpeakerInfo>()
  for (const t of turns) {
    const name = t.member_full_name ?? t.speaker_name ?? null
    const cur = m.get(t.speaker_key)
    if (!cur) {
      m.set(t.speaker_key, {
        count: 1, firstTurnId: t.id, ordinal: t.speaker_ordinal,
        pending: t.attribution_status === 'unverified',
        suggestion: t.pinned ? null : t.suggestion,
        appliedName: t.pinned ? null : name,
        memberId: t.pinned ? null : t.member_id,
        role: t.pinned ? null : t.speaker_role,
      })
    } else {
      cur.count += 1
      if (t.attribution_status === 'unverified') cur.pending = true
      // The bucket's identity/suggestion comes from HOME (non-moved) turns, so
      // a single-turn move can never relabel the whole speaker header.
      if (!t.pinned) {
        if (cur.appliedName == null && name) { cur.appliedName = name; cur.memberId = t.member_id; cur.role = t.speaker_role }
        if (cur.suggestion == null && t.suggestion) cur.suggestion = t.suggestion
      }
    }
  }
  return m
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ReviewWorkbenchPage() {
  const { id = '' } = useParams()
  const { data, isLoading, error } = useReview(id)
  const applySpeaker = useApplySpeaker(id)
  const overrideTurn = useOverrideTurn(id)
  const splitTurn = useSplitTurn(id)
  const mergeTurn = useMergeTurn(id)
  const insertTurn = useInsertTurn(id)
  const acceptAll = useAcceptAll(id)
  const setStatus = useSetStatus(id)
  const acceptCleanup = useAcceptCleanup(id)
  const rejectCleanup = useRejectCleanup(id)
  const restoreCleanup = useRestoreCleanup(id)
  const overrideCleanup = useOverrideCleanup(id)
  const editTurnText = useEditTurnText(id)
  const reviewTurnText = useReviewTurnText(id)

  const [notice, setNotice] = useState<string | null>(null)
  const [confirmVerify, setConfirmVerify] = useState(false)
  const [autoOpenId, setAutoOpenId] = useState<string | null>(null)

  const turns = data?.turns ?? []
  const speakerInfo = useMemo(() => buildSpeakerInfo(turns), [turns])
  const colorFor = useMemo(() => makeSpeakerColors(turns), [turns])
  const buckets: BucketInfo[] = useMemo(() =>
    [...speakerInfo.entries()]
      .map(([key, s]) => ({ key, ordinal: s.ordinal, name: s.appliedName, memberId: s.memberId, role: s.role, count: s.count }))
      .sort((a, b) => a.ordinal - b.ordinal),
    [speakerInfo])

  if (isLoading) return <div className="py-16 text-center text-sm text-gray-400">Loading…</div>
  if (error || !data) return <div className="py-16 text-center text-sm text-red-600">Failed to load review data.</div>

  const { hearing, roster } = data
  const totalSpeakers = speakerInfo.size
  const pendingSpeakers = [...speakerInfo.values()].filter(s => s.pending).length
  const reviewed = totalSpeakers - pendingSpeakers
  const busy = applySpeaker.isPending || overrideTurn.isPending || splitTurn.isPending
    || mergeTurn.isPending || insertTurn.isPending || acceptAll.isPending || setStatus.isPending
    || acceptCleanup.isPending || rejectCleanup.isPending || restoreCleanup.isPending
    || overrideCleanup.isPending || editTurnText.isPending || reviewTurnText.isPending
  const badge = tierBadge(hearing.status)
  const verifyErr = setStatus.error as (Error & { unresolved?: string[] }) | null

  // Any mutation may demote a verified hearing — surface it, never silent.
  const flagDemotion = (r: { demoted?: boolean }) => {
    if (r?.demoted) setNotice("This edit returned the hearing to “Speakers attributed”. Re-confirm human verification when you're done.")
  }

  const displayName = (t: ReviewTurn) =>
    t.member_full_name ?? t.speaker_name ?? ordinalLabel(t.speaker_ordinal)

  return (
    <div>
      <Link to="/admin" className="text-sm text-slate-500 hover:text-slate-700">← All hearings</Link>

      {/* Sticky action bar */}
      <div className="sticky top-0 z-20 bg-gray-50/90 backdrop-blur-sm -mx-4 px-4 py-3 mt-2 border-b border-gray-200">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-bold text-slate-900 truncate max-w-md">{hearing.title}</h1>
          <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', badge.cls)}>{badge.label}</span>
          <span className="text-sm text-gray-500"><span className="font-medium">{reviewed} / {totalSpeakers}</span> speakers reviewed{pendingSpeakers > 0 && ` · ${pendingSpeakers} pending`}</span>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => acceptAll.mutate(undefined, { onSuccess: flagDemotion })}
              disabled={busy || pendingSpeakers === 0}
              className="text-sm font-semibold px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-500 disabled:opacity-50">
              {acceptAll.isPending ? 'Attributing…' : 'Attribute all speakers'}
            </button>
            <button
              onClick={() => setStatus.mutate('attributed')}
              disabled={busy || pendingSpeakers > 0}
              title={pendingSpeakers > 0 ? `${pendingSpeakers} speaker(s) still pending` : undefined}
              className="text-sm font-semibold px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
              Publish — speakers attributed
            </button>
            {confirmVerify ? (
              <span className="flex items-center gap-1">
                <button onClick={() => { setStatus.mutate('verified'); setConfirmVerify(false) }} disabled={busy}
                  className="text-sm font-semibold px-3 py-1.5 rounded-lg bg-green-700 text-white hover:bg-green-600 disabled:opacity-50">
                  Confirm human-verified
                </button>
                <button onClick={() => setConfirmVerify(false)} className="text-sm text-gray-500 hover:text-gray-700 px-2">cancel</button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmVerify(true)}
                disabled={busy || pendingSpeakers > 0}
                title="A deliberate claim that a person has reviewed this hearing"
                className="text-sm font-semibold px-3 py-1.5 rounded-lg border-2 border-green-700 text-green-800 hover:bg-green-50 disabled:opacity-50">
                Mark as human-verified
              </button>
            )}
          </div>
        </div>

        {pendingSpeakers > 0 && <p className="mt-1 text-xs text-amber-700">Resolve all speakers to publish or verify.</p>}
        {notice && (
          <div className="mt-2 flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-300 rounded px-3 py-2">
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} className="ml-auto text-amber-600 hover:text-amber-800">dismiss</button>
          </div>
        )}
        {verifyErr && <p className="mt-1 text-xs text-red-600">{verifyErr.message}{verifyErr.unresolved?.length ? `: ${verifyErr.unresolved.join(', ')}` : ''}</p>}
        {setStatus.isSuccess && (
          <p className="mt-1 text-xs text-green-700">
            Now “{setStatus.data.status === 'verified' ? 'Human-verified' : 'Speakers attributed'}”. <Link to={`/hearings/${id}`} className="underline">View public transcript →</Link>
          </p>
        )}
      </div>

      {/* Chronological transcript */}
      <div className="mt-4 bg-white rounded-xl border border-gray-200 divide-y divide-gray-50">
        {turns.map((turn, i) => {
          const info = speakerInfo.get(turn.speaker_key)!
          const isFirst = info.firstTurnId === turn.id
          const prev = i > 0 ? { name: displayName(turns[i - 1]), key: turns[i - 1].speaker_key } : null
          const next = i < turns.length - 1 ? { name: displayName(turns[i + 1]), key: turns[i + 1].speaker_key } : null
          return (
            <div key={turn.id}>
              {isFirst && (
                <div className="px-3">
                  <SpeakerHeader
                    info={info}
                    roster={roster}
                    busy={busy}
                    onSpeaker={(d) => applySpeaker.mutate({ speaker_key: turn.speaker_key, ...d } as SpeakerDecision, { onSuccess: flagDemotion })}
                  />
                </div>
              )}
              <TurnRow
                turn={turn}
                colorCls={colorFor(turn)}
                roster={roster}
                buckets={buckets}
                busy={busy}
                prev={prev}
                next={next}
                autoOpen={turn.id === autoOpenId}
                onTurn={(d) => overrideTurn.mutate({ turnId: turn.id, ...d } as TurnDecision, { onSuccess: flagDemotion })}
                onSplit={(p) => splitTurn.mutate({ turnId: turn.id, ...p }, { onSuccess: flagDemotion })}
                onMerge={(direction) => mergeTurn.mutate({ turnId: turn.id, direction }, {
                  onSuccess: (r) => {
                    flagDemotion(r)
                    if (r.word_times_lost) setNotice('Merged — note: the surviving turn lost per-word timing (one side had none). Text is intact.')
                  },
                })}
                onInsert={(position) => insertTurn.mutate({ turnId: turn.id, position }, {
                  onSuccess: (r) => { flagDemotion(r); setAutoOpenId(r.new_turn_id) },
                })}
                onEditText={(text, base) => editTurnText.mutateAsync({ turnId: turn.id, text, base }).then(flagDemotion)}
                onAcceptEdit={(edit_id) => acceptCleanup.mutate({ turnId: turn.id, edit_id }, {
                  onSuccess: flagDemotion,
                  onError: (e) => setNotice((e as Error).message),
                })}
                onRejectEdit={(edit_id) => rejectCleanup.mutate({ turnId: turn.id, edit_id }, {
                  onSuccess: flagDemotion,
                  onError: (e) => setNotice((e as Error).message),
                })}
                onRestoreEdit={(edit_id) => restoreCleanup.mutate({ turnId: turn.id, edit_id }, {
                  onSuccess: flagDemotion,
                  onError: (e) => setNotice((e as Error).message),
                })}
                onOverrideEdit={(edit_id) => overrideCleanup.mutate({ turnId: turn.id, edit_id }, {
                  onSuccess: (r) => {
                    flagDemotion(r)
                    setNotice('Applied as YOUR edit (violet) — recorded as an admin override of the validator block, not as an AI cleanup.')
                  },
                  onError: (e) => setNotice((e as Error).message),
                })}
                onAcceptAllSafe={() => acceptCleanup.mutate({ turnId: turn.id, all_safe: true }, {
                  onSuccess: flagDemotion,
                  onError: (e) => setNotice((e as Error).message),
                })}
                onDismissAllPending={() => rejectCleanup.mutate({ turnId: turn.id, all_pending: true }, {
                  onSuccess: (r) => {
                    flagDemotion(r)
                    setNotice(`Dismissed ${r.dismissed} suggestion${r.dismissed === 1 ? '' : 's'} on this turn — recoverable via “${r.dismissed} dismissed · show”.`)
                  },
                  onError: (e) => setNotice((e as Error).message),
                })}
                onMarkReviewed={() => reviewTurnText.mutate({ turnId: turn.id })}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
