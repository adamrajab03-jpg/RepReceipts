const db = require('../utils/db');

async function listHearings(req, res) {
  try {
    const { committee_id, status, congress } = req.query;

    const conditions = [];
    const params = [];

    if (committee_id) {
      params.push(committee_id);
      conditions.push(`h.committee_id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`h.status = $${params.length}`);
    }
    if (congress) {
      params.push(parseInt(congress, 10));
      conditions.push(`h.congress = $${params.length}`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT
        h.id, h.title, h.congress, h.held_on, h.status,
        h.video_url, h.video_source, h.official_url, h.created_at,
        c.id   AS committee_id,
        c.name AS committee_name,
        c.chamber AS committee_chamber
      FROM hearings h
      LEFT JOIN committees c ON c.id = h.committee_id
      ${where}
      ORDER BY h.held_on DESC NULLS LAST
    `, params);

    res.json({ data: rows, count: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function getHearing(req, res) {
  try {
    const { rows } = await db.query(`
      SELECT
        h.id, h.title, h.congress, h.held_on, h.status,
        h.video_url, h.video_source, h.official_url,
        h.created_at, h.updated_at,
        c.id   AS committee_id,
        c.name AS committee_name,
        c.chamber AS committee_chamber,
        COALESCE(
          json_agg(json_build_object(
            'id',         t.id,
            'source',     t.source,
            'is_primary', t.is_primary,
            'status',     t.status,
            'created_at', t.created_at
          )) FILTER (WHERE t.id IS NOT NULL),
          '[]'
        ) AS transcripts
      FROM hearings h
      LEFT JOIN committees c ON c.id = h.committee_id
      LEFT JOIN transcripts t ON t.hearing_id = h.id
      WHERE h.id = $1
      GROUP BY h.id, c.id
    `, [req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'Hearing not found' });
    res.json({ data: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { listHearings, getHearing };
