const { Router } = require('express');
const { listTopics } = require('../controllers/topicsController');

const router = Router();
router.get('/', listTopics);

module.exports = router;
