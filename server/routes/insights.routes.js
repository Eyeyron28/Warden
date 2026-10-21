const express = require('express');

const requireSession = require('../middleware/requireSession');
const { getOverview, getStale, getFrequent } = require('../controllers/insights.controller');

const router = express.Router();
router.use(requireSession);
router.get('/overview', getOverview);
router.get('/stale', getStale);
router.get('/frequent', getFrequent);

module.exports = router;
