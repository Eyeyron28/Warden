const express = require('express');

const requireSession = require('../middleware/requireSession');
const { initPairing, getPairingStatus } = require('../controllers/pairing.controller');

// Owner-only, unlike the phone-side completion endpoint that'll live
// alongside this in the next pass - only the unlocked Vault Owner can
// generate a pairing code in the first place.
const router = express.Router();
router.use(requireSession);
router.post('/init', initPairing);
router.get('/status/:token', getPairingStatus);

module.exports = router;
