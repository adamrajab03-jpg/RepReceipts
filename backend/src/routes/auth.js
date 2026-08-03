const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { register, login, logout, me } = require('../controllers/authController');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');

const router = Router();

router.post('/register', authLimiter, asyncHandler(register));
router.post('/login',    authLimiter, asyncHandler(login));
router.post('/logout',   asyncHandler(logout));
router.get('/me',        requireAuth, asyncHandler(me));

module.exports = router;
