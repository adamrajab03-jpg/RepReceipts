import { useEffect, useRef, useState } from 'react'
import { sectionAnchorId, sectionTitle, type PhaseGroup, type SectionLike } from '../utils/sectionPhases'
import { formatTimecode } from '../utils/timecode'
import { HearingVideoFloating, HearingVideoPanel, useHearingVideo } from './HearingVideo'
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
function OutlineList({ groups, timeOf, active, onNavigate, className }: OutlineProps & {
  onNavigate?: () => void
  /** Sizing for the scroll box — the sidebar flexes it, the drawer caps it. */
  className?: string
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const { canSeek, seek } = useHearingVideo()

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
    <div ref={boxRef} className={cn('overflow-y-auto overscroll-contain px-1 py-1', className)}>
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
                const title = sectionTitle(s)
                return (
                  <li key={s.id}>
                    <div
                      className={cn(
                        'group flex items-baseline -ml-px border-l-2 transition-colors',
                        isActive
                          ? 'border-slate-900 bg-slate-50 text-slate-900'
                          : 'border-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-50',
                      )}
                    >
                      <button
                        data-anchor={anchor}
                        onClick={() => { jump(anchor); onNavigate?.() }}
                        aria-current={isActive ? 'true' : undefined}
                        className="flex-1 min-w-0 flex items-baseline gap-2 py-1 pl-3 pr-2 text-left"
                      >
                        <span className={cn('flex-1 min-w-0 truncate text-[13px]', isActive && 'font-semibold')}>
                          {title}
                        </span>
                        {ms != null && (
                          <span className="shrink-0 text-[10px] tabular-nums text-slate-500">{formatTimecode(ms)}</span>
                        )}
                      </button>
                      {/* Seek the docked player without moving the page. Quiet on
                          desktop until the row is hovered or current; always shown
                          on touch, where there is no hover. */}
                      {canSeek && ms != null && (
                        <button
                          onClick={() => { seek(ms); onNavigate?.() }}
                          title={`Play from ${formatTimecode(ms)}`}
                          aria-label={`Play ${title} in the video player, from ${formatTimecode(ms)}`}
                          className={cn(
                            'shrink-0 self-stretch pl-1 pr-2 text-[9px] text-slate-500 transition-opacity hover:text-slate-900 focus-visible:opacity-100',
                            !isActive && 'lg:opacity-0 lg:group-hover:opacity-100',
                          )}
                        >
                          ▶
                        </button>
                      )}
                    </div>
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
 * Desktop: a sticky sidebar beside the transcript that follows the reader — the
 * outline, and (when the hearing has a video) the docked player below it.
 *
 * Sticky positioning works here because the grid row is the containing block —
 * the sidebar slides down the full height of the transcript column. See
 * TranscriptView for the grid (and `lg:items-start`, without which the cell
 * stretches and sticky has nowhere to travel). The column is capped at the
 * viewport and the outline is the part that gives, so the player is never
 * pushed off the bottom of the screen.
 */
export default function TranscriptOutline({ showVideo, ...props }: OutlineProps & { showVideo?: boolean }) {
  if (!props.groups.length) return null
  return (
    <aside className="hidden lg:flex lg:flex-col lg:gap-3 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)]">
      <nav aria-label="Hearing outline" className="flex min-h-0 flex-col rounded-lg border border-gray-200 bg-white">
        <p className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Outline
        </p>
        <OutlineList {...props} className="min-h-0 flex-1" />
      </nav>
      {showVideo && <HearingVideoPanel className="shrink-0" resizable />}
    </aside>
  )
}

/**
 * Narrow screens: a sticky bar naming the section you are in, which expands into
 * the same outline. It sits ABOVE the grid (see TranscriptView) so its sticky
 * containing block spans the whole transcript rather than its own height.
 *
 * With a video, the bar also carries the player as a mini-player hanging just
 * below it. It is absolutely positioned so showing it overlays the text rather
 * than growing the sticky bar — which would shove the whole transcript down.
 */
export function TranscriptOutlineBar({ showVideo, ...props }: OutlineProps & { showVideo?: boolean }) {
  const [open, setOpen] = useState(false)
  const video = useHearingVideo()
  if (!props.groups.length) return null

  const currentSection = props.groups
    .flatMap((g) => g.sections)
    .find((s) => sectionAnchorId(s.id) === props.active)
  const currentPhase = props.groups.find((g) => g.sections.some((s) => sectionAnchorId(s.id) === props.active))
  const withVideo = showVideo && !!video.videoId

  return (
    <div className="lg:hidden sticky top-0 z-30 -mx-4 mb-4 border-b border-gray-200 bg-gray-50/95 px-4 py-2 backdrop-blur">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex-1 min-w-0 flex items-center gap-2 text-left"
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
        {withVideo && (
          <button
            onClick={() => video.setExpanded(!video.expanded)}
            aria-expanded={video.expanded}
            aria-label={video.expanded ? 'Hide video' : 'Show video'}
            className={cn(
              'shrink-0 border-l border-gray-200 pl-3 text-xs transition-colors',
              video.expanded ? 'text-slate-900' : 'text-slate-500 hover:text-slate-900',
            )}
          >
            {/* Same open/close cue as "Sections ▾" beside it. */}
            <span aria-hidden className="text-[9px]">▶</span> Video {video.expanded ? '▴' : '▾'}
          </button>
        )}
      </div>

      {open && (
        <div className="mt-2 rounded-lg border border-gray-200 bg-white shadow-sm">
          <OutlineList {...props} className="max-h-[calc(100vh-8rem)]" onNavigate={() => setOpen(false)} />
        </div>
      )}

      {withVideo && <HearingVideoFloating className="absolute right-4 top-full mt-2" />}
    </div>
  )
}
