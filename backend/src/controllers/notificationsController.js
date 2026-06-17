const db = require('../utils/db');

// ════════════════════════════════════════════════════════════════════════════
//  PART 2 — Activity-based notifications
//  Fired when congressional activity ENTERS the system (a hearing is published,
//  a turn is added, or topics get tagged on a turn) — NOT when users comment.
//  There's no ingestion pipeline yet, so these helpers are called from whatever
//  code path inserts a hearing/turn. When real ingestion is built, it calls the
//  same helpers. Both run on the caller's transaction client.
// ════════════════════════════════════════════════════════════════════════════

// Notify followers for a single turn's activity. Matches three follow shapes:
//   * rep+topic — the followed rep speaks in this turn AND a tag of this turn is
//                 the followed topic (BOTH must match)
//   * rep-only  — the followed rep speaks in this turn
//   * topic-only — a tag of this turn is the followed topic
//
// Dedup (most-specific wins, per turn): if a user gets a rep+topic notification
// for this turn, their rep-only and topic-only notifications for the same turn
// are suppressed. rep-only and topic-only do NOT suppress each other — those are
// two independent signals the user opted into separately.
//
// `actorId` is the user who caused the event, excluded defensively. For real
// system ingestion it's null (no actor), so the exclusion is a no-op.
async function notifyTurnActivity(client, { turnId, actorId = null }) {
  // Resolve the turn's member, position, hearing, and tagged topics.
  const { rows } = await client.query(`
    SELECT st.seq, st.member_id, tr.hearing_id, m.full_name AS member_name,
           COALESCE(
             array_agg(tt.topic_id) FILTER (WHERE tt.topic_id IS NOT NULL),
             '{}'
           ) AS topic_ids
    FROM   speaker_turns st
    JOIN   transcripts   tr ON tr.id = st.transcript_id
    LEFT JOIN members     m ON m.id = st.member_id
    LEFT JOIN turn_topics tt ON tt.turn_id = st.id
    WHERE  st.id = $1
    GROUP  BY st.seq, st.member_id, tr.hearing_id, m.full_name
  `, [turnId]);
  if (!rows.length) return;

  const { seq, member_id, hearing_id, member_name, topic_ids } = rows[0];
  const link = `/hearings/${hearing_id}#turn-${seq}`;
  const who  = member_name || 'A representative';

  // One CTE chain so the dedup is a single atomic statement. rep_topic inserts
  // first and RETURNs its recipients; rep_only and topic_only then exclude them.
  await client.query(`
    WITH rep_topic AS (
      INSERT INTO notifications (user_id, channel, status, sent_at, payload)
      SELECT DISTINCT ON (f.user_id)
             f.user_id, 'in_app', 'sent', now(),
             jsonb_build_object(
               'kind',       'rep_topic_activity',
               'text',       $2 || ' spoke on a topic you follow',
               'link',       $3,
               'hearing_id', $4::uuid,
               'member_id',  $5::uuid,
               'topic_id',   f.topic_id
             )
      FROM   follows f
      WHERE  f.member_id = $5::uuid
        AND  f.topic_id IS NOT NULL
        AND  f.topic_id = ANY($6::uuid[])
        AND  ($7::uuid IS NULL OR f.user_id <> $7::uuid)
      ORDER  BY f.user_id
      RETURNING user_id
    ),
    rep_only AS (
      INSERT INTO notifications (user_id, channel, status, sent_at, payload)
      SELECT f.user_id, 'in_app', 'sent', now(),
             jsonb_build_object(
               'kind',       'rep_activity',
               'text',       $2 || ' spoke in a new hearing',
               'link',       $3,
               'hearing_id', $4::uuid,
               'member_id',  $5::uuid
             )
      FROM   follows f
      WHERE  f.member_id = $5::uuid
        AND  f.topic_id IS NULL
        AND  ($7::uuid IS NULL OR f.user_id <> $7::uuid)
        AND  f.user_id NOT IN (SELECT user_id FROM rep_topic)
      RETURNING user_id
    )
    INSERT INTO notifications (user_id, channel, status, sent_at, payload)
    SELECT DISTINCT ON (f.user_id)
           f.user_id, 'in_app', 'sent', now(),
           jsonb_build_object(
             'kind',       'topic_activity',
             'text',       'New activity on a topic you follow',
             'link',       $3,
             'hearing_id', $4::uuid,
             'topic_id',   f.topic_id
           )
    FROM   follows f
    WHERE  f.member_id IS NULL
      AND  f.topic_id = ANY($6::uuid[])
      AND  ($7::uuid IS NULL OR f.user_id <> $7::uuid)
      AND  f.user_id NOT IN (SELECT user_id FROM rep_topic)
    ORDER  BY f.user_id
  `, [turnId, who, link, hearing_id, member_id, topic_ids, actorId]);
}

