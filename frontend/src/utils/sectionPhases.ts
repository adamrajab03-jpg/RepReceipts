// ============================================================================
//  Two-level section display — PURELY DERIVED, no data model behind it.
// ----------------------------------------------------------------------------
//  hearing_sections is a flat list, each row carrying a `type`. The big "phase"
//  headers are computed at render time by grouping CONSECUTIVE sections whose
//  types map to the same phase. There is no phase table, no nesting column and
//  no parent id — regroup differently and nothing in the database changes.
//
//  Shared by the admin review workbench and the public transcript page so both
//  group identically.
// ============================================================================
import type { SectionType } from '../types/api'

export type Phase = 'opening' | 'questioning' | 'closing' | 'other'

/** Which big header a section type sits under. */
export const PHASE_OF: Record<SectionType, Phase> = {
  chair_opening: 'opening',
  ranking_opening: 'opening',
  witness_statement: 'opening',
  questioning: 'questioning',
  closing: 'closing',
  unassigned: 'other',
}

export const PHASE_LABEL: Record<Phase, string> = {
  opening: 'Opening Statements',
  questioning: 'Questioning',
  closing: 'Closing',
  other: 'Unassigned',
}

/** The minimum a section must expose to be grouped — both payloads satisfy it. */
export interface SectionLike {
  id: string
  type: SectionType
  label: string | null
  member_full_name?: string | null
  start_seq: number
  end_seq: number
}

export interface PhaseGroup<S extends SectionLike = SectionLike> {
  phase: Phase
  label: string
  /** DOM id used as the scroll target for this phase. */
  anchorId: string
  sections: S[]
  start_seq: number
  end_seq: number
}

export const sectionAnchorId = (sectionId: string) => `section-${sectionId}`
export const phaseAnchorId = (index: number) => `phase-${index}`

/** A section's display name, falling back to its type when unlabelled. */
export function sectionTitle(s: SectionLike): string {
  if (s.label) return s.label
  if (s.member_full_name) return s.member_full_name
  switch (s.type) {
    case 'chair_opening': return 'Chair — opening statement'
    case 'ranking_opening': return 'Ranking member — opening statement'
    case 'witness_statement': return 'Witness statement'
    case 'closing': return 'Closing'
    case 'unassigned': return 'Unassigned'
    default: return 'Questioning'
  }
}

/**
 * Group CONSECUTIVE same-phase sections. A run of questioning rounds becomes one
 * "Questioning" group; an opening block that is interrupted and resumes later
 * correctly becomes two groups, because only adjacency is considered.
 */
export function groupIntoPhases<S extends SectionLike>(
  sections: S[],
  { includeUnassigned = true }: { includeUnassigned?: boolean } = {},
): PhaseGroup<S>[] {
  const visible = includeUnassigned ? sections : sections.filter(s => PHASE_OF[s.type] !== 'other')
  const ordered = [...visible].sort((a, b) => a.start_seq - b.start_seq)
  const groups: PhaseGroup<S>[] = []
  for (const s of ordered) {
    const phase = PHASE_OF[s.type] ?? 'other'
    const last = groups[groups.length - 1]
    if (last && last.phase === phase) {
      last.sections.push(s)
      last.end_seq = Math.max(last.end_seq, s.end_seq)
      continue
    }
    groups.push({
      phase,
      label: PHASE_LABEL[phase],
      anchorId: phaseAnchorId(groups.length),
      sections: [s],
      start_seq: s.start_seq,
      end_seq: s.end_seq,
    })
  }
  return groups
}

export interface HeaderSlot<S extends SectionLike> {
  /** Present when this section also opens a new phase. */
  phase?: PhaseGroup<S>
  section: S
}

/**
 * Decide which headers render above which turn.
 *
 * Anchoring is by SEQ RANGE, not by matching a section's anchor turn id: the
 * public transcript hides blank turns, so a section anchored on one would
 * otherwise lose its header entirely. Each section attaches to the first
 * VISIBLE turn at or after its start.
 */
export function layoutHeaders<S extends SectionLike, T extends { id: string; seq: number }>(
  turns: T[],
  sections: S[],
  opts: { includeUnassigned?: boolean } = {},
): Map<string, HeaderSlot<S>[]> {
  const groups = groupIntoPhases(sections, opts)
  const phaseOfSection = new Map<string, PhaseGroup<S>>()
  for (const g of groups) phaseOfSection.set(g.sections[0].id, g)

  const out = new Map<string, HeaderSlot<S>[]>()
  const ordered = groups.flatMap(g => g.sections).sort((a, b) => a.start_seq - b.start_seq)
  let ti = 0
  for (const s of ordered) {
    while (ti < turns.length && turns[ti].seq < s.start_seq) ti++
    const turn = turns[ti]
    if (!turn) break // section starts past the last visible turn
    const slots = out.get(turn.id) ?? []
    slots.push({ phase: phaseOfSection.get(s.id), section: s })
    out.set(turn.id, slots)
  }
  return out
}
