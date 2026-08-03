const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { voteComment, deleteComment } = require('../controllers/commentsController');
const { requireAuth } = require('../middleware/auth');

const router = Router();
router.post('/:id/vote', requireAuth, asyncHandler(voteComment));
router.delete('/:id', requireAuth, asyncHandler(deleteComment));

module.exports = router;
