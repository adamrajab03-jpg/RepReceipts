const db = require('../utils/db');

// ── Generation: called from the comment-create transaction (turn comments) ────
// Creates one in-app notification per user who follows the turn's member OR a
// topic tagged on that turn, excluding the comment's author. Runs on the caller's
// transaction client so it commits/rolls back atomically with the comment.
async function createCommentNotifications(client, { commentId, turnId, authorId }) {
  // Resolve the turn's member, position, and hearing for the link + display text.
  const { rows } = await client.query(`
    SELECT st.seq, st.member_id, tr.hearing_id, m.full_name AS member_name
    FROM   speaker_turns st
    JOIN   transcripts   tr ON tr.id = st.transcript_id
    LEFT JOIN members     m ON m.id = st.member_id
    WHERE  st.id = $1
  `, [turnId]);
  if (!rows.length) return;

  const { seq, member_id, hearing_id, member_name } = rows[0];

  const payload = {
    kind: 'comment',
    text: `New comment on ${member_name ? `${member_name}'s` : 'a'} remarks`,
    link: `/hearings/${hearing_id}#turn-${seq}`,
    comment_id: commentId,
    hearing_id,
  };

  await client.query(`
    INSERT INTO notifications (user_id, channel, status, sent_at, payload)
    SELECT DISTINCT f.user_id, 'in_app', 'sent', now(), $1::jsonb
    FROM   follows f
    WHERE  f.user_id <> $2
      AND (
        f.member_id = $3
        OR f.topic_id IN (SELECT tt.topic_id FROM turn_topics tt WHERE tt.turn_id = $4)
      )
  `, [JSON.stringify(payload), authorId, member_id, turnId]);
}

// ── Feed (newest first) ───────────────────────────────────────────────────────
async function listNotifications(req, res) {
  try {
    const { rows } = await db.query(`
      SELECT id, payload, read_at, created_at
      FROM   notifications
      WHERE  user_id = $1 AND channel = 'in_app'
      ORDER  BY created_at DESC
      LIMIT  100
    `, [req.user.id]);
    return res.json({ data: rows, count: rows.length });
  } catch (err) {
    console.error('listNotifications error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Unread count (badge) ──────────────────────────────────────────────────────
async function unreadCount(req, res) {
  try {
    const { rows } = await db.query(`
      SELECT count(*)::int AS count
      FROM   notifications
      WHERE  user_id = $1 AND channel = 'in_app' AND read_at IS NULL
    `, [req.user.id]);
    return res.json({ count: rows[0].count });
  } catch (err) {
    console.error('unreadCount error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Mark one read (owner-scoped) ──────────────────────────────────────────────
async function markRead(req, res) {
  try {
    const { rows } = await db.query(`
      UPDATE notifications SET read_at = now()
      WHERE  id = $1 AND user_id = $2 AND read_at IS NULL
      RETURNING id
    `, [req.params.id, req.user.id]);
    // Idempotent: already-read or not-found both resolve to read state.
    return res.json({ data: { id: req.params.id, read: true } });
  } catch (err) {
    console.error('markRead error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Mark all read ─────────────────────────────────────────────────────────────
async function markAllRead(req, res) {
  try {
    await db.query(`
      UPDATE notifications SET read_at = now()
      WHERE  user_id = $1 AND channel = 'in_app' AND read_at IS NULL
    `, [req.user.id]);
    return res.json({ data: { read: true } });
  } catch (err) {
    console.error('markAllRead error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  createCommentNotifications,
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
};
