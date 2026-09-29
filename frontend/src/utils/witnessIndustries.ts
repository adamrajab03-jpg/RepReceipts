// The curated witness-industry vocabulary, frontend copy.
//
// THREE PLACES HOLD THIS LIST, and the CHECK constraint is the authority:
//   1. backend/db/migrations/013_hearing_witnesses.sql  ← authority
//   2. backend/src/utils/witnessIndustries.js — validation (clean 400, not 23514)
//   3. this file — the admin dropdown and the PUBLIC group order
// Adding an industry means a new migration plus both mirrors.

export type IndustrySlug =
  | 'media' | 'technology' | 'academia_legal' | 'government'
  | 'advocacy_nonprofit' | 'finance' | 'energy' | 'healthcare'
  | 'labor' | 'other'

/**
 * Canonical order — this is also the order industry groups appear on the public
 * page. Deliberately NOT alphabetical and NOT by witness count: a fixed order
 * means the same hearing reads the same way on every visit, and 'other' (plus
 * every custom label under it) is always last.
 */
export const WITNESS_INDUSTRIES: { slug: IndustrySlug; label: string }[] = [
  { slug: 'media',              label: 'Media' },
  { slug: 'technology',         label: 'Technology' },
  { slug: 'academia_legal',     label: 'Academia / Legal' },
  { slug: 'government',         label: 'Government' },
  { slug: 'advocacy_nonprofit', label: 'Advocacy / Nonprofit' },
  { slug: 'finance',            label: 'Finance' },
  { slug: 'energy',             label: 'Energy' },
  { slug: 'healthcare',         label: 'Healthcare' },
  { slug: 'labor',              label: 'Labor' },
  { slug: 'other',              label: 'Other' },
]

const RANK = new Map(WITNESS_INDUSTRIES.map((i, n) => [i.slug, n]))

/** Sort rank for a group. Anything unrecognised sorts with 'other', at the end. */
export function industryRank(slug: string | null): number {
  const fallback = RANK.get('other')!
  if (!slug) return fallback
  // `?? fallback`, not `|| fallback` — 'media' ranks 0, which is falsy.
  return RANK.get(slug as IndustrySlug) ?? fallback
}

export function industryLabel(slug: IndustrySlug): string {
  return WITNESS_INDUSTRIES.find((i) => i.slug === slug)?.label ?? 'Other'
}
