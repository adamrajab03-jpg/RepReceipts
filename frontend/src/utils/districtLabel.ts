// States/territories with a non-voting House delegate (no senators; district 0).
const NON_VOTING = new Set(['DC', 'AS', 'GU', 'MP', 'PR', 'VI'])

/**
 * Returns the short tag appended after the state abbreviation, or null when
 * nothing should be shown (senators, and delegates where a number adds no info).
 *   regular House → "12"
 *   at-large state → "AL"
 *   delegate/territory → null  (just show the state)
 *   senator → null
 */
export function districtTag(state: string, district: number | null): string | null {
  if (district === null) return null
  if (district === 0) return NON_VOTING.has(state) ? null : 'AL'
  return String(district)
}

/**
 * Full role label for a resolved rep in the lookup results. Uses is_delegate
 * (from the API) when available instead of inferring from state.
 */
export function repRoleLabel(opts: {
  chamber: 'house' | 'senate'
  state: string
  district: number | null
  is_delegate: boolean
}): string {
  const { chamber, state, district, is_delegate } = opts
  if (chamber === 'senate') return `U.S. Senator · ${state}`
  if (is_delegate) {
    const title = state === 'PR' ? 'Resident Commissioner' : 'Delegate'
    return `${title} · ${state}`
  }
  const tag = districtTag(state, district)
  return tag ? `U.S. Representative · ${state}-${tag}` : `U.S. Representative · ${state}`
}
