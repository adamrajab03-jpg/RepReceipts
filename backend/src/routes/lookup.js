const { Router } = require('express');
const { lookupReps } = require('../controllers/lookupController');

const router = Router();
// Public — no auth. Civic lookup of a ZIP's representatives.
router.get('/reps', lookupReps);

module.exports = router;
