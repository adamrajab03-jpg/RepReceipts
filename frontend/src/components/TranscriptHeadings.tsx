import { type ReactNode } from 'react'
import type { PublicSection, SectionType } from '../types/api'
import { phaseAnchorId, sectionAnchorId, sectionTitle, type PhaseGroup, type SectionLike } from '../utils/sectionPhases'
import { formatTimecode } from '../utils/timecode'
import { memberLabel, partyTextClass } from '../utils/memberDisplay'
import { cn } from '../utils/cn'
import { useHearingVideo } from './HearingVideo'

// ============================================================================
//  The document's structural type — the sans-serif scaffolding that frames the
//  serif testimony. Two levels, both CENTERED dividers, in descending weight:
//    phase header  (one bold line)  >  section header  (name over type)
//  The header TEXT ITSELF is the video link — a plain click seeks the docked
//  player to that header's start; there is no separate "Watch" affordance.
//  These are PUBLIC-ONLY. The admin workbench keeps its own PhaseHeader.
// ============================================================================

const PHASE_ACCENT: Record<string, { text: string; line: string }> = {
  opening:     { text: 'text-teal-700',  line: 'bg-teal-500/40' },
  questioning: { text: 'text-sky-700',   line: 'bg-sky-500/40' },
  closing:     { text: 'text-stone-600', line: 'bg-stone-500/40' },
  other:       { text: 'text-amber-700', line: 'bg-amber-500/40' },
}

const KIND_LABEL: Record<SectionType, string> = {
  chair_opening: 'Chair opening',
  ranking_opening: 'Ranking member opening',
  witness_statement: 'Witness statement',
  questioning: 'Questioning',
  closing: 'Closing',
  unassigned: '',
}

/**
 * A header whose TEXT is the video link. A plain click seeks the docked player
 * to `ms`; a modified click (or no docked player) follows the YouTube deep link.
 * Falls back to plain, unlinked text when the hearing has no video. This
 * replaces the old separate "▶ Watch" link — the header carries the seek now.
 */
function VideoHeaderLink({ href, ms, label, className, children }: {
  href: string | null
  ms: number | null
  label: string
  className?: string
  children: ReactNode
}) {
  const { canSeek, seekClick } = useHearingVideo()
  if (!href || ms == null) return <span className={className}>{children}</span>
  const at = formatTimecode(ms)
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={seekClick(ms)}
      title={canSeek ? `Play ${label} from ${at}` : `Watch ${label} on video (opens at ${at})`}
      className={className}
    >
      {children}
    </a>
  )
}

/** The big header opening a run of same-phase sections: one prominent centered
 *  line — the phase name, flanked by rules, the whole name seeking the video. */
export function PhaseHeading({ group, index, startMs, watchHref }: {
  group: PhaseGroup<SectionLike>
  index: number
  startMs: number | null
  watchHref: string | null
}) {
  const accent = PHASE_ACCENT[group.phase] ?? PHASE_ACCENT.other
  const linked = !!watchHref && startMs != null
  return (
    <header
      id={phaseAnchorId(index)}
      // Each header sits in its own wrapper, so `first:` would match every one
      // of them — the opening phase is identified by its index instead.
      className={cn('scroll-mt-24 lg:scroll-mt-8', index === 0 ? 'pt-4' : 'pt-14')}
    >
      <div className="flex items-center gap-4">
        <span className={cn('h-px flex-1', accent.line)} aria-hidden />
        <VideoHeaderLink
          href={watchHref}
          ms={startMs}
          label={group.label}
          className={cn(
            'text-center text-xl font-bold uppercase tracking-[0.1em] transition-colors',
            accent.text,
            linked && 'hover:text-slate-900 hover:underline underline-offset-4',
          )}
        >
          {group.label}
        </VideoHeaderLink>
        <span className={cn('h-px flex-1', accent.line)} aria-hidden />
      </div>
    </header>
  )
}

/** The per-person header inside a phase: centered, two lines — the speaker's
 *  name (the video link) over the section type. */
export function SectionHeading({ section, startMs, watchHref, opensPhase }: {
  section: PublicSection
  startMs: number | null
  watchHref: string | null
  /** True when a phase header sits directly above — skip the separating rule. */
  opensPhase: boolean
}) {
  // For a member section the name reads "Sen./Rep. <Name>"; otherwise fall back
  // to the section's own title (a label, a witness name, or the type).
  const name = section.member_id && section.member_full_name
    ? memberLabel(section.member_full_name, section.member_chamber)
    : sectionTitle(section)
  const type = KIND_LABEL[section.type]
  // Don't repeat the name as the type line (e.g. an unlabelled witness statement).
  const showType = type && type.toLowerCase() !== name.toLowerCase()
  const linked = !!watchHref && startMs != null
  // A questioning round is tinted by who led it — blue (D) / red (R) / neutral
  // (I or unknown). Only questioning; every other type stays neutral.
  const typeColor = section.type === 'questioning' ? partyTextClass(section.member_party) : 'text-slate-500'

  return (
    <header
      id={sectionAnchorId(section.id)}
      className={cn(
        'scroll-mt-24 lg:scroll-mt-8 text-center pb-3',
        opensPhase ? 'pt-6' : 'mt-10 border-t border-gray-100 pt-6',
      )}
    >
      <VideoHeaderLink
        href={watchHref}
        ms={startMs}
        label={name}
        className={cn(
          'block text-base font-semibold tracking-tight text-slate-900 transition-colors',
          linked && 'hover:text-slate-700 hover:underline underline-offset-4',
        )}
      >
        {name}
      </VideoHeaderLink>
      {showType && (
        <div className={cn('mt-0.5 text-[11px] font-medium uppercase tracking-[0.08em]', typeColor)}>{type}</div>
      )}
    </header>
  )
}
