const { z } = require('zod');
const db = require('../utils/db');

// Exactly one of member_id / topic_id, mirroring the follows CHECK constraint.
const followSchema = z.object({
  member_id: z.string().uuid().optional(),
  topic_id:  z.string().uuid().optional(),
}).refine(
  d => (d.member_id ? 1 : 0) + (d.topic_id ? 1 : 0) === 1,
  { message: 'Provide exactly one of member_id or topic_id' }
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
    // ON CONFLICT infers the matching partial unique index
    // (uq_follow_member / uq_follow_topic), so re-following is a no-op.
    if (member_id) {
      await db.query(`
        INSERT INTO follows (user_id, member_id) VALUES ($1, $2)
        ON CONFLICT (user_id, member_id) WHERE member_id IS NOT NULL DO NOTHING
      `, [userId, member_id]);
    } else {
      await db.query(`
        INSERT INTO follows (user_id, topic_id) VALUES ($1, $2)
        ON CONFLICT (user_id, topic_id) WHERE topic_id IS NOT NULL DO NOTHING
      `, [userId, topic_id]);
    }
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
async function unfollow(req, res) {
  const { type, id } = req.params;
  if (type !== 'member' && type !== 'topic') {
    return res.status(400).json({ error: 'type must be member or topic' });
  }
  const column = type === 'member' ? 'member_id' : 'topic_id';
  const userId = req.user.id;

  try {
    await db.query(
      `DELETE FROM follows WHERE user_id = $1 AND ${column} = $2`,
      [userId, id]
    );
    return res.json({ data: { [column]: id, following: false } });
  } catch (err) {
    console.error('unfollow error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Current user's follows ────────────────────────────────────────────────────
async function listFollows(req, res) {
  const userId = req.user.id;
  try {
    const { rows: members } = await db.query(`
      SELECT m.id, m.full_name, m.party, m.state, m.chamber
      FROM   follows f
      JOIN   members m ON m.id = f.member_id
      WHERE  f.user_id = $1 AND f.member_id IS NOT NULL
      ORDER  BY m.full_name
    `, [userId]);

    const { rows: topics } = await db.query(`
      SELECT t.id, t.slug, t.name
      FROM   follows f
      JOIN   topics t ON t.id = f.topic_id
      WHERE  f.user_id = $1 AND f.topic_id IS NOT NULL
      ORDER  BY t.name
    `, [userId]);

    return res.json({ data: { members, topics } });
  } catch (err) {
    console.error('listFollows error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { follow, unfollow, listFollows };
