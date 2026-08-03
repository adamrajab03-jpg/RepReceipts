const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { lookupReps } = require('../controllers/lookupController');

const router = Router();
// Public — no auth. Civic lookup of a ZIP's representatives.
router.get('/reps', asyncHandler(lookupReps));

module.exports = router;
