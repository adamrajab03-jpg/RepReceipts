const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { getHeatmap } = require('../controllers/approvalController');

const router = Router();
router.get('/heatmap', asyncHandler(getHeatmap));

module.exports = router;
