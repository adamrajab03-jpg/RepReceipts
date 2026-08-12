import { useState } from 'react'
import { sectionAnchorId, sectionTitle, type PhaseGroup, type SectionLike } from '../utils/sectionPhases'
import { cn } from '../utils/cn'

const DOT = {
  opening: 'bg-teal-400',
  questioning: 'bg-sky-400',
  closing: 'bg-stone-400',
  other: 'bg-amber-400',
} as const

function jump(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/**
 * Two-level jump list, and — on the admin side — the structure editing panel.
 *
 * Everything here is DERIVED from the section list, so after any drag / add /
 * delete the refetched data re-renders this: phases regroup, ranges update, and
 * a link scrolls to the section's CURRENT position because the anchor id is the
 * section's stable uuid, not its position.
 */
export default function SectionNav({ groups, className, editing }: {
  groups: PhaseGroup<SectionLike>[]
  className?: string
  /** Omit for the public view — it renders as pure navigation. */
  editing?: {
    busy: boolean
    /** Split this section at its midpoint, then drag the new boundary precisely. */
    onAdd: (sectionId: string) => void
    /** Remove this boundary; the turns fold into the section above. */
    onDelete: (sectionId: string) => void
    /** First section in the transcript — not a boundary, cannot be deleted. */
    firstSectionId?: string
  }
}) {
  const [open, setOpen] = useState(true)
  if (!groups.length) return null
  const total = groups.reduce((n, g) => n + g.sections.length, 0)

  return (
    <nav className={cn('rounded-lg border border-gray-200 bg-white', className)} aria-label="Hearing sections">
      <button onClick={() => setOpen(v => !v)} className="w-full flex items-center gap-2 px-4 py-2.5 text-left">
        <span className="text-sm font-semibold text-slate-800">
          {editing ? 'Sections — jump & edit' : 'Jump to a section'}
        </span>
        <span className="text-xs text-gray-400">{groups.length} phases · {total} sections</span>
        <span className="ml-auto text-gray-400 text-xs">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => (
            <div key={g.anchorId}>
              <button
                onClick={() => jump(g.anchorId)}
                className="w-full flex items-center gap-2 text-left px-1.5 py-1 rounded hover:bg-slate-50"
              >
                <span className={cn('h-2 w-2 rounded-full shrink-0', DOT[g.phase] ?? DOT.other)} />
                <span className="text-xs font-bold uppercase tracking-wide text-slate-700">{g.label}</span>
                <span className="ml-auto text-[10px] text-gray-400 tabular-nums">{g.sections.length}</span>
              </button>
              <ul className="mt-0.5 ml-3 border-l border-gray-200">
                {g.sections.map((s, si) => {
                  const oneTurn = s.end_seq <= s.start_seq
                  const isFirst = editing?.firstSectionId === s.id
                  return (
                    <li key={s.id} className="group/sec flex items-center">
                      <button
                        onClick={() => jump(sectionAnchorId(s.id))}
                        title={`Turns ${s.start_seq}–${s.end_seq}`}
                        className="flex-1 min-w-0 text-left pl-2.5 pr-1 py-0.5 text-xs text-slate-600 hover:text-slate-900 hover:bg-slate-50 truncate"
                      >
                        {si + 1}. {sectionTitle(s)}
                        <span className="ml-1 text-[10px] text-gray-400 tabular-nums">{s.start_seq}–{s.end_seq}</span>
                      </button>
                      {editing && (
                        <span className="shrink-0 flex items-center opacity-0 group-hover/sec:opacity-100 focus-within:opacity-100 transition-opacity">
                          <button
                            onClick={() => editing.onAdd(s.id)}
                            disabled={editing.busy || oneTurn}
                            title={oneTurn
                              ? 'Only one turn — nothing to split'
                              : 'Add a section boundary inside this one (lands mid-section; drag its handle to the exact turn)'}
                            className="px-1 text-[11px] text-slate-400 hover:text-emerald-700 disabled:opacity-30 disabled:cursor-not-allowed"
                          >+</button>
                          <button
                            onClick={() => editing.onDelete(s.id)}
                            disabled={editing.busy || isFirst}
                            title={isFirst
                              ? 'The first section starts the transcript — it is not a boundary'
                              : 'Remove this boundary — its turns join the section above'}
                            className="px-1 text-[11px] text-slate-400 hover:text-red-700 disabled:opacity-30 disabled:cursor-not-allowed"
                          >×</button>
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </nav>
  )
}
