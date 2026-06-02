const { Router } = require('express');
const { listHearings, getHearing, getHearingTranscript } = require('../controllers/hearingsController');

const router = Router();
router.get('/', listHearings);
router.get('/:id/transcript', getHearingTranscript);
router.get('/:id', getHearing);

module.exports = router;