// Notify for a whole hearing being published: fan out across every turn. When
// the ingestion pipeline lands it can call this once after inserting a hearing
// and its turns. Per-turn dedup applies; a user following a rep who speaks in
// several turns of the hearing will get one notification per matching turn.
async function notifyHearingActivity(client, { hearingId, actorId = null }) {
  const { rows } = await client.query(`
    SELECT st.id
    FROM   speaker_turns st
    JOIN   transcripts   tr ON tr.id = st.transcript_id
    WHERE  tr.hearing_id = $1
    ORDER  BY st.seq
  `, [hearingId]);

  for (const { id } of rows) {
    await notifyTurnActivity(client, { turnId: id, actorId });
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  PART 3 — Reply and @mention notifications
//  Fired on comment creation, with the correct semantics (replaces the old
//  follower-fanout createCommentNotifications hook).
// ════════════════════════════════════════════════════════════════════════════

// Word-boundary @handle matcher. Handle charset mirrors registration
// (authController): [A-Za-z0-9_], 3–30 chars. The lookbehind/lookahead exclude
// handle chars so "email@bob" or "a@bob" never match, but "@bob" and "@@bob" do.
const MENTION_RE = /(?<![A-Za-z0-9_])@([A-Za-z0-9_]{3,30})(?![A-Za-z0-9_])/g;
const MAX_MENTIONS = 20;

// Returns de-duped, lowercased handles mentioned in `body` (case-insensitive),
// capped to keep one comment from fanning out unboundedly.
function parseMentions(body) {
  const handles = new Set();
  for (const m of body.matchAll(MENTION_RE)) {
    handles.add(m[1].toLowerCase());
    if (handles.size >= MAX_MENTIONS) break;
  }
  return [...handles];
}

async function createReplyAndMentionNotifications(
  client,
  { commentId, hearingId, turnId, turnSeq, authorId, authorHandle, body, parentId }
) {
  // Turn comments anchor to the turn; hearing-level comments to the hearing.
  const link = turnId != null
    ? `/hearings/${hearingId}#turn-${turnSeq}`
    : `/hearings/${hearingId}`;

  // ── Reply: notify the parent comment's author (skip self-reply) ─────────────
  if (parentId) {
    await client.query(`
      INSERT INTO notifications (user_id, channel, status, sent_at, payload)
      SELECT parent.user_id, 'in_app', 'sent', now(),
             jsonb_build_object(
               'kind',       'reply',
               'text',       $1 || ' replied to your comment',
               'link',       $2,
               'hearing_id', $3::uuid,
               'comment_id', $4::uuid
             )
      FROM   comments parent
      WHERE  parent.id = $5::uuid
        AND  parent.user_id IS NOT NULL
        AND  parent.user_id <> $6::uuid
    `, [authorHandle, link, hearingId, commentId, parentId, authorId]);
  }

  // ── @mention: notify each real mentioned user (skip self, de-duped) ─────────
  const handles = parseMentions(body).filter(h => h !== authorHandle.toLowerCase());
  if (handles.length) {
    await client.query(`
      INSERT INTO notifications (user_id, channel, status, sent_at, payload)
      SELECT u.id, 'in_app', 'sent', now(),
             jsonb_build_object(
               'kind',       'mention',
               'text',       $1 || ' mentioned you in a comment',
               'link',       $2,
               'hearing_id', $3::uuid,
               'comment_id', $4::uuid
             )
      FROM   users u
      WHERE  lower(u.handle) = ANY($5::text[])
        AND  u.id <> $6::uuid
    `, [authorHandle, link, hearingId, commentId, handles, authorId]);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Feed read/state endpoints (unchanged)
// ════════════════════════════════════════════════════════════════════════════

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
    await db.query(`
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
  notifyTurnActivity,
  notifyHearingActivity,
  createReplyAndMentionNotifications,
  parseMentions,
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
};
