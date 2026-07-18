const { Router } = require('express');
const { requireAdmin } = require('../middleware/auth');
const {
  listAdminHearings,
  getReview,
  applySpeaker,
  overrideTurn,
  acceptAll,
  setStatus,
} = require('../controllers/adminController');

const router = Router();

// Every admin route is gated: requireAuth (+ refresh) then an is_admin DB check.
router.use(requireAdmin);

router.get('/hearings',                    listAdminHearings);
router.get('/hearings/:id/review',         getReview);
router.patch('/hearings/:id/speakers',     applySpeaker);   // attribute/correct a whole speaker
router.patch('/hearings/:id/turns/:turnId', overrideTurn);  // per-turn override (drift) / reset
router.post('/hearings/:id/accept-all',    acceptAll);       // attribute all pending speakers
router.post('/hearings/:id/status',        setStatus);       // tier: attributed | verified

module.exports = router;
