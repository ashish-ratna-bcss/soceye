const express = require('express');
const router = express.Router();
const { lookupPostLocation } = require('../controllers/postLocationController');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);

router.post('/lookup', lookupPostLocation);
router.get('/lookup', lookupPostLocation);

module.exports = router;
