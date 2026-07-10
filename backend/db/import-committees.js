/**
 * import-committees.js — load real committee rosters into Postgres.
 *
 * Additive & idempotent. Reads the committed slim snapshots (committees-current
 * .json, committee-memberships.json) plus legislators-current.json for member
 * bio detail, and for each committee on the ALLOWLIST:
 *   1. upserts the committee            (ON CONFLICT (thomas_id) DO UPDATE)
 *   2. upserts each member into members (ON CONFLICT (bioguide_id) DO UPDATE)
 *   3. refreshes that committee's rows in committee_memberships (delete-then-insert)
 *
 * It NEVER wipes `members` wholesale: the next slice writes real
 * speaker_turns.member_id attributions, and those must survive a re-run of this
 * importer when new committees are added to the allowlist. The one-time wipe of
 * the placeholder seed data lives in migration 007, not here.
 *
 * Run AFTER `npm run migrate` (007 adds committees.thomas_id and clears seeds):
 *     npm run import:committees
 *
 * To add a committee later: add its thomas_id to ALLOWLIST and re-run.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs   = require('fs');
const path = require('path');
const db   = require('../src/utils/db');

const DATA = path.join(__dirname, 'data');

// Committees we actually track. Start with the PoC hearing's committee; grow
// this list (and re-run) as more committees get ingested.
const ALLOWLIST = ['SSCM']; // Senate Commerce, Science, and Transportation

// 119th Congress (2025–2027). committee_memberships is unique per
// (member_id, committee_id, congress); the per-committee refresh below is
// scoped to this value.
const CONGRESS = 119;

// Non-voting House seats — delegates (DC + 5 territories) and PR's resident
// commissioner. They sit in the House chamber but are member_type 'delegate',
// not 'representative'. Everyone else in the House is a representative.
const DELEGATE_STATES = new Set(['DC', 'PR', 'GU', 'VI', 'AS', 'MP']);

// Read every snapshot as UTF-8 so accented names (e.g. "Ben Ray Luján") decode
// cleanly rather than mojibake.
function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));
}

// members.member_type is NOT NULL with a CHECK; derive it from the legislator's
// chamber (+ state for the delegate distinction).
function memberType(chamber, state) {
  if (chamber === 'senate') return 'senator';
  if (DELEGATE_STATES.has(state)) return 'delegate';
  return 'representative';
}

async function main() {
  const committees   = readJson('committees-current.json');
  const memberships  = readJson('committee-memberships.json');
  const legislators  = readJson('legislators-current.json');

  const committeeById = new Map(committees.map(c => [c.thomas_id, c]));
  const rosterById    = new Map(memberships.map(m => [m.thomas_id, m]));
  const legByBioguide = new Map(legislators.map(l => [l.bioguide, l]));

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const summaries = [];
    const skipped = [];

    for (const thomasId of ALLOWLIST) {
      const committee = committeeById.get(thomasId);
      const roster    = rosterById.get(thomasId);
      if (!committee) throw new Error(`Committee ${thomasId} not found in committees-current.json`);
      if (!roster)    throw new Error(`Committee ${thomasId} has no roster in committee-memberships.json`);

      // 1. Upsert the committee, keyed on the stable thomas_id.
      const { rows: cRows } = await client.query(
        `INSERT INTO committees (thomas_id, name, chamber)
         VALUES ($1, $2, $3)
         ON CONFLICT (thomas_id) DO UPDATE SET name = EXCLUDED.name, chamber = EXCLUDED.chamber
         RETURNING id`,
        [committee.thomas_id, committee.name, committee.chamber]
      );
      const committeeId = cRows[0].id;

      // 2. Upsert each member, joining bioguide → legislators-current for bio
      //    detail. Collect (member_id, role) for the membership refresh.
      const seats = [];
      for (const m of roster.members) {
        const leg = legByBioguide.get(m.bioguide);
        if (!leg) {
          // No current-roster match (e.g. a member who just left). Can't satisfy
          // members.member_type reliably, so record and skip rather than guess.
          skipped.push({ committee: thomasId, bioguide: m.bioguide, name: m.name });
          continue;
        }
        const { rows: mRows } = await client.query(
          `INSERT INTO members (bioguide_id, full_name, member_type, chamber, party, state, district)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (bioguide_id) DO UPDATE SET
             full_name   = EXCLUDED.full_name,
             member_type = EXCLUDED.member_type,
             chamber     = EXCLUDED.chamber,
             party       = EXCLUDED.party,
             state       = EXCLUDED.state,
             district    = EXCLUDED.district,
             is_current  = true
           RETURNING id`,
          [
            leg.bioguide,
            leg.full_name,
            memberType(leg.chamber, leg.state),
            leg.chamber,
            leg.party,
            leg.state,
            leg.district,
          ]
        );
        seats.push({ memberId: mRows[0].id, role: m.role, name: leg.full_name });
      }

      // 3. Refresh this committee's memberships — delete-then-insert, scoped to
      //    the committee, so the importer is idempotent and never disturbs other
      //    committees' rows.
      await client.query(
        `DELETE FROM committee_memberships WHERE committee_id = $1 AND congress = $2`,
        [committeeId, CONGRESS]
      );
      for (const s of seats) {
        await client.query(
          `INSERT INTO committee_memberships (member_id, committee_id, role, congress)
           VALUES ($1, $2, $3, $4)`,
          [s.memberId, committeeId, s.role, CONGRESS]
        );
      }

      const chair   = seats.find(s => s.role === 'chair');
      const ranking = seats.find(s => s.role === 'ranking_member');
      summaries.push({
        name:    committee.name,
        count:   seats.length,
        chair:   chair ? chair.name : '(none)',
        ranking: ranking ? ranking.name : '(none)',
      });
    }

    await client.query('COMMIT');

    console.log('Committee rosters imported.');
    for (const s of summaries) {
      console.log(`\n  ${s.name}`);
      console.log(`    members        : ${s.count}`);
      console.log(`    chair          : ${s.chair}`);
      console.log(`    ranking member : ${s.ranking}`);
    }
    if (skipped.length) {
      console.log(`\n  Skipped ${skipped.length} member(s) with no current-roster match:`);
      for (const s of skipped) console.log(`    ${s.committee}: ${s.name} (${s.bioguide})`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Committee import failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.end();
  }
}

main();
