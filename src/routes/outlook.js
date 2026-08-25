const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const outlookService = require('../services/outlookService');
const { requireAuth } = require('../middleware/authMiddleware');

// Limiteurs (plan SaaS 1.4)
const oauthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Trop de requêtes OAuth. Réessayez dans une minute.' },
  standardHeaders: true,
  legacyHeaders: false
});
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { error: 'Trop de téléchargements. Réessayez dans une minute.' },
  standardHeaders: true,
  legacyHeaders: false
});
const pollingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Trop de requêtes de polling.' },
  standardHeaders: true,
  legacyHeaders: false
});

// OAuth Outlook
router.get('/', oauthLimiter, outlookService.initAuth);
router.get('/callback', oauthLimiter, outlookService.handleCallback);

// Récupère les IDs + 20 emails pour affichage
// Params optionnels : ?afterDate= (sync incrémentale), ?filters= (filtres JSON)
router.get('/emails', requireAuth, outlookService.getEmails);

// Récupère le détail complet d'un email par son ID (format JSONL unifié)
router.get('/email/:messageId', requireAuth, outlookService.getEmailDetail);

// Retourne uniquement le nombre de nouveaux messages depuis afterDate (polling léger)
router.get('/count', pollingLimiter, requireAuth, outlookService.getEmailCount);

// Télécharge les emails par tranches via SSE (même format que /gmail/download-chunks)
router.post('/download-chunks', downloadLimiter, requireAuth, outlookService.downloadEmailsInChunks);

// Envoie une réponse à un email Outlook via Microsoft Graph
router.post('/reply', requireAuth, outlookService.sendReply);

module.exports = router;
