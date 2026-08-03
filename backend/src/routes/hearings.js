const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { listHearings, getHearing, getHearingTranscript } = require('../controllers/hearingsController');
const { listHearingComments, createHearingComment } = require('../controllers/commentsController');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = Router();
router.get( '/',              asyncHandler(listHearings));
router.get( '/:id/transcript', asyncHandler(getHearingTranscript));
router.get( '/:id/comments',  optionalAuth, asyncHandler(listHearingComments));
router.post('/:id/comments',  requireAuth, asyncHandler(createHearingComment));
router.get( '/:id',           asyncHandler(getHearing));

module.exports = router;
