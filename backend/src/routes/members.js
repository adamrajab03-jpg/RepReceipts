const { Router } = require('express');
const { listMembers, getMember } = require('../controllers/membersController');

const router = Router();
router.get('/', listMembers);
router.get('/:id', getMember);

module.exports = router;
