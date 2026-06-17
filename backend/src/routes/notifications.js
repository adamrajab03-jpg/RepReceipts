const { Router } = require('express');
const {
  listNotifications, unreadCount, markRead, markAllRead,
} = require('../controllers/notificationsController');
const { requireAuth } = require('../middleware/auth');

const router = Router();
router.get('/', requireAuth, listNotifications);
router.get('/unread-count', requireAuth, unreadCount);
router.post('/read-all', requireAuth, markAllRead);   // before /:id/read
router.post('/:id/read', requireAuth, markRead);

module.exports = router;
