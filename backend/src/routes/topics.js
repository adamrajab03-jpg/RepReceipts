const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { listTopics } = require('../controllers/topicsController');

const router = Router();
router.get('/', asyncHandler(listTopics));

module.exports = router;
