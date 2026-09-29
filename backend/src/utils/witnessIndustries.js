// The curated witness-industry vocabulary, backend copy.
//
// THREE PLACES HOLD THIS LIST, and the CHECK constraint is the authority:
//   1. backend/db/migrations/013_hearing_witnesses.sql  ← authority
//   2. this file            — validation, so a bad slug is a clean 400
//   3. frontend/src/utils/witnessIndustries.ts — dropdown + public group order
// Adding an industry means a new migration plus both mirrors.
//
// Order is the canonical PUBLIC group order, not alphabetical and not by count:
// a stable order means the same hearing reads the same way on every visit.
// 'other' is last by construction.
const WITNESS_INDUSTRIES = [
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
];

const INDUSTRY_SLUGS = new Set(WITNESS_INDUSTRIES.map((i) => i.slug));
const INDUSTRY_LABEL = new Map(WITNESS_INDUSTRIES.map((i) => [i.slug, i.label]));

function isIndustry(slug) {
  return INDUSTRY_SLUGS.has(slug);
}

/**
 * The heading a group renders under. A custom label only counts on 'other';
 * anywhere else it is ignored rather than trusted, so a stale industry_custom
 * can never retitle a real category.
 */
function industryLabel(slug, custom) {
  if (slug === 'other') {
    const trimmed = (custom || '').trim();
    if (trimmed) return trimmed;
  }
  return INDUSTRY_LABEL.get(slug) ?? 'Other';
}

module.exports = { WITNESS_INDUSTRIES, isIndustry, industryLabel };
