require('dotenv').config();

// SESSION_SECRET requis dès qu'on n'est pas explicitement en développement
// (évite de démarrer en prod avec dev_secret si NODE_ENV n'est pas défini, ex. Railway)
if (!process.env.SESSION_SECRET && process.env.NODE_ENV !== 'development') {
  console.error('SESSION_SECRET doit être défini.');
  console.error('En production (Railway, etc.) : Variables du service → ajouter SESSION_SECRET.');
  console.error('En local : définir NODE_ENV=development ou ajouter SESSION_SECRET dans .env');
  process.exit(1);
}

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const gmailRoutes = require('./routes/gmail');
const outlookRoutes = require('./routes/outlook');
const aiRoutes = require('./routes/ai');

const PORT = process.env.PORT || 3000;

// Session store : Redis si REDIS_URL défini, sinon mémoire (perdu au redémarrage)
async function createSessionStore() {
  const REDIS_URL = process.env.REDIS_URL;
  if (REDIS_URL) {
    const { createClient } = require('redis');
    const { RedisStore } = require('connect-redis');
    const redisClient = createClient({ url: REDIS_URL });
    redisClient.on('error', (err) => console.error('Redis client error:', err));
    await redisClient.connect();
    console.log('Redis connecté — sessions persistantes');
    return new RedisStore({ client: redisClient });
  }
  console.warn('REDIS_URL non défini — sessions en mémoire (perdues au redémarrage)');
  return undefined;
}

async function start() {
  const store = await createSessionStore();

  const app = express();

  // En production derrière un proxy (Railway, Render, etc.)
  if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }

  app.use(session({
    store: store || undefined,
    secret: process.env.SESSION_SECRET || 'dev_secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 2 // 2h
    }
  }));

  // Helmet avec CSP par défaut, sauf img-src élargi à https: et data:
  // pour que les emails HTML (iframe sandbox srcdoc) affichent leurs images distantes.
  // script-src et les autres directives restent celles par défaut de Helmet.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'img-src': ["'self'", 'data:', 'https:'],
      },
    },
  }));

  // CORS restreint à l'origine de l'app (frontend servi par le même serveur)
  const APP_ORIGIN = process.env.APP_ORIGIN || 'http://localhost:3000';
  app.use(cors({ origin: APP_ORIGIN }));

  // Limites de body : 10mb uniquement pour les routes qui reçoivent de grandes
  // listes d'IDs (download-chunks — les IDs Outlook font ~150 chars × milliers)
  // ou un contexte IA volumineux ; 1mb partout ailleurs.
  app.use(['/gmail/download-chunks', '/outlook/download-chunks', '/api/ai'],
    express.json({ limit: '10mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ limit: '1mb', extended: true }));

  // Routes OAuth et emails
  app.use('/gmail', gmailRoutes);
  app.use('/outlook', outlookRoutes);

  // Routes IA (proxy multi-provider)
  app.use('/api/ai', aiRoutes);

  // Déconnexion : détruit la session serveur (tokens OAuth inclus)
  app.post('/auth/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        console.error('Erreur logout:', err);
        return res.status(500).json({ error: 'Erreur lors de la déconnexion' });
      }
      res.clearCookie('connect.sid');
      res.json({ success: true });
    });
  });

  // Health check simple pour l'hébergeur
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // Frontend minimal
  app.use('/', express.static(path.join(__dirname, 'public')));

  // Le dossier services N'EST PLUS servi en entier (il contient du code backend).
  // Seul emailAnalyzer_browser.js est exposé — ES module importé par le frontend.
  app.get('/services/emailAnalyzer_browser.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'services', 'emailAnalyzer_browser.js'));
  });
  app.use('/styles', express.static(path.join(__dirname, 'public/styles')));

  app.listen(PORT, () => {
    console.log(`Serveur démarré sur http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Erreur démarrage:', err);
  process.exit(1);
}); 