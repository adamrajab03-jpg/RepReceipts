const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { createCitation, getCitation } = require('../controllers/citationsController');
const { optionalAuth } = require('../middleware/auth');
const { citationLimiter } = require('../middleware/rateLimiter');

const router = Router();
// Anyone may share a quote: the server builds the whole snapshot, so a request
// cannot forge content — the limiter only bounds row volume. Signed-in shares
// record created_by.
router.post('/',      citationLimiter, optionalAuth, asyncHandler(createCitation));
router.get( '/:code', asyncHandler(getCitation));

module.exports = router;
