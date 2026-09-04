const express = require('express');
const {
    getPolicies,
    getPolicy,
    createPolicy,
    updatePolicy,
    deletePolicy
} = require('../controllers/policyController');

const { protect } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');
const { validateObjectIdParam } = require('../middleware/validateObjectId');

const router = express.Router();

router.use(protect, requireAnyPageAccess(['/settings']));
router.param('id', validateObjectIdParam());

router
    .route('/')
    .get(getPolicies)
    .post(createPolicy);

router
    .route('/:id')
    .get(getPolicy)
    .put(updatePolicy)
    .delete(deletePolicy);

module.exports = router;
