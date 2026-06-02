const { Router } = require('express');
const { listHearings, getHearing } = require('../controllers/hearingsController');

const router = Router();
router.get('/', listHearings);
router.get('/:id', getHearing);

module.exports = router;
