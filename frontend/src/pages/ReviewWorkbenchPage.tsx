import { useState, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  useReview, useApplySpeaker, useOverrideTurn, useAcceptAll, useSetStatus,
  type SpeakerDecision, type TurnDecision,
} from '../hooks/useAdmin'
import type { ReviewTurn, RosterMember } from '../types/api'
import { makeSpeakerColors } from '../utils/speakerColors'
import { tierBadge } from '../utils/hearingTier'
import { cn } from '../utils/cn'

type BareDecision =
  | { decision: 'member'; member_id: string }
  | { decision: 'witness'; witness_name: string }
  | { decision: 'unknown' }
  | { decision: 'reset' }

function fmtMs(ms: number | null) {
  if (ms == null) return ''
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function confPct(c: number) { return `${Math.round(c * 100)}%` }
function confColor(c: number) { return c >= 0.85 ? 'text-green-700' : c >= 0.6 ? 'text-amber-700' : 'text-red-600' }

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
    <div className="mt-2 rounded-lg border border-gray-200 bg-white p-2 space-y-2">
      <input
        value={q} onChange={e => setQ(e.target.value)} autoFocus
        placeholder="Search roster by name or state…"
        className="w-full text-sm px-2.5 py-1.5 rounded-md border border-gray-300 focus:outline-none focus:ring-2 focus:ring-slate-400"
      />
      <div className="max-h-44 overflow-auto rounded-md border border-gray-100 divide-y divide-gray-50">
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
        {allowReset && <button onClick={() => onDecision({ decision: 'reset' })} className="text-blue-600 hover:text-blue-800 underline">Reset to speaker</button>}
      </div>
    </div>
  )
}

// ── Speaker header (rendered at each speaker's first turn) ────────────────────
function SpeakerHeader({ label, info, roster, busy, onSpeaker }: {
  label: string
  info: SpeakerInfo
  roster: RosterMember[]
  busy: boolean
  onSpeaker: (d: Exclude<BareDecision, { decision: 'reset' }>) => void
}) {
  const [open, setOpen] = useState(false)
  const sug = info.suggestion?.suggested_identity

  if (!info.pending) {
    // Reviewed: compact confirmation with a re-attribute affordance.
    return (
      <div className="mt-4 mb-1 flex items-center gap-2 text-xs">
        <span className="font-mono font-semibold text-slate-700">{label}</span>
        <span className="text-green-700">✓ attributed as <span className="font-medium">{info.appliedName}</span></span>
        <span className="text-gray-400">· {info.count} turns</span>
        <button onClick={() => setOpen(v => !v)} className="text-slate-500 hover:text-slate-700 underline">{open ? 'cancel' : 'change'}</button>
        {open && <div className="w-full"><MiniAssign roster={roster} onDecision={(d) => { if (d.decision !== 'reset') { onSpeaker(d); setOpen(false) } }} /></div>}
      </div>
    )
  }

  // Pending: Claude's suggestion + reasoning, right where the speaker first appears.
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
      {open && <MiniAssign roster={roster} onDecision={(d) => { if (d.decision !== 'reset') { onSpeaker(d); setOpen(false) } }} />}
    </div>
  )
}

// ── One transcript turn ───────────────────────────────────────────────────────
function TurnRow({ turn, colorCls, roster, busy, onTurn }: {
  turn: ReviewTurn
  colorCls: string
  roster: RosterMember[]
  busy: boolean
  onTurn: (d: BareDecision) => void
}) {
  const [open, setOpen] = useState(false)
  const pending = turn.attribution_status === 'unverified'
  const sug = turn.suggestion?.suggested_identity
  const resolved = turn.member_full_name ?? turn.speaker_name
  const pendingName = sug?.type === 'unknown' ? 'Unknown' : (sug?.display_name ?? turn.speaker_label_raw)

  return (
    <div className={cn('border-l-4 pl-3 pr-2 py-2.5', colorCls, turn.pinned && 'ring-1 ring-inset ring-amber-400/70 rounded-r')}>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-gray-400 font-mono tabular-nums w-10 shrink-0">{fmtMs(turn.start_ms)}</span>

        {pending ? (
          <span className="flex items-center gap-1.5">
            <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[11px]">pending</span>
            <span className="font-medium text-slate-700">{pendingName}</span>
            {turn.suggestion && <span className={cn('tabular-nums', confColor(turn.suggestion.confidence))}>{confPct(turn.suggestion.confidence)}</span>}
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="font-semibold text-slate-800">{resolved ?? 'Unknown speaker'}</span>
            {turn.pinned && <span className="px-1.5 py-0.5 rounded bg-amber-500 text-white text-[11px] font-medium">⟳ Override</span>}
          </span>
        )}

        <span className="ml-auto flex items-center gap-2">
          {/* Reserved slot for the next slice's inline text-edit control. */}
          <button onClick={() => setOpen(v => !v)} disabled={busy}
            className="text-[11px] text-slate-500 hover:text-slate-800 underline">
            {open ? 'close' : 'reassign'}
          </button>
        </span>
      </div>

      <p className="mt-1 text-sm text-gray-700 leading-relaxed">{turn.raw_text}</p>

      {open && (
        <MiniAssign
          roster={roster}
          allowReset={turn.pinned}
          onDecision={(d) => { onTurn(d); setOpen(false) }}
        />
      )}
    </div>
  )
}

