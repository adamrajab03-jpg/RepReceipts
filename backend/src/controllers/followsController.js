const { z } = require('zod');
const db = require('../utils/db');

// At least one of member_id / topic_id, mirroring the follows_target_check
// constraint. The three valid shapes are { member_id }, { topic_id }, and
// { member_id, topic_id }.
const followSchema = z.object({
  member_id: z.string().uuid().optional(),
  topic_id:  z.string().uuid().optional(),
}).refine(
  d => !!d.member_id || !!d.topic_id,
  { message: 'Provide member_id, topic_id, or both' }
);

// ── Follow (idempotent) ───────────────────────────────────────────────────────
async function follow(req, res) {
  const parsed = followSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { member_id = null, topic_id = null } = parsed.data;
  const userId = req.user.id;

  try {
    // No conflict target: a bare ON CONFLICT DO NOTHING lets Postgres match
    // whichever of the three partial unique indexes applies to this shape, so
    // re-following any shape is a no-op.
    await db.query(`
      INSERT INTO follows (user_id, member_id, topic_id) VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
    `, [userId, member_id, topic_id]);
    return res.status(201).json({ data: { member_id, topic_id, following: true } });
  } catch (err) {
    if (err.code === '23503') {          // FK violation — target doesn't exist
      return res.status(404).json({ error: 'Member or topic not found' });
    }
    console.error('follow error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Unfollow ──────────────────────────────────────────────────────────────────
// Takes the same body shapes as follow (DELETE /api/follows). The WHERE clause
// targets the exact shape so unfollowing a rep+topic doesn't touch a bare rep
// follow for the same member (and vice versa).
async function unfollow(req, res) {
  const parsed = followSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { member_id = null, topic_id = null } = parsed.data;
  const userId = req.user.id;

  let where, params;
  if (member_id && topic_id) {
    where  = 'member_id = $2 AND topic_id = $3';
    params = [userId, member_id, topic_id];
  } else if (member_id) {
    where  = 'member_id = $2 AND topic_id IS NULL';
    params = [userId, member_id];
  } else {
    where  = 'topic_id = $2 AND member_id IS NULL';
    params = [userId, topic_id];
  }

  try {
    await db.query(`DELETE FROM follows WHERE user_id = $1 AND ${where}`, params);
    return res.json({ data: { member_id, topic_id, following: false } });
  } catch (err) {
    console.error('unfollow error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Current user's follows (three groups) ─────────────────────────────────────
async function listFollows(req, res) {
  const userId = req.user.id;
  try {
    const { rows: members } = await db.query(`
      SELECT m.id, m.full_name, m.party, m.state, m.chamber
      FROM   follows f
      JOIN   members m ON m.id = f.member_id
      WHERE  f.user_id = $1 AND f.member_id IS NOT NULL AND f.topic_id IS NULL
      ORDER  BY m.full_name
    `, [userId]);

    const { rows: topics } = await db.query(`
      SELECT t.id, t.slug, t.name
      FROM   follows f
      JOIN   topics t ON t.id = f.topic_id
      WHERE  f.user_id = $1 AND f.topic_id IS NOT NULL AND f.member_id IS NULL
      ORDER  BY t.name
    `, [userId]);

    const { rows: repTopics } = await db.query(`
      SELECT m.id AS member_id, m.full_name AS member_full_name, m.party, m.state,
             t.id AS topic_id,  t.slug AS topic_slug, t.name AS topic_name
      FROM   follows f
      JOIN   members m ON m.id = f.member_id
      JOIN   topics  t ON t.id = f.topic_id
      WHERE  f.user_id = $1 AND f.member_id IS NOT NULL AND f.topic_id IS NOT NULL
      ORDER  BY m.full_name, t.name
    `, [userId]);

    return res.json({ data: { members, topics, repTopics } });
  } catch (err) {
    console.error('listFollows error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { follow, unfollow, listFollows };
