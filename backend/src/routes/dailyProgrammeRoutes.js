const express = require('express');
const router = express.Router();
const multer = require('multer');

// In-memory storage for .docx uploads (no disk write needed)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            file.originalname.endsWith('.docx')) {
            cb(null, true);
        } else {
            cb(new Error('Only .docx files are allowed'), false);
        }
    }
});

const {
    getProgrammesByDate,
    saveProgrammesBulk,
    createProgramme,
    updateProgramme,
    deleteProgramme,
    clearProgrammesByDate,
    getAvailableDates,
    uploadPeriscope,
    getPeriscopeUploadInfo,
    downloadPeriscopeDoc
} = require('../controllers/dailyProgrammeController');

const { protect, authorize } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');

router.use(protect);

// RBAC:
// - Reading programmes is needed on both Announcements (manage) and Dashboard (view).
// - Writes (upload/save/edit/delete) remain restricted to Announcements.
const READ_PAGES = ['/announcements', '/dashboard'];
const WRITE_PAGES = ['/announcements'];

// Get available dates with programmes
router.get('/dates', requireAnyPageAccess(WRITE_PAGES), getAvailableDates);

// Get upload info (abstract, S3 availability) for a date
router.get('/upload-info', requireAnyPageAccess(WRITE_PAGES), getPeriscopeUploadInfo);

// Download original Periscope DOCX from S3
router.get('/download-periscope', requireAnyPageAccess(WRITE_PAGES), downloadPeriscopeDoc);

// Get programmes by date
router.get('/', requireAnyPageAccess(READ_PAGES), getProgrammesByDate);

// NOTE: role checks below previously listed roles ('super_admin', 'analyst', 'viewer')
// that don't exist in the User schema enum (['superadmin', 'level-1', 'level-2']), so
// only superadmin could ever pass despite level-1/level-2 already holding page access
// to /announcements via RBAC. Corrected to the real enum values.

// Upload Periscope .docx and parse into programmes
router.post('/upload-periscope', requireAnyPageAccess(WRITE_PAGES), authorize('superadmin', 'level-1', 'level-2'), upload.single('file'), uploadPeriscope);

// Save bulk programmes for a date
router.post('/bulk', requireAnyPageAccess(WRITE_PAGES), authorize('superadmin', 'level-1', 'level-2'), saveProgrammesBulk);

// Create single programme
router.post('/', requireAnyPageAccess(WRITE_PAGES), authorize('superadmin', 'level-1', 'level-2'), createProgramme);

// Update single programme
router.put('/:id', requireAnyPageAccess(WRITE_PAGES), authorize('superadmin', 'level-1', 'level-2'), updateProgramme);

// Delete single programme
router.delete('/:id', requireAnyPageAccess(WRITE_PAGES), authorize('superadmin', 'level-1', 'level-2'), deleteProgramme);

// Clear all programmes for a date — kept superadmin-only (destructive, bulk operation).
router.delete('/date/:date', requireAnyPageAccess(WRITE_PAGES), authorize('superadmin'), clearProgrammesByDate);

module.exports = router;
