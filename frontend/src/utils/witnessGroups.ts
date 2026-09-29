import type { HearingWitness } from '../types/api'
import { industryRank } from './witnessIndustries'

// Pure derivation of the public witness tree: flat list → industry → organization.
// Kept out of the component so the tiering rules — which case-fold, which sort
// last, when a group is suppressed — are testable without a DOM.

/**
 * A witness we have a record for groups under their industry. One we DON'T still
 * belongs on the page (they spoke), so they collect in a trailing group that
 * claims nothing about them rather than being filed under "Other" — which would
 * assert a category no one picked. The leading space keeps this key from ever
 * colliding with a real case-folded industry label.
 */
const UNCATEGORISED = ' also-spoke'

export interface OrgGroup {
  /** Null for witnesses with no organization recorded. */
  org: string | null
  witnesses: HearingWitness[]
}

export interface IndustryGroup {
  key: string
  label: string
  rank: number
  orgs: OrgGroup[]
}

/**
 * True when the grouped section should render at all. The context header hides
 * its own compact witness row on exactly this condition, so the two can never
 * both list witnesses.
 */
export function shouldGroupWitnesses(witnesses: HearingWitness[]): boolean {
  return witnesses.some((w) => w.has_record && !!w.industry)
}

/**
 * Both tiers bucket case-insensitively but display the FIRST spelling seen, so a
 * custom industry typed "crypto" once and "Crypto" later is one group, as is an
 * organization entered inconsistently. Within every group the API's order (the
 * admin's display_order, else order of first speaking) is preserved.
 */
export function groupWitnesses(witnesses: HearingWitness[]): IndustryGroup[] {
  const industries = new Map<string, IndustryGroup>()

  for (const w of witnesses) {
    const categorised = w.has_record && !!w.industry
    const label = categorised ? (w.industry_label ?? 'Other') : 'Also spoke'
    const key = categorised ? label.trim().toLowerCase() : UNCATEGORISED

    let g = industries.get(key)
    if (!g) {
      g = {
        key,
        label,
        // Uncategorised always last; otherwise the vocabulary's canonical order.
        rank: categorised ? industryRank(w.industry) : Number.MAX_SAFE_INTEGER,
        orgs: [],
      }
      industries.set(key, g)
    }

    const orgName = w.organization?.trim() || null
    const orgKey = orgName?.toLowerCase() ?? ''
    // A blank organization gets its own unlabelled bucket rather than being
    // merged into whichever org happens to sort first.
    let og = g.orgs.find((o) => (o.org?.toLowerCase() ?? '') === orgKey)
    if (!og) {
      og = { org: orgName, witnesses: [] }
      g.orgs.push(og)
    }
    og.witnesses.push(w)
  }

  // The unlabelled org bucket trails the named ones inside each industry.
  for (const g of industries.values()) {
    g.orgs.sort((a, b) => Number(a.org === null) - Number(b.org === null))
  }

  return [...industries.values()].sort((a, b) => a.rank - b.rank)
}
