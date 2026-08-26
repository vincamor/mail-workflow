const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const gmailService = require('../services/gmailService');
const { requireAuth } = require('../middleware/authMiddleware');

// Limiteurs (plan SaaS 1.4)
const oauthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Trop de requêtes OAuth. Réessayez dans une minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { error: 'Trop de téléchargements. Réessayez dans une minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const pollingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Trop de requêtes de polling.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Initie OAuth Gmail
router.get('/', oauthLimiter, gmailService.initAuth);
// Callback OAuth Gmail
router.get('/callback', oauthLimiter, gmailService.handleCallback);

// Récupère les emails pour l'utilisateur authentifié (tokens en session)
router.get('/emails', requireAuth, gmailService.getEmails);

// Retourne uniquement le nombre de nouveaux messages (polling léger)
router.get('/count', pollingLimiter, requireAuth, gmailService.getEmailCount);

// Télécharge les emails par tranches
router.post('/download-chunks', downloadLimiter, requireAuth, gmailService.downloadEmailsInChunks);

// Envoie une réponse à un email dans un thread existant
router.post('/reply', requireAuth, gmailService.sendReply);

module.exports = router;
