const { z } = require('zod');
const db = require('../utils/db');

// topic_id null/absent = overall rating of the member; otherwise scoped to a topic.
const ratingSchema = z.object({
  value:    z.union([z.literal(1), z.literal(-1)]),
  topic_id: z.string().uuid().nullable().optional(),
});

// approval % = thumbs-up share of cast ratings; null when nobody has rated.
const percentExpr = `
  CASE WHEN count(*) = 0 THEN NULL
       ELSE round(
         100.0 * count(*) FILTER (WHERE value = 1) / count(*)
       )::int
  END`;

// ── Read: overall + per-topic approval for one member ─────────────────────────
async function getMemberApproval(req, res) {
  const memberId = req.params.id;
  const userId   = req.user?.id ?? null;

  try {
    const { rows: memberRows } = await db.query(
      'SELECT 1 FROM members WHERE id = $1', [memberId]
    );
    if (!memberRows.length) return res.status(404).json({ error: 'Member not found' });

    // Overall (topic_id IS NULL). IS NOT DISTINCT FROM lets a NULL $2 (anonymous
    // viewer) match no row rather than erroring on `user_id = NULL`.
    const { rows: overallRows } = await db.query(`
      SELECT
        count(*) FILTER (WHERE value = 1)::int  AS up,
        count(*) FILTER (WHERE value = -1)::int AS down,
        count(*)::int                           AS total,
        ${percentExpr}                          AS percent,
        max(value) FILTER (WHERE user_id IS NOT DISTINCT FROM $2) AS user_vote
      FROM approval_ratings
      WHERE member_id = $1 AND topic_id IS NULL
    `, [memberId, userId]);

    const overall = {
      topic_id: null, slug: null, name: null, parent_id: null, parent_name: null,
      ...overallRows[0],
    };

    // Per-topic: only topics this member has actually been rated on.
    const { rows: topics } = await db.query(`
      SELECT
        t.id        AS topic_id,
        t.slug, t.name, t.parent_id,
        p.name      AS parent_name,
        count(ar.*) FILTER (WHERE ar.value = 1)::int  AS up,
        count(ar.*) FILTER (WHERE ar.value = -1)::int AS down,
        count(ar.*)::int                              AS total,
        CASE WHEN count(ar.*) = 0 THEN NULL
             ELSE round(100.0 * count(ar.*) FILTER (WHERE ar.value = 1) / count(ar.*))::int
        END AS percent,
        max(ar.value) FILTER (WHERE ar.user_id IS NOT DISTINCT FROM $2) AS user_vote
      FROM   approval_ratings ar
      JOIN   topics t ON t.id = ar.topic_id
      LEFT JOIN topics p ON p.id = t.parent_id
      WHERE  ar.member_id = $1
      GROUP BY t.id, p.name
      ORDER BY percent DESC NULLS LAST, t.name
    `, [memberId, userId]);

    res.json({ data: { overall, topics } });
  } catch (err) {
    console.error('getMemberApproval error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Write: toggle the viewer's rating for a member (overall or per-topic) ──────
async function setMemberApproval(req, res) {
  const parsed = ratingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const memberId = req.params.id;
  const userId   = req.user.id;
  const { value, topic_id = null } = parsed.data;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock the viewer's existing rating for this scope. IS NOT DISTINCT FROM
    // matches the NULL topic_id (overall) the same way the partial unique
    // indexes uq_approval_member_overall / _topic do.
    const { rows: existing } = await client.query(`
      SELECT id, value FROM approval_ratings
      WHERE user_id = $1 AND member_id = $2 AND topic_id IS NOT DISTINCT FROM $3
      FOR UPDATE
    `, [userId, memberId, topic_id]);

    let userVote;
    if (!existing.length) {
      await client.query(`
        INSERT INTO approval_ratings (user_id, member_id, topic_id, value)
        VALUES ($1, $2, $3, $4)
      `, [userId, memberId, topic_id, value]);
      userVote = value;
    } else if (existing[0].value === value) {
      // Same thumb again → clear the rating (toggle off).
      await client.query('DELETE FROM approval_ratings WHERE id = $1', [existing[0].id]);
      userVote = null;
    } else {
      await client.query('UPDATE approval_ratings SET value = $2 WHERE id = $1',
        [existing[0].id, value]);
      userVote = value;
    }

    // Recompute the scope aggregate so the client can update in place.
    const { rows: agg } = await client.query(`
      SELECT
        count(*) FILTER (WHERE value = 1)::int  AS up,
        count(*) FILTER (WHERE value = -1)::int AS down,
        count(*)::int                           AS total,
        ${percentExpr}                          AS percent
      FROM approval_ratings
      WHERE member_id = $1 AND topic_id IS NOT DISTINCT FROM $2
    `, [memberId, topic_id]);

    await client.query('COMMIT');
    res.json({ data: { topic_id, ...agg[0], user_vote: userVote } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23503') {                       // FK violation
      return res.status(404).json({ error: 'Member or topic not found' });
    }
    console.error('setMemberApproval error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

// ── Read: cross-member heat map (members × topics aggregate approval %) ───────
async function getHeatmap(_req, res) {
  try {
    const { rows } = await db.query(`
      SELECT
        m.id   AS member_id, m.full_name, m.party,
        t.id   AS topic_id,  t.slug, t.name AS topic_name,
        count(*) FILTER (WHERE ar.value = 1)::int  AS up,
        count(*) FILTER (WHERE ar.value = -1)::int AS down,
        count(*)::int                              AS total,
        round(100.0 * count(*) FILTER (WHERE ar.value = 1) / count(*))::int AS percent
      FROM   approval_ratings ar
      JOIN   members m ON m.id = ar.member_id
      JOIN   topics  t ON t.id = ar.topic_id
      WHERE  ar.topic_id IS NOT NULL
      GROUP BY m.id, t.id
    `);

    // Build the two axes (rows = members, columns = topics) from the rated cells.
    const members = new Map();
    const topics  = new Map();
    const cells   = [];
    for (const r of rows) {
      if (!members.has(r.member_id)) {
        members.set(r.member_id, { id: r.member_id, full_name: r.full_name, party: r.party });
      }
      if (!topics.has(r.topic_id)) {
        topics.set(r.topic_id, { id: r.topic_id, slug: r.slug, name: r.topic_name });
      }
      cells.push({
        member_id: r.member_id, topic_id: r.topic_id,
        up: r.up, down: r.down, total: r.total, percent: r.percent,
      });
    }

    res.json({
      data: {
        members: [...members.values()].sort((a, b) => a.full_name.localeCompare(b.full_name)),
        topics:  [...topics.values()].sort((a, b) => a.name.localeCompare(b.name)),
        cells,
      },
    });
  } catch (err) {
    console.error('getHeatmap error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { getMemberApproval, setMemberApproval, getHeatmap };
