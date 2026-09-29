import { Link } from 'react-router-dom'
import type { Hearing, HearingContext, HearingParticipant, HearingWitness } from '../types/api'
import { tierBadge } from '../utils/hearingTier'
import {
  committeeRoleLabel, memberLabel, partyStateLabel, partyTextClass,
} from '../utils/memberDisplay'
import { cn } from '../utils/cn'

/**
 * The orientation block above the transcript: what this hearing was, who was in
 * the room, and what got covered — so a reader can place 159 turns before
 * reading any of them.
 *
 * This is CHROME, so it is entirely sans-serif; the serif begins with the
 * testimony below it. It also owns the hearing's identity (title, committee,
 * date, trust badge) rather than sitting under a second header that repeats it.
 *
 * Every list it renders is derived from the transcript's own turns (see
 * getHearingTranscript), which has two consequences worth keeping:
 *   - a group with no data renders NOTHING, not an empty heading — an untagged
 *     hearing must not look like a hearing about nothing;
 *   - "members participating" is who spoke, which is not the committee roster.
 *     The label says so, because the difference is the whole point.
 *
 * Witnesses are the one group it may not own: once any witness record exists,
 * the fuller grouped section (HearingWitnesses) takes them over and the caller
 * passes showWitnesses={false}, so they are never listed twice.
 */

function fmtDate(iso: string | null) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  })
}

/** One labelled group. Hairline-separated rows, so an omitted group leaves no gap. */
function ContextGroup({ label, note, children }: {
  label: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section className="border-t border-gray-100 px-6 py-4">
      <h2 className="mb-2.5 flex flex-wrap items-baseline gap-x-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          {label}
        </span>
        {note && <span className="text-[11px] text-slate-400">{note}</span>}
      </h2>
      {children}
    </section>
  )
}

/**
 * A witness, name-first. This is the COMPACT fallback used only when no witness
 * records have been entered — once any have, HearingWitnesses renders the full
 * grouped section instead and this row is suppressed (see showWitnesses).
 * The caption still fills in from whatever title/organization exist, so a
 * half-entered hearing degrades to something useful rather than to bare names.
 */
function Witness({ witness: w }: { witness: HearingWitness }) {
  const caption = [w.title, w.organization].filter(Boolean).join(', ')
  return (
    <li className="min-w-0">
      <span className="text-sm font-medium text-slate-800">{w.name}</span>
      {caption && <span className="block text-xs leading-snug text-slate-500">{caption}</span>}
    </li>
  )
}

/** A member chip — the reader's way out of the hearing and into a profile. */
function ParticipantChip({ participant: p }: { participant: HearingParticipant }) {
  const partyState = partyStateLabel(p.party, p.state)
  // Prefer the roster's word. A member who only *presided* over a turn without
  // sitting in the chair seat still reads as chair to a reader, so fall back to
  // the turn-level role when the roster has nothing.
  const role = committeeRoleLabel(p.committee_role) ?? (p.chaired ? 'Chair' : null)

  return (
    <li>
      <Link
        to={`/members/${p.id}`}
        title={`${p.turn_count} turn${p.turn_count === 1 ? '' : 's'} in this hearing`}
        className="inline-flex items-baseline gap-1.5 rounded-full border border-gray-200 px-2.5 py-1 text-[13px] transition-colors hover:border-slate-400 hover:bg-slate-50"
      >
        <span className="font-medium text-slate-900">{memberLabel(p.full_name, p.chamber)}</span>
        {partyState && (
          <span className={cn('text-[11px] font-semibold', partyTextClass(p.party))}>{partyState}</span>
        )}
        {role && (
          <span className="text-[10px] uppercase tracking-[0.08em] text-slate-500">{role}</span>
        )}
      </Link>
    </li>
  )
}

export default function HearingContextHeader({ hearing, context, showWitnesses = true }: {
  hearing: Hearing
  context: HearingContext
  /** False when the grouped Witnesses section below is rendering them instead. */
  showWitnesses?: boolean
}) {
  const badge = tierBadge(hearing.status)
  const { participants, witnesses, topics } = context
  const date = fmtDate(hearing.held_on)

  return (
    <header className="mb-6 rounded-lg border border-gray-200 bg-white">
      {/* Identity — committee above the title, the way a hearing is cited */}
      <div className="px-6 pb-5 pt-5">
        {hearing.committee_name && (
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
            {hearing.committee_name}
          </p>
        )}
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-xl font-bold leading-snug text-slate-900">{hearing.title}</h1>
          <span className={cn('shrink-0 rounded-full px-2 py-1 text-xs font-medium', badge.cls)}>
            {badge.label}
          </span>
        </div>
        {(date || hearing.congress) && (
          <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-sm text-slate-500">
            {date && <time dateTime={hearing.held_on!}>{date}</time>}
            {date && hearing.congress && <span aria-hidden>·</span>}
            {hearing.congress && <span>{hearing.congress}th Congress</span>}
          </p>
        )}
      </div>

      {showWitnesses && witnesses.length > 0 && (
        <ContextGroup label={witnesses.length === 1 ? 'Witness' : 'Witnesses'}>
          <ul className="flex flex-wrap gap-x-8 gap-y-2">
            {witnesses.map((w) => <Witness key={w.name} witness={w} />)}
          </ul>
        </ContextGroup>
      )}

      {participants.length > 0 && (
        <ContextGroup
          label="Members participating"
          note={`${participants.length} spoke — not the full committee roster`}
        >
          <ul className="flex flex-wrap gap-1.5">
            {participants.map((p) => <ParticipantChip key={p.id} participant={p} />)}
          </ul>
        </ContextGroup>
      )}

      {topics.length > 0 && (
        <ContextGroup label="Topics discussed">
          <ul className="flex flex-wrap gap-1.5">
            {topics.map((t) => (
              <li key={t.id}>
                <Link
                  to={`/hearings?topic=${t.slug}`}
                  title={`${t.turn_count} turn${t.turn_count === 1 ? '' : 's'} tagged ${t.name}`}
                  className="inline-block rounded-full border border-teal-100 bg-teal-50/70 px-2.5 py-1 text-[13px] text-teal-700 transition-colors hover:bg-teal-100"
                >
                  {t.name}
                </Link>
              </li>
            ))}
          </ul>
        </ContextGroup>
      )}
    </header>
  )
}
