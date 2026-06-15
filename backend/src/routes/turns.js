const { Router } = require('express');
const { listTurnComments, createTurnComment } = require('../controllers/commentsController');
const { requireAuth } = require('../middleware/auth');

const router = Router();
router.get( '/:id/comments', listTurnComments);
router.post('/:id/comments', requireAuth, createTurnComment);

module.exports = router;
