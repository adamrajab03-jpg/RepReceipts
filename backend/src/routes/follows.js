const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { follow, unfollow, listFollows } = require('../controllers/followsController');
const { requireAuth } = require('../middleware/auth');

const router = Router();
router.get('/', requireAuth, asyncHandler(listFollows));
router.post('/', requireAuth, asyncHandler(follow));
// DELETE takes the same JSON body shapes as POST so it can target a precise
// follow shape (rep-only / topic-only / rep+topic).
router.delete('/', requireAuth, asyncHandler(unfollow));

module.exports = router;
