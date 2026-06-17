const { Router } = require('express');
const { getHeatmap } = require('../controllers/approvalController');

const router = Router();
router.get('/heatmap', getHeatmap);

module.exports = router;
