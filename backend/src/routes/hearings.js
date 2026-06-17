const { Router } = require('express');
const { listHearings, getHearing, getHearingTranscript } = require('../controllers/hearingsController');
const { listHearingComments, createHearingComment } = require('../controllers/commentsController');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = Router();
router.get( '/',              listHearings);
router.get( '/:id/transcript', getHearingTranscript);
router.get( '/:id/comments',  optionalAuth, listHearingComments);
router.post('/:id/comments',  requireAuth, createHearingComment);
router.get( '/:id',           getHearing);

module.exports = router;
