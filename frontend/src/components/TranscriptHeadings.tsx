import type { PublicSection, SectionType } from '../types/api'
import { phaseAnchorId, sectionAnchorId, sectionTitle, type PhaseGroup, type SectionLike } from '../utils/sectionPhases'
import { formatTimecode } from '../utils/timecode'
import { cn } from '../utils/cn'

// ============================================================================
//  The document's structural type — the sans-serif scaffolding that frames the
//  serif testimony. Three levels, in descending weight:
//    phase header  (largest, ruled)  >  section header  >  speaker label
//  These are PUBLIC-ONLY. The admin workbench keeps its own PhaseHeader, which
//  carries editing affordances this deliberately does not.
// ============================================================================

const PHASE_ACCENT: Record<string, { dot: string; rule: string }> = {
  opening:     { dot: 'bg-teal-500',  rule: 'border-teal-500/30' },
  questioning: { dot: 'bg-sky-500',   rule: 'border-sky-500/30' },
  closing:     { dot: 'bg-stone-500', rule: 'border-stone-500/30' },
  other:       { dot: 'bg-amber-500', rule: 'border-amber-500/30' },
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
 * "▶ Watch" — deep-links the hearing video to the moment this header starts.
 * Deliberately quiet: it sits at the end of the header line in the same muted
 * grey as the timecode and only gains colour on hover, so a reader scanning the
 * document is never pulled away from the text.
 */
export function WatchLink({ href, at, label }: { href: string; at: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`Watch ${label} on video (opens at ${at})`}
      className="inline-flex shrink-0 items-baseline gap-1 text-xs text-slate-500 transition-colors hover:text-slate-900"
    >
      <span aria-hidden className="text-[9px]">▶</span>
      Watch
      <span className="sr-only"> {label} on video, opens at {at} in a new tab</span>
    </a>
  )
}

/** The big header opening a run of same-phase sections. */
export function PhaseHeading({ group, index, startMs, watchHref }: {
  group: PhaseGroup<SectionLike>
  index: number
  startMs: number | null
  watchHref: string | null
}) {
  const accent = PHASE_ACCENT[group.phase] ?? PHASE_ACCENT.other
  return (
    <header
      id={phaseAnchorId(index)}
      // Each header sits in its own wrapper, so `first:` would match every one
      // of them — the opening phase is identified by its index instead.
      className={cn('scroll-mt-24 lg:scroll-mt-8', index === 0 ? 'pt-4' : 'pt-14')}
    >
      <div className={cn('flex items-baseline gap-3 border-b-2 pb-2', accent.rule)}>
        <span className={cn('h-2 w-2 shrink-0 self-center rounded-full', accent.dot)} />
        <h2 className="text-xl font-bold uppercase tracking-[0.1em] text-slate-900">
          {group.label}
        </h2>
        {watchHref && startMs != null && (
          <span className="ml-auto">
            <WatchLink href={watchHref} at={formatTimecode(startMs)} label={group.label} />
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        {group.sections.length} section{group.sections.length === 1 ? '' : 's'}
        {startMs != null && <> · begins at <span className="tabular-nums">{formatTimecode(startMs)}</span></>}
      </p>
    </header>
  )
}

/** The per-person header inside a phase. */
export function SectionHeading({ section, startMs, watchHref, opensPhase }: {
  section: PublicSection
  startMs: number | null
  watchHref: string | null
  /** True when a phase header sits directly above — skip the separating rule. */
  opensPhase: boolean
}) {
  const title = sectionTitle(section)
  const kind = KIND_LABEL[section.type]
  const showKind = kind && kind.toLowerCase() !== title.toLowerCase()

  return (
    <header
      id={sectionAnchorId(section.id)}
      className={cn(
        'scroll-mt-24 lg:scroll-mt-8 flex flex-wrap items-baseline gap-x-3 gap-y-1 pb-3',
        opensPhase ? 'pt-6' : 'mt-10 border-t border-gray-100 pt-6',
      )}
    >
      <h3 className="text-base font-semibold tracking-tight text-slate-900">{title}</h3>
      {showKind && (
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-500">{kind}</span>
      )}
      <span className="ml-auto flex items-baseline gap-3">
        {startMs != null && (
          <time className="text-xs tabular-nums text-slate-500">{formatTimecode(startMs)}</time>
        )}
        {watchHref && startMs != null && (
          <WatchLink href={watchHref} at={formatTimecode(startMs)} label={title} />
        )}
      </span>
    </header>
  )
}
