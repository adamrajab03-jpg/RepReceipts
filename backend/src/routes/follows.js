const { Router } = require('express');
const { follow, unfollow, listFollows } = require('../controllers/followsController');
const { requireAuth } = require('../middleware/auth');

const router = Router();
router.get('/', requireAuth, listFollows);
router.post('/', requireAuth, follow);
// DELETE takes the same JSON body shapes as POST so it can target a precise
// follow shape (rep-only / topic-only / rep+topic).
router.delete('/', requireAuth, unfollow);

module.exports = router;
