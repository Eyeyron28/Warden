const express = require('express');

const createRateLimiter = require('../middleware/rateLimit');
const { sendContactMessage, CONTACT_WINDOW_MS, CONTACT_MAX } = require('../controllers/contact.controller');

const router = express.Router();

router.post(
  '/',
  createRateLimiter({
    name: 'contact-ip',
    max: CONTACT_MAX,
    windowMs: CONTACT_WINDOW_MS,
    message: 'Too many messages from this connection. Please try again later.',
  }),
  sendContactMessage
);

module.exports = router;
