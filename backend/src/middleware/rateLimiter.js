const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — please try again in 15 minutes' },
  skipSuccessfulRequests: false,
});

// Quote links: anyone may create one (no login), so this is what bounds row
// volume. Re-sharing the same passage returns the existing link but still
// counts — generous for a person sharing, tight for a script.
const citationLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,  // 10 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'You’ve created a lot of quote links in a short time — please try again in a few minutes' },
});

module.exports = { authLimiter, citationLimiter };
