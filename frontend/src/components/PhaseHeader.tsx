import { phaseAnchorId, type PhaseGroup } from '../utils/sectionPhases'
import { cn } from '../utils/cn'

const PHASE_STYLE = {
  opening: 'text-teal-800 border-teal-300',
  questioning: 'text-sky-800 border-sky-300',
  closing: 'text-stone-700 border-stone-300',
  other: 'text-amber-800 border-amber-300',
} as const

/**
 * The big header above a run of same-phase sections. Derived at render time
 * from the section types — nothing in the database corresponds to it.
 */
export default function PhaseHeader({ group, index }: { group: PhaseGroup; index: number }) {
  const style = PHASE_STYLE[group.phase] ?? PHASE_STYLE.other
  return (
    <div id={phaseAnchorId(index)} className="scroll-mt-24 pt-8 pb-2 first:pt-2">
      <div className={cn('flex items-baseline gap-3 border-b-2 pb-1.5', style)}>
        <h2 className="text-lg font-bold uppercase tracking-wide">{group.label}</h2>
        <span className="text-xs font-normal text-gray-400 tabular-nums">
          {group.sections.length} section{group.sections.length === 1 ? '' : 's'} · turns {group.start_seq}–{group.end_seq}
        </span>
      </div>
    </div>
  )
}
