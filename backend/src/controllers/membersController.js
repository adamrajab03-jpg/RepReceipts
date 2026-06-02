const db = require('../utils/db');

async function listMembers(req, res) {
  try {
    const { chamber, party, state, search, is_current = 'true' } = req.query;

    const conditions = [];
    const params = [];

    if (is_current !== 'all') {
      params.push(is_current !== 'false');
      conditions.push(`m.is_current = $${params.length}`);
    }
    if (chamber) {
      params.push(chamber);
      conditions.push(`m.chamber = $${params.length}`);
    }
    if (party) {
      params.push(party);
      conditions.push(`m.party = $${params.length}`);
    }
    if (state) {
      params.push(state.toUpperCase());
      conditions.push(`m.state = $${params.length}`);
    }
    if (search) {
      params.push(search);
      conditions.push(`m.full_name ILIKE '%' || $${params.length} || '%'`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT
        m.id, m.bioguide_id, m.full_name, m.member_type,
        m.chamber, m.party, m.state, m.district, m.is_current,
        m.created_at,
        COALESCE(
          json_agg(json_build_object(
            'committee_id',   cm.committee_id,
            'committee_name', c.name,
            'role',           cm.role,
            'congress',       cm.congress
          )) FILTER (WHERE cm.id IS NOT NULL),
          '[]'
        ) AS committees
      FROM members m
      LEFT JOIN committee_memberships cm ON cm.member_id = m.id
      LEFT JOIN committees c ON c.id = cm.committee_id
      ${where}
      GROUP BY m.id
      ORDER BY m.full_name
    `, params);

    res.json({ data: rows, count: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function getMember(req, res) {
  try {
    const { rows } = await db.query(`
      SELECT
        m.id, m.bioguide_id, m.full_name, m.member_type,
        m.chamber, m.party, m.state, m.district, m.is_current,
        m.external_ids, m.created_at, m.updated_at,
        COALESCE(
          json_agg(json_build_object(
            'committee_id',   cm.committee_id,
            'committee_name', c.name,
            'role',           cm.role,
            'congress',       cm.congress
          )) FILTER (WHERE cm.id IS NOT NULL),
          '[]'
        ) AS committees
      FROM members m
      LEFT JOIN committee_memberships cm ON cm.member_id = m.id
      LEFT JOIN committees c ON c.id = cm.committee_id
      WHERE m.id = $1
      GROUP BY m.id
    `, [req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'Member not found' });
    res.json({ data: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { listMembers, getMember };
