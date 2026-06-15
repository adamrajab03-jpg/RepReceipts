const { Router } = require('express');
const { voteComment } = require('../controllers/commentsController');
const { requireAuth } = require('../middleware/auth');

const router = Router();
router.post('/:id/vote', requireAuth, voteComment);

module.exports = router;
