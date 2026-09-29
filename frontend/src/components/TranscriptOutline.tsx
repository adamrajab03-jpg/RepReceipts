import { useEffect, useRef, useState } from 'react'
import { sectionAnchorId, sectionTitle, type PhaseGroup, type SectionLike } from '../utils/sectionPhases'
import { formatTimecode } from '../utils/timecode'
import { cn } from '../utils/cn'

// One restrained accent per phase — enough to tell the levels apart at a glance,
// not enough to colour the page. Matches the dots on the phase headers.
const DOT: Record<string, string> = {
  opening: 'bg-teal-500',
  questioning: 'bg-sky-500',
  closing: 'bg-stone-500',
  other: 'bg-amber-500',
}

export interface OutlineProps {
  groups: PhaseGroup<SectionLike>[]
  /** Section id → ms into the hearing, for the time shown beside each entry. */
  timeOf: (sectionId: string) => number | null
  /** Anchor id of the section the reader is currently in (see useActiveAnchor). */
  active: string | null
}

function jump(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** The list itself — shared by the desktop sidebar and the mobile drawer. */
function OutlineList({ groups, timeOf, active, onNavigate }: OutlineProps & { onNavigate?: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null)

  // Keep the current entry visible in the sidebar's own scroll box. Adjusting
  // scrollTop directly (rather than scrollIntoView) means a long outline can
  // follow the reader without ever nudging the page itself.
  useEffect(() => {
    const box = boxRef.current
    if (!box || !active) return
    const row = box.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(active)}"]`)
    if (!row) return
    const b = box.getBoundingClientRect()
    const r = row.getBoundingClientRect()
    if (r.top < b.top + 12) box.scrollTop -= b.top + 12 - r.top
    else if (r.bottom > b.bottom - 12) box.scrollTop += r.bottom - (b.bottom - 12)
  }, [active])

  return (
    <div ref={boxRef} className="max-h-[calc(100vh-8rem)] overflow-y-auto overscroll-contain px-1 py-1">
      {groups.map((g) => {
        const inPhase = g.sections.some((s) => sectionAnchorId(s.id) === active)
        return (
          <div key={g.anchorId} className="mb-4 last:mb-1">
            <button
              onClick={() => { jump(g.anchorId); onNavigate?.() }}
              className="w-full flex items-center gap-2 px-2 py-1 rounded text-left hover:bg-slate-100 transition-colors"
            >
              <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', DOT[g.phase] ?? DOT.other)} />
              <span className={cn(
                'text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors',
                inPhase ? 'text-slate-900' : 'text-slate-500',
              )}>
                {g.label}
              </span>
            </button>

            <ul className="mt-1 ml-[0.4rem] border-l border-slate-200">
              {g.sections.map((s) => {
                const anchor = sectionAnchorId(s.id)
                const isActive = anchor === active
                const ms = timeOf(s.id)
                return (
                  <li key={s.id}>
                    <button
                      data-anchor={anchor}
                      onClick={() => { jump(anchor); onNavigate?.() }}
                      aria-current={isActive ? 'true' : undefined}
                      className={cn(
                        'group w-full flex items-baseline gap-2 py-1 pl-3 pr-2 -ml-px border-l-2 text-left transition-colors',
                        isActive
                          ? 'border-slate-900 bg-slate-50 text-slate-900'
                          : 'border-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-50',
                      )}
                    >
                      <span className={cn('flex-1 min-w-0 truncate text-[13px]', isActive && 'font-semibold')}>
                        {sectionTitle(s)}
                      </span>
                      {ms != null && (
                        <span className="shrink-0 text-[10px] tabular-nums text-slate-500">{formatTimecode(ms)}</span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Desktop: a sticky outline beside the transcript that follows the reader.
 *
 * Sticky positioning works here because the grid row is the containing block —
 * the sidebar slides down the full height of the transcript column. See
 * TranscriptView for the grid (and `lg:items-start`, without which the cell
 * stretches and sticky has nowhere to travel).
 */
export default function TranscriptOutline(props: OutlineProps) {
  if (!props.groups.length) return null
  return (
    <nav
      aria-label="Hearing outline"
      className="hidden lg:block lg:sticky lg:top-6 rounded-lg border border-gray-200 bg-white"
    >
      <p className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        Outline
      </p>
      <OutlineList {...props} />
    </nav>
  )
}

/**
 * Narrow screens: a sticky bar naming the section you are in, which expands into
 * the same outline. It sits ABOVE the grid (see TranscriptView) so its sticky
 * containing block spans the whole transcript rather than its own height.
 */
export function TranscriptOutlineBar(props: OutlineProps) {
  const [open, setOpen] = useState(false)
  if (!props.groups.length) return null

  const currentSection = props.groups
    .flatMap((g) => g.sections)
    .find((s) => sectionAnchorId(s.id) === props.active)
  const currentPhase = props.groups.find((g) => g.sections.some((s) => sectionAnchorId(s.id) === props.active))

  return (
    <div className="lg:hidden sticky top-0 z-30 -mx-4 mb-4 border-b border-gray-200 bg-gray-50/95 px-4 py-2 backdrop-blur">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 text-left"
      >
        <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', DOT[currentPhase?.phase ?? 'other'])} />
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 shrink-0">
          {currentPhase?.label ?? 'Outline'}
        </span>
        {currentSection && (
          <span className="min-w-0 truncate text-[13px] text-slate-800">{sectionTitle(currentSection)}</span>
        )}
        <span className="ml-auto shrink-0 text-xs text-slate-500">{open ? 'Close ▴' : 'Sections ▾'}</span>
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-gray-200 bg-white shadow-sm">
          <OutlineList {...props} onNavigate={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}
