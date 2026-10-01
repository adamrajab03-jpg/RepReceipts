const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { search } = require('../controllers/searchController');

// Public, read-only — same posture as the public hearings/citations reads.
const router = Router();
router.get('/', asyncHandler(search));

module.exports = router;
