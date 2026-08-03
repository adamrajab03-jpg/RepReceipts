const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const {
  listNotifications, unreadCount, markRead, markAllRead,
} = require('../controllers/notificationsController');
const { requireAuth } = require('../middleware/auth');

const router = Router();
router.get('/', requireAuth, asyncHandler(listNotifications));
router.get('/unread-count', requireAuth, asyncHandler(unreadCount));
router.post('/read-all', requireAuth, asyncHandler(markAllRead));   // before /:id/read
router.post('/:id/read', requireAuth, asyncHandler(markRead));

module.exports = router;
