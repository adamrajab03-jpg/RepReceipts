const { Router } = require('express');
const { requireAdmin } = require('../middleware/auth');
const {
  listAdminHearings,
  getReview,
  applySpeaker,
  overrideTurn,
  acceptAll,
  splitTurn,
  mergeTurn,
  insertTurn,
  setStatus,
} = require('../controllers/adminController');

const router = Router();

// Every admin route is gated: requireAuth (+ refresh) then an is_admin DB check.
router.use(requireAdmin);

router.get('/hearings',                    listAdminHearings);
router.get('/hearings/:id/review',         getReview);
router.patch('/hearings/:id/speakers',     applySpeaker);   // attribute/correct a whole speaker bucket
router.patch('/hearings/:id/turns/:turnId', overrideTurn);  // move ONE turn between buckets / reset
router.post('/hearings/:id/turns/:turnId/split',  splitTurn);  // cut a turn at a word boundary
router.post('/hearings/:id/turns/:turnId/merge',  mergeTurn);  // delete-merge into a neighbor
router.post('/hearings/:id/turns/:turnId/insert', insertTurn); // blank turn before/after
router.post('/hearings/:id/accept-all',    acceptAll);       // attribute all pending speakers
router.post('/hearings/:id/status',        setStatus);       // tier: attributed | verified

module.exports = router;
