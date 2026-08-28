require('dotenv').config();

// SESSION_SECRET required as soon as not explicitly in development
// (avoids starting in prod with dev_secret if NODE_ENV not defined, e.g. Railway)
if (!process.env.SESSION_SECRET && process.env.NODE_ENV !== 'development') {
  console.error('SESSION_SECRET must be defined.');
  console.error('In production (Railway, etc.): Service variables → add SESSION_SECRET.');
  console.error('Locally: set NODE_ENV=development or add SESSION_SECRET in .env');
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

// Session store: Redis if REDIS_URL defined, otherwise in-memory (lost on restart)
async function createSessionStore() {
  const REDIS_URL = process.env.REDIS_URL;
  if (REDIS_URL) {
    const { createClient } = require('redis');
    const { RedisStore } = require('connect-redis');
    const redisClient = createClient({ url: REDIS_URL });
    redisClient.on('error', (err) => console.error('Redis client error:', err));
    await redisClient.connect();
    console.log('Redis connected — persistent sessions');
    return new RedisStore({ client: redisClient });
  }
  console.warn('REDIS_URL not defined — in-memory sessions (lost on restart)');
  return undefined;
}

async function start() {
  const store = await createSessionStore();

  const app = express();

  // In production behind a proxy (Railway, Render, etc.)
  if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }

  app.use(
    session({
      store: store || undefined,
      secret: process.env.SESSION_SECRET || 'dev_secret',
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 2, // 2h
      },
    })
  );

  // Helmet with default CSP, except img-src widened to https: and data:
  // so that HTML emails (iframe sandbox srcdoc) display their remote images.
  // script-src and other directives remain Helmet's defaults.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'img-src': ["'self'", 'data:', 'https:'],
        },
      },
    })
  );

  // CORS restricted to app origin (frontend served by same server)
  const APP_ORIGIN = process.env.APP_ORIGIN || 'http://localhost:3000';
  app.use(cors({ origin: APP_ORIGIN }));

  // Body limits: 10mb only for routes receiving large
  // ID lists (download-chunks — Outlook IDs are ~150 chars × thousands)
  // or voluminous AI context; 1mb everywhere else.
  app.use(
    ['/gmail/download-chunks', '/outlook/download-chunks', '/api/ai'],
    express.json({ limit: '10mb' })
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ limit: '1mb', extended: true }));

  // OAuth and email routes
  app.use('/gmail', gmailRoutes);
  app.use('/outlook', outlookRoutes);

  // AI routes (multi-provider proxy)
  app.use('/api/ai', aiRoutes);

  // Sign out: destroys server session (OAuth tokens included)
  app.post('/auth/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        console.error('Sign out error:', err);
        return res.status(500).json({ error: 'Error during sign out' });
      }
      res.clearCookie('connect.sid');
      res.json({ success: true });
    });
  });

  // Simple health check for hosting provider
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // Minimal frontend
  app.use('/', express.static(path.join(__dirname, 'public')));

  // The services folder is NO LONGER served in full (it contains backend code).
  // Only emailAnalyzer_browser.js is exposed — ES module imported by frontend.
  app.get('/services/emailAnalyzer_browser.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'services', 'emailAnalyzer_browser.js'));
  });
  app.use('/styles', express.static(path.join(__dirname, 'public/styles')));

  app.listen(PORT, () => {
    console.log(`Server started on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Startup error:', err);
  process.exit(1);
});
