const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const outlookService = require('../services/outlookService');
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

// Outlook OAuth
router.get('/', oauthLimiter, outlookService.initAuth);
router.get('/callback', oauthLimiter, outlookService.handleCallback);

// Retrieves IDs + 20 emails for display
// Optional params: ?afterDate= (incremental sync), ?filters= (JSON filters)
router.get('/emails', requireAuth, outlookService.getEmails);

// Retrieves full details of an email by its ID (unified JSONL format)
router.get('/email/:messageId', requireAuth, outlookService.getEmailDetail);

// Returns only the count of new messages since afterDate (light polling)
router.get('/count', pollingLimiter, requireAuth, outlookService.getEmailCount);

// Downloads emails in chunks via SSE (same format as /gmail/download-chunks)
router.post(
  '/download-chunks',
  downloadLimiter,
  requireAuth,
  outlookService.downloadEmailsInChunks
);

// Sends a reply to an Outlook email via Microsoft Graph
router.post('/reply', requireAuth, outlookService.sendReply);

module.exports = router;
