const db = require('../utils/db');

// States/territories whose House seat is a non-voting delegate / resident
// commissioner and which have NO U.S. Senators.
const NON_VOTING = new Set(['DC', 'AS', 'GU', 'MP', 'PR', 'VI']);

// GET /api/lookup/reps?zip=NNNNN
// Resolves a ZIP to its congressional district(s) and returns the 2 senators +
// House rep(s). A ZIP straddling districts yields multiple House reps; DC and the
// territories have no senators (House delegate only). Each resolved person is
// LEFT JOINed to our `members` roster: if we track them, member_id is their
// profile id; otherwise in_system=false with the real name/party/state/district.
async function lookupReps(req, res) {
  const zip = String(req.query.zip ?? '').trim();
  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: 'Enter a valid 5-digit ZIP code.' });
  }

  try {
    const { rows: districts } = await db.query(
      `SELECT DISTINCT state, district FROM zip_districts WHERE zip = $1 ORDER BY state, district`,
      [zip]
    );

    if (!districts.length) {
      return res.status(404).json({
        error: `We couldn't find a congressional district for ZIP ${zip}. ` +
               `It may be a PO-box-only ZIP with no mapped area.`,
      });
    }

    const states  = [...new Set(districts.map(d => d.state))];
    const dStates = districts.map(d => d.state);
    const dNums   = districts.map(d => d.district);

    // Senators: every senator for the ZIP's state(s). Empty for DC/territories.
    const { rows: senate } = await db.query(`
      SELECT lc.bioguide_id, lc.full_name, lc.party, lc.state, lc.district, lc.chamber,
             m.id AS member_id
      FROM   legislators_current lc
      LEFT   JOIN members m ON m.bioguide_id = lc.bioguide_id
      WHERE  lc.chamber = 'senate' AND lc.state = ANY($1::text[])
      ORDER  BY lc.state, lc.full_name
    `, [states]);

    // House: the rep for each (state, district) the ZIP touches.
    const { rows: house } = await db.query(`
      SELECT lc.bioguide_id, lc.full_name, lc.party, lc.state, lc.district, lc.chamber,
             m.id AS member_id
      FROM   legislators_current lc
      LEFT   JOIN members m ON m.bioguide_id = lc.bioguide_id
      JOIN   unnest($1::text[], $2::int[]) AS d(state, district)
             ON d.state = lc.state AND d.district = lc.district
      WHERE  lc.chamber = 'house'
      ORDER  BY lc.state, lc.district
    `, [dStates, dNums]);

    const shape = r => ({
      bioguide_id: r.bioguide_id,
      full_name:   r.full_name,
      party:       r.party,
      state:       r.state,
      district:    r.district,
      chamber:     r.chamber,
      member_id:   r.member_id,           // uuid when in our system, else null
      in_system:   r.member_id != null,
      is_delegate: r.chamber === 'house' && NON_VOTING.has(r.state),
    });

    return res.json({
      data: {
        zip,
        districts: districts.map(d => ({ state: d.state, district: d.district })),
        senate:    senate.map(shape),
        house:     house.map(shape),
      },
    });
  } catch (err) {
    console.error('lookupReps error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { lookupReps };
