const { z } = require('zod');
const db = require('../utils/db');
const {
  signAccessToken,
  generateRefreshToken,
  hashToken,
  refreshExpiresAt,
  setAuthCookies,
  clearAuthCookies,
} = require('../utils/tokens');

// ── Password hasher: argon2id preferred, bcryptjs as pure-JS fallback ────────
let hasher;
try {
  const argon2 = require('argon2');
  hasher = {
    hash:   (pw)       => argon2.hash(pw, { type: argon2.argon2id }),
    verify: (hash, pw) => argon2.verify(hash, pw),
  };
} catch {
  const bcrypt = require('bcryptjs');
  hasher = {
    hash:   (pw)       => bcrypt.hash(pw, 12),
    verify: (hash, pw) => bcrypt.compare(pw, hash),
  };
}

// ── Zod schemas ───────────────────────────────────────────────────────────────
const registerSchema = z.object({
  handle: z.string()
    .min(3,  'Handle must be at least 3 characters')
    .max(30, 'Handle must be at most 30 characters')
    .regex(/^[a-zA-Z0-9_]+$/, 'Handle may only contain letters, numbers, and underscores'),
  email:    z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const loginSchema = z.object({
  email:    z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

// ── Helper: create a session (refresh token row + cookies) ───────────────────
async function issueSession(res, userId, handle) {
  const rawRefresh = generateRefreshToken();
  await db.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, hashToken(rawRefresh), refreshExpiresAt()]
  );
  setAuthCookies(res, signAccessToken({ sub: userId, handle }), rawRefresh);
}

// ── Controllers ──────────────────────────────────────────────────────────────
async function register(req, res) {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { handle, email, password } = parsed.data;

  try {
    const { rows: emailRows } = await db.query(
      'SELECT id FROM users WHERE email = $1', [email]
    );
    if (emailRows.length) return res.status(409).json({ error: 'Email already registered' });

    const { rows: handleRows } = await db.query(
      'SELECT id FROM users WHERE handle = $1', [handle]
    );
    if (handleRows.length) return res.status(409).json({ error: 'Handle already taken' });

    const hash = await hasher.hash(password);
    const { rows } = await db.query(
      `INSERT INTO users (handle, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, handle, email, is_admin`,
      [handle, email, hash]
    );
    const user = rows[0];
    await issueSession(res, user.id, user.handle);
    return res.status(201).json({ user: { id: user.id, handle: user.handle, email: user.email, is_admin: user.is_admin } });
  } catch (err) {
    console.error('register error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function login(req, res) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { email, password } = parsed.data;

  try {
    const { rows } = await db.query(
      'SELECT id, handle, email, password_hash, is_admin FROM users WHERE email = $1',
      [email]
    );
    const user = rows[0];

    if (!user) {
      // Run a dummy hash to keep response time constant and prevent user enumeration
      await hasher.hash('dummy-timing-equaliser');
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await hasher.verify(user.password_hash, password);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    await issueSession(res, user.id, user.handle);
    return res.json({ user: { id: user.id, handle: user.handle, email: user.email, is_admin: user.is_admin } });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function logout(req, res) {
  const rawRefresh = req.cookies?.refresh_token;
  if (rawRefresh) {
    await db.query(
      'DELETE FROM refresh_tokens WHERE token_hash = $1',
      [hashToken(rawRefresh)]
    ).catch(() => {}); // best-effort; don't block the response
  }
  clearAuthCookies(res);
  return res.json({ ok: true });
}

async function me(req, res) {
  try {
    const { rows } = await db.query(
      'SELECT id, handle, email, is_admin, email_verified, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    return res.json({ user: rows[0] });
  } catch (err) {
    console.error('me error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { register, login, logout, me };
