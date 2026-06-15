const { Router } = require('express');
const { voteComment, deleteComment } = require('../controllers/commentsController');
const { requireAuth } = require('../middleware/auth');

const router = Router();
router.post('/:id/vote', requireAuth, voteComment);
router.delete('/:id', requireAuth, deleteComment);

module.exports = router;
