const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const ACCESS_TTL_MS  = 15 * 60 * 1000;            // 15 minutes
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days

function signAccessToken(payload) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET not set');
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '15m' });
}

function verifyAccessToken(token) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET not set');
  return jwt.verify(token, process.env.JWT_SECRET);
}

function generateRefreshToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function refreshExpiresAt() {
  return new Date(Date.now() + REFRESH_TTL_MS);
}

function cookieOpts(maxAgeMs) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: maxAgeMs,
    path: '/',
  };
}

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie('access_token',  accessToken,  cookieOpts(ACCESS_TTL_MS));
  res.cookie('refresh_token', refreshToken, cookieOpts(REFRESH_TTL_MS));
}

function clearAuthCookies(res) {
  const opts = { path: '/', sameSite: 'strict' };
  res.clearCookie('access_token',  opts);
  res.clearCookie('refresh_token', opts);
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashToken,
  refreshExpiresAt,
  setAuthCookies,
  clearAuthCookies,
};
