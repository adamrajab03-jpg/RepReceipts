// How a member is named and tinted on the PUBLIC reading pages. Shared so the
// context header and the speaker labels inside the transcript can never drift
// apart — the same person must read identically in the header and in the turn.

/** "Sen." / "Rep." from the member's chamber — hearings store no title. */
export function chamberTitle(chamber: string | null): string | null {
  if (chamber === 'senate') return 'Sen.'
  if (chamber === 'house') return 'Rep.'
  return null
}

/** "Sen. Ted Cruz", or just the name when the chamber is unknown. */
export function memberLabel(fullName: string, chamber: string | null): string {
  const title = chamberTitle(chamber)
  return title ? `${title} ${fullName}` : fullName
}

/** "R-TX" / "D" / null — party first, state only when we have it. */
export function partyStateLabel(party: string | null, state: string | null): string | null {
  if (!party) return null
  return state ? `${party}-${state}` : party
}

// Party shows as a letter in a restrained tint: enough to read the room at a
// glance, not enough to colour the page. Full literal class strings so Tailwind
// keeps them. Unknown/independent party gets no tint rather than a made-up one.
const PARTY_PILL: Record<string, string> = {
  D: 'text-blue-700 bg-blue-50 ring-blue-100',
  R: 'text-red-700 bg-red-50 ring-red-100',
}

const PARTY_TEXT: Record<string, string> = {
  D: 'text-blue-700',
  R: 'text-red-700',
}

/** The tinted pill used beside a speaker label. Null = render no pill. */
export function partyPillClass(party: string | null): string | null {
  return (party && PARTY_PILL[party]) ?? null
}

/** Bare coloured text, for chips that already carry their own border. */
export function partyTextClass(party: string | null): string {
  return (party && PARTY_TEXT[party]) ?? 'text-slate-500'
}

/** Roster role as a reader-facing label; plain members get none. */
export function committeeRoleLabel(role: string | null): string | null {
  if (role === 'chair') return 'Chair'
  if (role === 'ranking_member') return 'Ranking member'
  return null
}
