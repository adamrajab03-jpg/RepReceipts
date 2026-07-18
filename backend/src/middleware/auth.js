const db = require('../utils/db');
const {
  verifyAccessToken,
  signAccessToken,
  generateRefreshToken,
  hashToken,
  refreshExpiresAt,
  setAuthCookies,
  clearAuthCookies,
} = require('../utils/tokens');

async function requireAuth(req, res, next) {
  // ── 1. Try access token ────────────────────────────────────────────────────
  const rawAccess = req.cookies?.access_token;
  if (rawAccess) {
    try {
      const payload = verifyAccessToken(rawAccess);
      req.user = { id: payload.sub, handle: payload.handle };
      return next();
    } catch (err) {
      if (err.name !== 'TokenExpiredError') {
        return res.status(401).json({ error: 'Invalid token' });
      }
      // Expired — fall through to refresh
    }
  }

  // ── 2. Silent refresh with rotation ───────────────────────────────────────
  const rawRefresh = req.cookies?.refresh_token;
  if (!rawRefresh) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const { rows } = await db.query(`
      SELECT rt.id, rt.user_id, rt.expires_at, u.handle
      FROM   refresh_tokens rt
      JOIN   users u ON u.id = rt.user_id
      WHERE  rt.token_hash = $1
    `, [hashToken(rawRefresh)]);

    if (!rows.length || new Date(rows[0].expires_at) < new Date()) {
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Session expired — please log in again' });
    }

    const { id: tokenId, user_id, handle } = rows[0];

    // Rotate: overwrite stored hash + expiry with a brand-new token
    const newRaw    = generateRefreshToken();
    const newExpiry = refreshExpiresAt();
    await db.query(
      'UPDATE refresh_tokens SET token_hash = $1, expires_at = $2 WHERE id = $3',
      [hashToken(newRaw), newExpiry, tokenId]
    );

    const newAccess = signAccessToken({ sub: user_id, handle });
    setAuthCookies(res, newAccess, newRaw);

    req.user = { id: user_id, handle };
    return next();
  } catch (err) {
    console.error('requireAuth error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Best-effort auth for read endpoints: if a valid access token is present,
// attach req.user so the response can include the viewer's own vote/rating.
// Never blocks — anonymous and expired-token requests fall through cleanly,
// and (unlike requireAuth) it performs no refresh rotation, keeping reads
// free of side effects.
function optionalAuth(req, _res, next) {
  const rawAccess = req.cookies?.access_token;
  if (rawAccess) {
    try {
      const payload = verifyAccessToken(rawAccess);
      req.user = { id: payload.sub, handle: payload.handle };
    } catch {
      // invalid or expired — proceed anonymously
    }
  }
  return next();
}

// Admin gate: run requireAuth first (sets req.user, handles refresh), then
// confirm the account is an admin. is_admin is NOT in the JWT, so this is a
// fresh DB lookup — granting/revoking admin therefore takes effect immediately,
// not on next token refresh. requireAuth sends its own 401 on failure and never
// invokes the callback in that case, so the check below only runs when authed.
function requireAdmin(req, res, next) {
  requireAuth(req, res, async () => {
    try {
      const { rows } = await db.query('SELECT is_admin FROM users WHERE id = $1', [req.user.id]);
      if (!rows.length || !rows[0].is_admin) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      req.user.is_admin = true;
      return next();
    } catch (err) {
      console.error('requireAdmin error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}

module.exports = { requireAuth, optionalAuth, requireAdmin };
