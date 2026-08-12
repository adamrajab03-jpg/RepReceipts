const { Router } = require('express');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
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
  acceptCleanup,
  rejectCleanup,
  restoreCleanup,
  overrideCleanup,
  updateSection,
  splitSectionAtTurn,
  moveSectionBoundary,
  deleteSection,
  redetectSections,
  editTurnText,
  reviewTurnText,
} = require('../controllers/adminController');

const router = Router();

// Every admin route is gated: requireAuth (+ refresh) then an is_admin DB check.
router.use(requireAdmin);

// Every handler is asyncHandler-wrapped so ANY thrown/rejected error becomes a
// clean logged 500 via the error middleware — a bad request can never crash the
// process.
router.get('/hearings',                    asyncHandler(listAdminHearings));
router.get('/hearings/:id/review',         asyncHandler(getReview));
router.patch('/hearings/:id/speakers',     asyncHandler(applySpeaker));   // attribute/correct a whole speaker bucket
router.patch('/hearings/:id/turns/:turnId', asyncHandler(overrideTurn));  // move ONE turn between buckets / reset
router.post('/hearings/:id/turns/:turnId/split',  asyncHandler(splitTurn));  // cut a turn at a word boundary
router.post('/hearings/:id/turns/:turnId/merge',  asyncHandler(mergeTurn));  // delete-merge into a neighbor
router.post('/hearings/:id/turns/:turnId/insert', asyncHandler(insertTurn)); // blank turn before/after
router.post('/hearings/:id/turns/:turnId/text',   asyncHandler(editTurnText));   // manual inline text edit
router.post('/hearings/:id/turns/:turnId/text-review', asyncHandler(reviewTurnText)); // mark text reviewed (no change)
router.post('/hearings/:id/turns/:turnId/cleanup/accept', asyncHandler(acceptCleanup)); // accept LLM cleanup proposal(s)
router.post('/hearings/:id/turns/:turnId/cleanup/reject', asyncHandler(rejectCleanup));  // dismiss one / all pending (recoverable)
router.post('/hearings/:id/turns/:turnId/cleanup/restore', asyncHandler(restoreCleanup)); // undo a dismissal
router.post('/hearings/:id/turns/:turnId/cleanup/override', asyncHandler(overrideCleanup)); // apply a BLOCKED edit as a human edit
// Sectioning — ranges over turns. None of these touch speaker_turns.
router.post('/hearings/:id/sections/redetect',            asyncHandler(redetectSections));    // re-run detection, keep admin edits
router.patch('/hearings/:id/sections/:sectionId',         asyncHandler(updateSection));       // rename / change type
router.post('/hearings/:id/sections/split-at-turn',       asyncHandler(splitSectionAtTurn));  // new section starting at a turn
router.patch('/hearings/:id/sections/:sectionId/boundary', asyncHandler(moveSectionBoundary)); // MOVE a boundary (drag)
router.delete('/hearings/:id/sections/:sectionId',        asyncHandler(deleteSection));       // REMOVE a boundary (folds up)

router.post('/hearings/:id/accept-all',    asyncHandler(acceptAll));       // attribute all pending speakers
router.post('/hearings/:id/status',        asyncHandler(setStatus));       // tier: attributed | verified

module.exports = router;
