const express     = require('express');
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');

const membersRouter  = require('./routes/members');
const hearingsRouter = require('./routes/hearings');
const authRouter     = require('./routes/auth');
const turnsRouter    = require('./routes/turns');
const commentsRouter = require('./routes/comments');
const topicsRouter   = require('./routes/topics');
const approvalRouter = require('./routes/approval');
const followsRouter  = require('./routes/follows');
const notificationsRouter = require('./routes/notifications');
const lookupRouter   = require('./routes/lookup');
const adminRouter    = require('./routes/admin');

// ── CSRF (double-submit signed cookie, SameSite=Strict is primary defence) ───
const {
  invalidCsrfTokenError,
  generateCsrfToken,
  doubleCsrfProtection,
} = doubleCsrf({
  getSecret: () => process.env.CSRF_SECRET,
  // Bind the token to the current session (access_token cookie).
  // Empty string for unauthenticated requests; frontend re-fetches after login/logout.
  getSessionIdentifier: (req) => req.cookies?.access_token ?? '',
  cookieName: 'csrf_token',
  cookieOptions: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
  },
  size: 64,
  getTokenFromRequest: (req) => req.headers['x-csrf-token'],
});

const app = express();

app.use(cookieParser());
app.use(express.json());
app.use(doubleCsrfProtection);

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Issue a CSRF token; call this once on app load before any state-changing request
app.get('/api/auth/csrf', (req, res) => {
  const token = generateCsrfToken(req, res);
  res.json({ token });
});

app.use('/api/auth',     authRouter);
app.use('/api/members',  membersRouter);
app.use('/api/hearings', hearingsRouter);
app.use('/api/turns',    turnsRouter);
app.use('/api/comments', commentsRouter);
app.use('/api/topics',   topicsRouter);
app.use('/api/approval', approvalRouter);
app.use('/api/follows',  followsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/lookup',   lookupRouter);
app.use('/api/admin',    adminRouter);

// ── Error handler ─────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN' || err === invalidCsrfTokenError) {
    return res.status(403).json({ error: 'CSRF validation failed' });
  }
  console.error(err);
  // If a handler already started the response before rejecting, we cannot send
  // again — delegate to Express's finalizer instead of throwing on a double-send.
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
