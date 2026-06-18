/**
 * build-civic-snapshots.js — regenerate the committed civic-data snapshots.
 *
 * Transforms the two raw upstream datasets (kept in db/data/raw/, gitignored)
 * into slim, purpose-built snapshots that ARE committed and that the importer
 * (import-civic-data.js) loads into Postgres:
 *
 *   db/data/legislators-current.json   slim: bioguide, name, party, chamber, state, district
 *   db/data/zip-districts.csv          slim: zip, state, district  (one row per ZIP×district)
 *
 * ── Sources (download into db/data/raw/ before running; see db/data/README.md) ──
 *   legislators-current.yaml
 *     https://raw.githubusercontent.com/unitedstates/congress-legislators/main/legislators-current.yaml
 *     Canonical civic-tech roster. The LAST entry in each member's `terms[]` is
 *     their current seat (type sen/rep, state, district, party).
 *
 *   tab20_cd11820_zcta520_natl.txt
 *     https://www2.census.gov/geo/docs/maps-data/data/rel2020/cd-sld/tab20_cd11820_zcta520_natl.txt
 *     Census 2020 ZCTA5 ↔ Congressional District relationship file. Vintage is
 *     the 118th Congress — the most recent ZCTA↔CD crosswalk Census publishes
 *     (no cd119 ZCTA file exists yet). 119th-Congress boundaries are identical
 *     except for a handful of mid-decade court-ordered remaps; documented in
 *     README. Pipe-delimited; GEOID_CD118_20 = stateFIPS(2)+district(2),
 *     GEOID_ZCTA5_20 = the ZIP. A ZIP split across districts appears as multiple
 *     rows; AREALAND_PART is the land area of that ZIP×district sliver.
 *
 * This is a maintenance/refresh tool (needs the js-yaml devDependency), NOT part
 * of the request-time path. Run it only when refreshing the snapshots.
 */
const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const RAW  = path.join(__dirname, 'data', 'raw');
const OUT  = path.join(__dirname, 'data');

// A ZIP×district sliver below this share of the ZIP's total land is treated as a
// boundary-digitization artifact and dropped — but the largest district for a
// ZIP is always kept. Real splits run ~10–90%; artifacts are <0.1%.
const MIN_SHARE = 0.01;

// State/territory FIPS → USPS abbreviation. Covers the 50 states, DC, and the
// five territories that have a House delegate / resident commissioner.
const FIPS_TO_STATE = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO',
  '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI',
  '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY',
  '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
  '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH',
  '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
  '54': 'WV', '55': 'WI', '56': 'WY',
  '60': 'AS', '66': 'GU', '69': 'MP', '72': 'PR', '78': 'VI',
};

const PARTY_LETTER = { Democrat: 'D', Republican: 'R', Independent: 'I', Libertarian: 'L' };

// ── 1. Legislators YAML → slim JSON ──────────────────────────────────────────
function buildLegislators() {
  const src = yaml.load(fs.readFileSync(path.join(RAW, 'legislators-current.yaml'), 'utf8'));
  const out = [];
  for (const m of src) {
    const term = m.terms[m.terms.length - 1];          // last term = current seat
    if (!term) continue;
    const chamber = term.type === 'sen' ? 'senate' : 'house';
    out.push({
      bioguide:  m.id.bioguide,
      full_name: m.name.official_full || `${m.name.first} ${m.name.last}`.trim(),
      party:     PARTY_LETTER[term.party] || (term.party ? term.party[0] : null),
      chamber,
      state:     term.state,
      // Senators have no district; at-large reps & delegates are district 0.
      district:  chamber === 'senate' ? null : (term.district ?? 0),
    });
  }
  out.sort((a, b) =>
    a.state.localeCompare(b.state) || a.chamber.localeCompare(b.chamber) ||
    (a.district ?? -1) - (b.district ?? -1) || a.full_name.localeCompare(b.full_name));
  fs.writeFileSync(path.join(OUT, 'legislators-current.json'), JSON.stringify(out, null, 2) + '\n');
  return out;
}

// ── 2. Census ZCTA↔CD relationship → slim ZIP→district CSV ────────────────────
function buildZipDistricts() {
  const lines = fs.readFileSync(path.join(RAW, 'tab20_cd11820_zcta520_natl.txt'), 'utf8').split(/\r?\n/);
  const header = lines[0].split('|');
  const iCd   = header.indexOf('GEOID_CD118_20');
  const iZcta = header.indexOf('GEOID_ZCTA5_20');
  const iLand = header.indexOf('AREALAND_PART');
  if (iCd < 0 || iZcta < 0 || iLand < 0) throw new Error('Census file: unexpected columns');

  // zip -> Map(districtKey -> { state, district, land })
  const byZip = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = lines[i].split('|');
    const zcta = f[iZcta];
    if (!zcta) continue;                                // CD-summary row, no ZCTA

    const cd = f[iCd];                                  // e.g. '0101' = FIPS 01, dist 01
    const state = FIPS_TO_STATE[cd.slice(0, 2)];
    if (!state) continue;
    const dStr = cd.slice(2);
    // '00' at-large, '98' non-voting delegate territory → district 0; skip junk.
    const district = (dStr === '00' || dStr === '98') ? 0 : parseInt(dStr, 10);
    if (Number.isNaN(district)) continue;
    const land = parseInt(f[iLand], 10) || 0;

    if (!byZip.has(zcta)) byZip.set(zcta, new Map());
    const key = `${state}-${district}`;
    const prev = byZip.get(zcta).get(key);
    if (prev) prev.land += land;
    else byZip.get(zcta).set(key, { state, district, land });
  }

  const rows = [];
  for (const [zip, dists] of byZip) {
    const entries = [...dists.values()];
    const total = entries.reduce((s, e) => s + e.land, 0);
    const maxLand = Math.max(...entries.map(e => e.land));
    for (const e of entries) {
      // Keep meaningful overlaps; always keep the dominant district even if total is 0.
      if (e.land === maxLand || (total > 0 && e.land / total >= MIN_SHARE)) {
        rows.push({ zip, state: e.state, district: e.district });
      }
    }
  }
  rows.sort((a, b) => a.zip.localeCompare(b.zip) || a.state.localeCompare(b.state) || a.district - b.district);

  const csv = 'zip,state,district\n' + rows.map(r => `${r.zip},${r.state},${r.district}`).join('\n') + '\n';
  fs.writeFileSync(path.join(OUT, 'zip-districts.csv'), csv);
  return rows;
}

const legislators = buildLegislators();
const zipRows = buildZipDistricts();

const senators = legislators.filter(l => l.chamber === 'senate').length;
const reps     = legislators.filter(l => l.chamber === 'house').length;
const splitZips = new Set();
const seen = new Set();
for (const r of zipRows) { if (seen.has(r.zip)) splitZips.add(r.zip); seen.add(r.zip); }

console.log('Snapshots written to db/data/:');
console.log(`  legislators-current.json  ${legislators.length} members (${senators} senate, ${reps} house)`);
console.log(`  zip-districts.csv         ${zipRows.length} rows, ${seen.size} unique ZIPs (${splitZips.size} split across districts)`);
