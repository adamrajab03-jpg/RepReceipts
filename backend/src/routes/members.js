const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { listMembers, getMember, getMemberTopics } = require('../controllers/membersController');
const { getMemberApproval, setMemberApproval } = require('../controllers/approvalController');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = Router();
router.get('/', asyncHandler(listMembers));
router.get('/:id/topics', asyncHandler(getMemberTopics));
router.get('/:id/approval', optionalAuth, asyncHandler(getMemberApproval));
router.put('/:id/approval', requireAuth, asyncHandler(setMemberApproval));
router.get('/:id', asyncHandler(getMember));

module.exports = router;