// ── Derived per-speaker info ──────────────────────────────────────────────────
interface SpeakerInfo {
  count: number
  firstTurnId: string
  pending: boolean
  suggestion: ReviewTurn['suggestion']
  appliedName: string
}

function buildSpeakerInfo(turns: ReviewTurn[]): Map<string, SpeakerInfo> {
  const m = new Map<string, SpeakerInfo>()
  for (const t of turns) {
    const cur = m.get(t.speaker_label_raw)
    if (!cur) {
      m.set(t.speaker_label_raw, {
        count: 1, firstTurnId: t.id,
        pending: t.attribution_status === 'unverified',
        suggestion: t.suggestion,
        appliedName: t.member_full_name ?? t.speaker_name ?? 'Unknown',
      })
    } else {
      cur.count += 1
      if (t.attribution_status === 'unverified') cur.pending = true
      // Prefer a resolved name from any non-pending turn.
      if (cur.appliedName === 'Unknown' && (t.member_full_name || t.speaker_name)) {
        cur.appliedName = t.member_full_name ?? t.speaker_name ?? 'Unknown'
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
  const acceptAll = useAcceptAll(id)
  const setStatus = useSetStatus(id)

  const [notice, setNotice] = useState<string | null>(null)
  const [confirmVerify, setConfirmVerify] = useState(false)

  const turns = data?.turns ?? []
  const speakerInfo = useMemo(() => buildSpeakerInfo(turns), [turns])
  const colorFor = useMemo(() => makeSpeakerColors(turns), [turns])

  if (isLoading) return <div className="py-16 text-center text-sm text-gray-400">Loading…</div>
  if (error || !data) return <div className="py-16 text-center text-sm text-red-600">Failed to load review data.</div>

  const { hearing, roster } = data
  const totalSpeakers = speakerInfo.size
  const pendingSpeakers = [...speakerInfo.values()].filter(s => s.pending).length
  const reviewed = totalSpeakers - pendingSpeakers
  const busy = applySpeaker.isPending || overrideTurn.isPending || acceptAll.isPending || setStatus.isPending
  const badge = tierBadge(hearing.status)
  const verifyErr = setStatus.error as (Error & { unresolved?: string[] }) | null

  // Any mutation may demote a verified hearing — surface it, never silent.
  const flagDemotion = (r: { demoted?: boolean }) => {
    if (r?.demoted) setNotice("This edit returned the hearing to “Speakers attributed”. Re-confirm human verification when you're done.")
  }

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
        {turns.map(turn => {
          const info = speakerInfo.get(turn.speaker_label_raw)!
          const isFirst = info.firstTurnId === turn.id
          return (
            <div key={turn.id}>
              {isFirst && (
                <div className="px-3">
                  <SpeakerHeader
                    label={turn.speaker_label_raw}
                    info={info}
                    roster={roster}
                    busy={busy}
                    onSpeaker={(d) => applySpeaker.mutate({ speaker_label_raw: turn.speaker_label_raw, ...d } as SpeakerDecision, { onSuccess: flagDemotion })}
                  />
                </div>
              )}
              <TurnRow
                turn={turn}
                colorCls={colorFor(turn)}
                roster={roster}
                busy={busy}
                onTurn={(d) => overrideTurn.mutate({ turnId: turn.id, ...d } as TurnDecision, { onSuccess: flagDemotion })}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
