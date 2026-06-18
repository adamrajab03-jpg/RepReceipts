# Civic lookup data (ZIP → your representatives)

Two committed **slim snapshots**, loaded into Postgres by
[`../import-civic-data.js`](../import-civic-data.js) for `GET /api/lookup/reps`:

| File | Rows | Shape |
|---|---|---|
| `legislators-current.json` | ~537 | `{ bioguide, full_name, party, chamber, state, district }` |
| `zip-districts.csv` | ~39k | `zip,state,district` (one row per ZIP×district) |

`district` is `null` for senators and `0` for at-large representatives and
non-voting delegates (DC + the five territories).

## Sources

These slim files are **derived** from two authoritative upstream datasets by
[`../build-civic-snapshots.js`](../build-civic-snapshots.js). The raw downloads
live in `raw/` (gitignored — multi-MB) and are not needed to run the importer.

1. **Current legislators** — `unitedstates/congress-legislators` (canonical
   civic-tech roster, public domain):
   https://raw.githubusercontent.com/unitedstates/congress-legislators/main/legislators-current.yaml

2. **ZIP → congressional district** — U.S. Census Bureau 2020 ZCTA5 ↔
   Congressional District relationship file:
   https://www2.census.gov/geo/docs/maps-data/data/rel2020/cd-sld/tab20_cd11820_zcta520_natl.txt

## Vintage & known limitations

- **District boundaries are 118th-Congress.** That is the most recent ZCTA↔CD
  crosswalk the Census publishes (no `cd119` ZCTA file exists yet). 119th-Congress
  boundaries are identical except for a few mid-decade court-ordered remaps
  (e.g. AL, GA, LA, NY, NC). **Legislator names are current** (reflect the 2024
  elections), matched to those districts by `(state, district)`.
- **PO-box-only ZIPs don't resolve.** ZIPs that exist only as USPS delivery
  routes (no Census ZCTA, e.g. `30301`) have no district and return no match —
  the endpoint treats this as "ZIP not found".
- **Split ZIPs return multiple House reps.** A ZIP straddling districts (e.g.
  `90210` → CA-32 + CA-36) yields all candidates; tiny boundary slivers
  (<1% of the ZIP's land) are dropped during the build.

## Regenerating the snapshots

```sh
# 1. Re-download the two raw sources into db/data/raw/ (URLs above).
# 2. Rebuild the slim snapshots (needs the js-yaml devDependency):
npm run build:civic-snapshots
# 3. Reload Postgres:
npm run import:civic
```
