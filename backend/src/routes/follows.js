const { Router } = require('express');
const { follow, unfollow, listFollows } = require('../controllers/followsController');
const { requireAuth } = require('../middleware/auth');

const router = Router();
router.get('/', requireAuth, listFollows);
router.post('/', requireAuth, follow);
router.delete('/:type/:id', requireAuth, unfollow);

module.exports = router;
