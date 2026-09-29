import { useMemo } from 'react'
import type { HearingWitness } from '../types/api'
import { groupWitnesses, shouldGroupWitnesses, type OrgGroup } from '../utils/witnessGroups'

/**
 * WHO TESTIFIED, and whose interest they represent.
 *
 * Grouped industry → organization → witness, because the second tier is often
 * the story: "The Federalist — CEO" and "Public Knowledge — President" tell a
 * reader more about a moderation hearing than three bare names do. This is
 * chrome, so it is entirely sans-serif.
 *
 * Every tier is DERIVED at render time from the flat list the API returns (see
 * utils/witnessGroups), so re-categorising a witness in the admin editor changes
 * what readers see with no migration — the same discipline as the outline.
 *
 * Renders nothing until at least one witness has an admin-entered record; a
 * hearing nobody has filled in falls back to the compact name row in
 * HearingContextHeader instead.
 */

/** Name + title. Links to the witness's first turn when they actually spoke. */
function WitnessName({ witness: w }: { witness: HearingWitness }) {
  const name = w.turn_count > 0 && w.first_seq != null ? (
    <a
      href={`#turn-${w.first_seq}`}
      title={`Jump to their first turn (${w.turn_count} in this hearing)`}
      className="font-semibold text-slate-900 underline decoration-slate-300 decoration-1 underline-offset-[3px] transition-colors hover:decoration-slate-900"
    >
      {w.name}
    </a>
  ) : (
    <span className="font-semibold text-slate-900">{w.name}</span>
  )

  return (
    <>
      {name}
      {w.title && <span className="text-slate-500">, {w.title}</span>}
    </>
  )
}

/**
 * One organization. A single witness reads inline — "The Federalist — Sean Davis,
 * CEO & Cofounder" — which is how a witness list is normally written. Two or more
 * get the organization on its own line with the people indented beneath, rather
 * than repeating the organization on every row.
 */
function Organization({ group: og }: { group: OrgGroup }) {
  if (og.witnesses.length === 1) {
    return (
      <li className="text-[13px] leading-relaxed">
        {og.org && <span className="text-slate-500">{og.org} — </span>}
        <WitnessName witness={og.witnesses[0]} />
      </li>
    )
  }

  return (
    <li className="text-[13px] leading-relaxed">
      {og.org && <span className="block text-slate-500">{og.org}</span>}
      <ul className={og.org ? 'ml-3' : undefined}>
        {og.witnesses.map((w) => (
          <li key={w.name}><WitnessName witness={w} /></li>
        ))}
      </ul>
    </li>
  )
}

export default function HearingWitnesses({ witnesses }: { witnesses: HearingWitness[] }) {
  const groups = useMemo(() => groupWitnesses(witnesses), [witnesses])
  if (!shouldGroupWitnesses(witnesses)) return null

  return (
    <section className="mb-6 rounded-lg border border-gray-200 bg-white px-6 py-5">
      <h2 className="mb-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        Witnesses
      </h2>

      {/* Columns so three witnesses read as a tight strip and ten don't become a
          screen-tall single column. Each industry is its own grid cell, so no
          break-inside handling is needed. */}
      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
        {groups.map((g) => (
          <div key={g.key}>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-400">
              {g.label}
            </h3>
            <ul className="space-y-1.5">
              {g.orgs.map((og) => (
                <Organization key={og.org ?? ''} group={og} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
