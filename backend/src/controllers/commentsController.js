const { z } = require('zod');
const db = require('../utils/db');

// ── Zod schemas ───────────────────────────────────────────────────────────────
const commentSchema = z.object({
  body:      z.string().min(1, 'Comment cannot be empty').max(10000, 'Comment too long'),
  parent_id: z.string().uuid().optional(),
  quote: z.object({
    char_start:  z.number().int().min(0),
    char_end:    z.number().int().min(1),
    quoted_text: z.string().min(1, 'Quoted text cannot be empty'),
  }).optional(),
});

const voteSchema = z.object({
  value: z.union([z.literal(1), z.literal(-1)]),
});

// ── Shared list query ─────────────────────────────────────────────────────────
async function queryComments(whereClause, params, res) {
  try {
    const { rows } = await db.query(`
      SELECT
        c.id, c.user_id, c.parent_id, c.turn_id, c.hearing_id,
        CASE WHEN c.is_deleted THEN '[deleted]' ELSE c.body END AS body,
        c.score, c.is_deleted, c.created_at,
        u.handle   AS author_handle,
        cq.char_start, cq.char_end, cq.quoted_text,
        cv.value   AS user_vote
      FROM   comments c
      LEFT JOIN users          u  ON u.id  = c.user_id
      LEFT JOIN comment_quotes cq ON cq.comment_id = c.id
      LEFT JOIN comment_votes  cv ON cv.comment_id = c.id AND cv.user_id = $2
      WHERE  ${whereClause}
      ORDER BY c.score DESC, c.created_at ASC
    `, params);
    return res.json({ data: rows, count: rows.length });
  } catch (err) {
    console.error('listComments error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function listTurnComments(req, res) {
  const userId = req.user?.id ?? null;
  return queryComments('c.turn_id = $1', [req.params.id, userId], res);
}

async function listHearingComments(req, res) {
  const userId = req.user?.id ?? null;
  return queryComments('c.hearing_id = $1 AND c.turn_id IS NULL', [req.params.id, userId], res);
}

// ── Shared create (turn or hearing) ──────────────────────────────────────────
async function createComment(isTurn, targetId, req, res) {
  const parsed = commentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { body, parent_id = null, quote } = parsed.data;

  if (quote && !isTurn) {
    return res.status(400).json({ error: 'Quotes can only be attached to speaker-turn comments' });
  }
  if (quote && quote.char_end <= quote.char_start) {
    return res.status(400).json({ error: 'char_end must be greater than char_start' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(`
      INSERT INTO comments (user_id, turn_id, hearing_id, parent_id, body)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, user_id, turn_id, hearing_id, parent_id, body, score, is_deleted, created_at
    `, [
      req.user.id,
      isTurn    ? targetId : null,
      isTurn    ? null     : targetId,
      parent_id,
      body,
    ]);
    const comment = rows[0];

    let quoteData = null;
    if (quote) {
      await client.query(`
        INSERT INTO comment_quotes (comment_id, turn_id, char_start, char_end, quoted_text)
        VALUES ($1, $2, $3, $4, $5)
      `, [comment.id, targetId, quote.char_start, quote.char_end, quote.quoted_text]);
      quoteData = { char_start: quote.char_start, char_end: quote.char_end, quoted_text: quote.quoted_text };
    }

    await client.query('COMMIT');

    return res.status(201).json({
      data: {
        ...comment,
        author_handle: req.user.handle,
        ...quoteData,
        char_start:  quoteData?.char_start  ?? null,
        char_end:    quoteData?.char_end    ?? null,
        quoted_text: quoteData?.quoted_text ?? null,
        user_vote: null,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('createComment error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

async function createTurnComment(req, res) {
  return createComment(true, req.params.id, req, res);
}

async function createHearingComment(req, res) {
  return createComment(false, req.params.id, req, res);
}

// ── Vote upsert (transactional) ───────────────────────────────────────────────
async function voteComment(req, res) {
  const parsed = voteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { value } = parsed.data;
  const { id: commentId } = req.params;
  const userId = req.user.id;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock the existing vote row (prevents concurrent updates)
    const { rows: existing } = await client.query(
      'SELECT id, value FROM comment_votes WHERE user_id = $1 AND comment_id = $2 FOR UPDATE',
      [userId, commentId]
    );

    let userVote   = null;
    let scoreDelta = 0;

    if (!existing.length) {
      // No existing vote → create
      await client.query(
        'INSERT INTO comment_votes (user_id, comment_id, value) VALUES ($1, $2, $3)',
        [userId, commentId, value]
      );
      scoreDelta = value;
      userVote   = value;
    } else if (existing[0].value === value) {
      // Same vote → cancel (toggle off)
      await client.query(
        'DELETE FROM comment_votes WHERE user_id = $1 AND comment_id = $2',
        [userId, commentId]
      );
      scoreDelta = -value;
      userVote   = null;
    } else {
      // Opposite vote → flip
      await client.query(
        'UPDATE comment_votes SET value = $3, created_at = now() WHERE user_id = $1 AND comment_id = $2',
        [userId, commentId, value]
      );
      scoreDelta = value - existing[0].value;  // e.g. +1 - (-1) = +2
      userVote   = value;
    }

    const { rows: updated } = await client.query(
      'UPDATE comments SET score = score + $1 WHERE id = $2 RETURNING score',
      [scoreDelta, commentId]
    );

    if (!updated.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Comment not found' });
    }

    await client.query('COMMIT');

    return res.json({
      data: { comment_id: commentId, score: updated[0].score, user_vote: userVote },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('voteComment error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

// ── Soft delete (author or admin) ─────────────────────────────────────────────
async function deleteComment(req, res) {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    const { rows } = await db.query(
      'SELECT user_id, is_deleted FROM comments WHERE id = $1',
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    const comment = rows[0];

    if (comment.is_deleted) {
      return res.json({ data: { id, is_deleted: true } });
    }

    const { rows: userRows } = await db.query(
      'SELECT is_admin FROM users WHERE id = $1',
      [userId]
    );
    const isAdmin = userRows[0]?.is_admin === true;

    if (comment.user_id !== userId && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await db.query('UPDATE comments SET is_deleted = true WHERE id = $1', [id]);
    return res.json({ data: { id, is_deleted: true } });
  } catch (err) {
    console.error('deleteComment error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  listTurnComments, listHearingComments,
  createTurnComment, createHearingComment,
  voteComment, deleteComment,
};
