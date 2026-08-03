const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { listTurnComments, createTurnComment } = require('../controllers/commentsController');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = Router();
router.get( '/:id/comments', optionalAuth, asyncHandler(listTurnComments));
router.post('/:id/comments', requireAuth, asyncHandler(createTurnComment));

module.exports = router;
