/**
 * import-civic-data.js — load the committed civic snapshots into Postgres.
 *
 * Reads the slim snapshots in db/data/ (produced by build-civic-snapshots.js)
 * and replaces the contents of legislators_current + zip_districts. Pure derived
 * data, so it's a full TRUNCATE + reload — safe and idempotent to re-run.
 *
 * Run AFTER `npm run migrate` (migration 005 creates the tables):
 *     npm run import:civic
 *
 * Needs no network and no YAML parser — just the two committed snapshot files.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs   = require('fs');
const path = require('path');
const db   = require('../src/utils/db');

const DATA = path.join(__dirname, 'data');

function loadLegislators() {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'legislators-current.json'), 'utf8'));
  // Map snapshot keys → table columns (bioguide → bioguide_id).
  return raw.map(l => ({
    bioguide_id: l.bioguide,
    full_name:   l.full_name,
    party:       l.party,
    chamber:     l.chamber,
    state:       l.state,
    district:    l.district,
  }));
}

function loadZipDistricts() {
  const lines = fs.readFileSync(path.join(DATA, 'zip-districts.csv'), 'utf8').trim().split(/\r?\n/);
  return lines.slice(1).map(line => {
    const [zip, state, district] = line.split(',');
    return { zip, state, district: parseInt(district, 10) };
  });
}

// Multi-row INSERT in chunks (one statement per chunk keeps the parameter count
// well under Postgres' 65535-bound; ~6 cols × 1000 rows = 6000 params).
async function bulkInsert(client, table, cols, rows, chunkSize = 1000) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const valuesSql = [];
    const params = [];
    chunk.forEach((row, r) => {
      const placeholders = cols.map((_, c) => `$${r * cols.length + c + 1}`);
      valuesSql.push(`(${placeholders.join(', ')})`);
      params.push(...cols.map(c => row[c]));
    });
    await client.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${valuesSql.join(', ')} ON CONFLICT DO NOTHING`,
      params
    );
  }
}

async function main() {
  const legislators = loadLegislators();
  const zips = loadZipDistricts();

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE legislators_current');
    await client.query('TRUNCATE zip_districts');

    await bulkInsert(client, 'legislators_current',
      ['bioguide_id', 'full_name', 'party', 'chamber', 'state', 'district'], legislators);
    await bulkInsert(client, 'zip_districts',
      ['zip', 'state', 'district'], zips);

    const { rows: lc } = await client.query('SELECT count(*)::int AS n FROM legislators_current');
    const { rows: zc } = await client.query('SELECT count(*)::int AS n, count(DISTINCT zip)::int AS z FROM zip_districts');

    await client.query('COMMIT');

    console.log('Civic data imported.');
    console.log(`  legislators_current  ${lc[0].n} rows`);
    console.log(`  zip_districts        ${zc[0].n} rows across ${zc[0].z} unique ZIPs`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Import failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.end();
  }
}

main();
