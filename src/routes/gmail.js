const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const gmailService = require('../services/gmailService');
const { requireAuth } = require('../middleware/authMiddleware');

// Rate limiters (SaaS plan 1.4)
const oauthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many OAuth requests. Try again in a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { error: 'Too many downloads. Try again in a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const pollingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many polling requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Initializes Gmail OAuth
router.get('/', oauthLimiter, gmailService.initAuth);
// Gmail OAuth callback
router.get('/callback', oauthLimiter, gmailService.handleCallback);

// Retrieves emails for authenticated user (tokens in session)
router.get('/emails', requireAuth, gmailService.getEmails);

// Returns only the count of new messages (light polling)
router.get('/count', pollingLimiter, requireAuth, gmailService.getEmailCount);

// Downloads emails in chunks
router.post('/download-chunks', downloadLimiter, requireAuth, gmailService.downloadEmailsInChunks);

// Sends a reply to an email in an existing thread
router.post('/reply', requireAuth, gmailService.sendReply);

module.exports = router;
