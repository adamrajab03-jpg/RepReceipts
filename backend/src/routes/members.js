const { Router } = require('express');
const { listMembers, getMember, getMemberTopics } = require('../controllers/membersController');
const { getMemberApproval, setMemberApproval } = require('../controllers/approvalController');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = Router();
router.get('/', listMembers);
router.get('/:id/topics', getMemberTopics);
router.get('/:id/approval', optionalAuth, getMemberApproval);
router.put('/:id/approval', requireAuth, setMemberApproval);
router.get('/:id', getMember);

module.exports = router;
