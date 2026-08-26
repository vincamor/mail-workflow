const crypto = require('crypto');
const { google } = require('googleapis');
const oauthConfig = require('../config/oauth');
const { streamEmailChunks, isTokenError, parseFiltersFromRequest } = require('./emailUtils');
const { stripQuotedText } = require('./quoteStripper');

// Timeout global (30s) sur tous les appels sortants googleapis (gaxios)
google.options({ timeout: 30000 });
// Suppression de toutes les dépendances DB et stockage local

// Fonction utilitaire pour décoder les données base64 des emails Gmail
function decodeBase64Data(data) {
  if (!data) return '';
  try {
    // Gestion des caractères spéciaux dans base64
    const cleanData = data.replace(/-/g, '+').replace(/_/g, '/');
    const buffer = Buffer.from(cleanData, 'base64');
    return buffer.toString('utf-8');
  } catch (error) {
    console.error('Erreur décodage base64:', error);
    return data; // Retourne les données originales si le décodage échoue
  }
}

// Fonction pour extraire et décoder le contenu d'un email Gmail
function extractEmailContent(payload) {
  if (!payload) return { text: '', html: '' };

  let textContent = '';
  let htmlContent = '';

  // Fonction récursive pour parcourir les parties du payload
  function processPart(part) {
    if (!part) return;

    // Si c'est une partie avec des données
    if (part.body && part.body.data) {
      const decodedContent = decodeBase64Data(part.body.data);

      if (part.mimeType === 'text/plain') {
        textContent = decodedContent;
      } else if (part.mimeType === 'text/html') {
        htmlContent = decodedContent;
      }
    }

    // Traiter les sous-parties si elles existent
    if (part.parts && Array.isArray(part.parts)) {
      part.parts.forEach(processPart);
    }
  }

  processPart(payload);

  return { text: textContent, html: htmlContent };
}

// Detect attachments — any part with a non-empty filename
function checkForAttachments(payload) {
  if (!payload) return false;
  if (payload.filename) return true;
  if (payload.parts) {
    return payload.parts.some((part) => checkForAttachments(part));
  }
  return false;
}

// Fonction pour nettoyer et formater un email Gmail
function formatGmailEmail(email) {
  if (!email) return null;

  // Extraire les en-têtes
  const headers = email.payload?.headers || [];
  const getHeader = (name) => {
    const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
    return header ? header.value : '';
  };

  // Extraire le contenu
  const content = extractEmailContent(email.payload);

  // Detect attachments — any part with a non-empty filename
  const hasAttachments = checkForAttachments(email.payload);

  return {
    id: email.id,
    threadId: email.threadId,
    snippet: email.snippet || '',
    subject: getHeader('Subject'),
    from: getHeader('From'),
    to: getHeader('To'),
    cc: getHeader('Cc'),
    date: getHeader('Date'),
    messageId: getHeader('Message-ID'),
    inReplyTo: getHeader('In-Reply-To'),
    references: getHeader('References'),
    internalDate: email.internalDate,
    hasAttachments,
    // Contenu décodé — bodyText est strippe des citations (forward-only, JSONL plus compact)
    bodyText: stripQuotedText(content.text),
    bodyHtml: content.html,
  };
}

// Initie OAuth Gmail
exports.initAuth = (req, res) => {
  const oauth2Client = new google.auth.OAuth2(
    oauthConfig.gmail.clientId,
    oauthConfig.gmail.clientSecret,
    oauthConfig.gmail.redirectUri
  );
  const scopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'openid',
    'email',
    'profile',
  ];
  // Anti-CSRF OAuth : state aléatoire stocké en session, vérifié au callback
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
    state,
  });
  req.session.save(() => res.redirect(url));
};

// Callback OAuth Gmail
exports.handleCallback = async (req, res) => {
  const code = req.query.code;

  // Vérification du state anti-CSRF (généré dans initAuth)
  const expectedState = req.session.oauthState;
  delete req.session.oauthState;
  if (!req.query.state || !expectedState || req.query.state !== expectedState) {
    console.error('Erreur callback Gmail: state OAuth absent ou invalide');
    return res.status(403).send('Erreur OAuth Gmail : state invalide');
  }

  const oauth2Client = new google.auth.OAuth2(
    oauthConfig.gmail.clientId,
    oauthConfig.gmail.clientSecret,
    oauthConfig.gmail.redirectUri
  );
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    // Récupérer l'email utilisateur
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userinfo = await oauth2.userinfo.get();
    const email = userinfo.data.email;
    // Régénérer la session (anti-fixation) puis stocker les tokens
    req.session.regenerate((err) => {
      if (err) {
        console.error('Erreur régénération session Gmail:', err);
        return res.status(500).send('Erreur OAuth Gmail');
      }
      req.session.tokens = tokens;
      req.session.email = email;
      // Rediriger vers le frontend avec l'email et provider
      req.session.save(() => res.redirect('/?provider=gmail&email=' + encodeURIComponent(email)));
    });
  } catch (err) {
    console.error('Erreur callback Gmail:', err);
    res.status(500).send('Erreur OAuth Gmail');
  }
};

// Récupère les emails pour un utilisateur (directement via l'API Gmail)
exports.getEmails = async (req, res) => {
  const tokens = req.session.tokens;
  if (!tokens) {
    return res.status(401).json({
      error: 'Non authentifié (pas de tokens en session)',
      requiresLogout: true,
    });
  }

  const { filters, afterDate } = parseFiltersFromRequest(req);

  const oauth2Client = new google.auth.OAuth2(
    oauthConfig.gmail.clientId,
    oauthConfig.gmail.clientSecret,
    oauthConfig.gmail.redirectUri
  );
  oauth2Client.setCredentials(tokens);

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Fonction helper pour récupérer tous les messages avec pagination
  async function getAllMessages(labelIds = null, maxResults = 5000, query = '') {
    let allMessages = [];
    let nextPageToken = null;
    let pageCount = 0;

    do {
      pageCount++;
      console.log(`📄 Page ${pageCount} - Récupération des messages...`);

      const params = {
        userId: 'me',
        maxResults: maxResults,
      };

      if (labelIds) {
        params.labelIds = labelIds;
      }

      if (query) {
        params.q = query;
      }

      if (nextPageToken) {
        params.pageToken = nextPageToken;
      }

      const response = await gmail.users.messages.list(params);
      const messages = response.data.messages || [];

      allMessages = allMessages.concat(messages);
      nextPageToken = response.data.nextPageToken;

      console.log(
        `📄 Page ${pageCount} - ${messages.length} messages récupérés (total: ${allMessages.length})`
      );
    } while (nextPageToken);

    return allMessages;
  }

  try {
    // Construire la query Gmail à partir des filtres + afterDate (sync incrémentale)
    const gmailQuery = buildGmailQuery(filters, afterDate);

    if (gmailQuery) {
      console.log(`🔍 Application des filtres Gmail API: ${gmailQuery}`);
      console.log(`📋 Filtres reçus:`, JSON.stringify(filters, null, 2));
      if (afterDate)
        console.log(
          `📅 Mode sync incrémentale depuis: ${new Date(parseInt(afterDate)).toISOString()}`
        );
    } else {
      console.log(`⚠️ Aucun filtre appliqué — téléchargement complet`);
    }

    // INBOX - emails reçus avec pagination (tous les emails disponibles)
    console.log('📥 Récupération des emails INBOX...');
    const inboxMessages = (await getAllMessages(['INBOX'], 5000, gmailQuery)).map((m) => ({
      ...m,
      _type: 'recu',
    }));
    console.log(`📥 INBOX: ${inboxMessages.length} messages`);

    // SENT - emails envoyés avec pagination (tous les emails disponibles)
    console.log('📤 Récupération des emails SENT...');
    const sentMessages = (await getAllMessages(['SENT'], 5000, gmailQuery)).map((m) => ({
      ...m,
      _type: 'envoye',
    }));
    console.log(`📤 SENT: ${sentMessages.length} messages`);

    // ALL MAIL - emails archivés/autres labels avec pagination (tous les emails disponibles)
    console.log('📁 Récupération des emails ALL MAIL...');
    const allMailMessages = (await getAllMessages(null, 5000, gmailQuery)).map((m) => ({
      ...m,
      _type: 'archive',
    }));
    console.log(`📁 ALL MAIL: ${allMailMessages.length} messages`);

    // Fusion et déduplication
    const allMessagesMap = new Map();
    [...inboxMessages, ...sentMessages, ...allMailMessages].forEach((m) => {
      allMessagesMap.set(m.id, m);
    });
    const allMessages = Array.from(allMessagesMap.values());
    console.log(`🔗 TOTAL: ${allMessages.length} messages uniques`);

    // Récupération des détails (seulement pour l'affichage - 20 premiers)
    const displayEmails = [];
    let rejectedCount = 0;

    // Traiter seulement les 20 premiers pour l'affichage
    const emailsToProcess = allMessages.slice(0, 20);

    for (let i = 0; i < emailsToProcess.length; i++) {
      try {
        const msgData = await gmail.users.messages.get({
          userId: 'me',
          id: emailsToProcess[i].id,
          format: 'full',
        });

        const formattedEmail = formatGmailEmail(msgData.data);
        if (formattedEmail) {
          displayEmails.push(formattedEmail);
        } else {
          rejectedCount++;
        }
      } catch (error) {
        rejectedCount++;
        continue;
      }
    }

    console.log(
      `✅ ${displayEmails.length} emails affichés (sur ${allMessages.length} disponibles)`
    );
    console.log(`❌ ${rejectedCount} emails rejetés`);

    // Retourner les emails d'affichage + métadonnées pour le téléchargement
    res.json({
      displayEmails: displayEmails,
      totalAvailable: allMessages.length,
      messageIds: allMessages.map((m) => ({ id: m.id, type: m._type })),
      metadata: {
        inboxCount: inboxMessages.length,
        sentCount: sentMessages.length,
        allMailCount: allMailMessages.length,
        uniqueCount: allMessages.length,
      },
    });
  } catch (error) {
    console.error('❌ Erreur:', error);

    if (isTokenError(error)) {
      return res.status(401).json({ error: 'Token expiré ou invalide', requiresLogout: true });
    }
    res.status(500).json({ error: 'Erreur récupération emails' });
  }
};

/**
 * Convertit les filtres en query Gmail API
 * @param {Object} filters - Configuration des filtres
 * @param {string|null} afterDate - internalDate Gmail (ms depuis epoch) du dernier email stocké.
 *   Si fourni, ajoute "after:YYYY/MM/DD" à la query pour la sync incrémentale.
 *   Si null, aucun filtre de date (comportement identique au téléchargement complet).
 * @returns {string} - Query string pour Gmail API
 */
function buildGmailQuery(filters, afterDate = null) {
  const queryParts = [];

  // Filtre de date pour la sync incrémentale (optionnel)
  if (afterDate) {
    const date = new Date(parseInt(afterDate));
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    queryParts.push(`after:${year}/${month}/${day}`);
    console.log(`📅 Filtre de date sync incrémentale: after:${year}/${month}/${day}`);
  }

  if (!filters) {
    const query = queryParts.join(' ');
    if (query) console.log(`🔍 Query Gmail: ${query}`);
    return query;
  }

  // 1. Exclure les notifications par expéditeur
  if (filters.excludeNotifications && filters.notificationKeywords) {
    filters.notificationKeywords.forEach((keyword) => {
      queryParts.push(`-from:${keyword}`);
    });
  }

  // 2. Exclure les expéditeurs de la liste noire
  if (filters.blacklistedSenders && filters.blacklistedSenders.length > 0) {
    filters.blacklistedSenders.forEach((sender) => {
      // Extraire juste l'adresse email si format "Name <email>"
      const match = sender.match(/<([^>]+)>/);
      const emailOnly = match ? match[1] : sender;
      queryParts.push(`-from:${emailOnly}`);
    });
  }

  // 3. Exclure les mots-clés du sujet
  if (filters.blacklistedKeywords && filters.blacklistedKeywords.length > 0) {
    filters.blacklistedKeywords.forEach((keyword) => {
      queryParts.push(`-subject:"${keyword}"`);
    });
  }

  // 4. Exclure les promotions par mots-clés
  if (filters.excludePromotional && filters.promotionalKeywords) {
    filters.promotionalKeywords.forEach((keyword) => {
      queryParts.push(`-subject:${keyword}`);
    });
  }

  // 5. Exclure les emails sans sujet (non supporté directement par Gmail API)
  // On les filtrera côté serveur après téléchargement

  const query = queryParts.join(' ');
  if (query) {
    console.log(`🔍 Query Gmail: ${query}`);
  }

  return query;
}

// shouldExcludeEmail importé depuis emailUtils.js

// Télécharge les emails par tranches avec progression SSE (via streamEmailChunks partagé)
exports.downloadEmailsInChunks = async (req, res) => {
  const tokens = req.session.tokens;
  if (!tokens) {
    return res.status(401).json({ error: 'Non authentifié', requiresLogout: true });
  }

  const { messageIds, chunkSize = 500, filters = null } = req.body;
  if (!messageIds || !Array.isArray(messageIds)) {
    return res.status(400).json({ error: 'Liste des IDs de messages requise' });
  }

  const oauth2Client = new google.auth.OAuth2(
    oauthConfig.gmail.clientId,
    oauthConfig.gmail.clientSecret,
    oauthConfig.gmail.redirectUri
  );
  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  await streamEmailChunks(res, {
    messageIds,
    chunkSize,
    filters,
    provider: 'Gmail',
    fetchMessage: async (msgId) => {
      const msgData = await gmail.users.messages.get({ userId: 'me', id: msgId, format: 'full' });
      return formatGmailEmail(msgData.data);
    },
  });
};

/**
 * Retourne uniquement le nombre de messages disponibles depuis une date donnée.
 * Endpoint léger utilisé par le polling toutes les 5 min — ne récupère aucun contenu d'email.
 */
exports.getEmailCount = async (req, res) => {
  const tokens = req.session.tokens;
  if (!tokens) {
    return res.status(401).json({ error: 'Non authentifié', requiresLogout: true });
  }

  const { filters, afterDate } = parseFiltersFromRequest(req);

  const oauth2Client = new google.auth.OAuth2(
    oauthConfig.gmail.clientId,
    oauthConfig.gmail.clientSecret,
    oauthConfig.gmail.redirectUri
  );
  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Helper local pour lister les IDs (sans récupérer les détails)
  async function listMessageIds(labelIds, query) {
    const ids = new Map();
    let nextPageToken = null;
    do {
      const params = { userId: 'me', maxResults: 5000 };
      if (labelIds) params.labelIds = labelIds;
      if (query) params.q = query;
      if (nextPageToken) params.pageToken = nextPageToken;
      const response = await gmail.users.messages.list(params);
      (response.data.messages || []).forEach((m) => ids.set(m.id, true));
      nextPageToken = response.data.nextPageToken;
    } while (nextPageToken);
    return ids;
  }

  try {
    const gmailQuery = buildGmailQuery(filters, afterDate);

    const [inboxIds, sentIds, allMailIds] = await Promise.all([
      listMessageIds(['INBOX'], gmailQuery),
      listMessageIds(['SENT'], gmailQuery),
      listMessageIds(null, gmailQuery),
    ]);

    // Déduplication
    const allIds = new Map([...inboxIds, ...sentIds, ...allMailIds]);
    const newCount = allIds.size;

    console.log(
      `📬 Polling count: ${newCount} messages (afterDate: ${afterDate ? new Date(parseInt(afterDate)).toISOString() : 'aucun'})`
    );
    res.json({ newCount });
  } catch (error) {
    console.error('❌ Erreur getEmailCount:', error);
    if (isTokenError(error)) {
      return res.status(401).json({ error: 'Token expiré', requiresLogout: true });
    }
    res.status(500).json({ error: 'Erreur comptage emails' });
  }
};

/**
 * Envoie une réponse à un email dans un thread Gmail existant.
 * Requiert le scope gmail.send.
 *
 * Body attendu : { to, cc?, subject, body, threadId, messageId, references? }
 *   - to         : destinataire(s) — adresse du from de l'email original
 *   - cc         : destinataires en copie (optionnel)
 *   - subject    : sujet de l'email original (préfixé "Re:" si absent)
 *   - body       : texte brut de la réponse
 *   - threadId   : ID du thread Gmail (pour rattacher la réponse au bon fil)
 *   - messageId  : Message-ID de l'email auquel on répond (pour In-Reply-To)
 *   - references : chaîne References de l'email original (optionnel)
 */
exports.sendReply = async (req, res) => {
  const tokens = req.session.tokens;
  if (!tokens) {
    return res.status(401).json({ error: 'Non authentifié', requiresLogout: true });
  }

  const { to, cc, subject, body, threadId, messageId, references } = req.body;

  if (!to || !body || !threadId || !messageId) {
    return res
      .status(400)
      .json({ error: 'Champs requis manquants (to, body, threadId, messageId)' });
  }

  const oauth2Client = new google.auth.OAuth2(
    oauthConfig.gmail.clientId,
    oauthConfig.gmail.clientSecret,
    oauthConfig.gmail.redirectUri
  );
  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  try {
    // Construction du sujet — évite de doubler "Re:"
    const replySubject = /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;

    // Chaîne References : ajoute le messageId de l'email d'origine à la fin
    const replyReferences = references ? `${references} ${messageId}` : messageId;

    // Construction du message RFC 2822
    const headerLines = [
      `To: ${to}`,
      cc && cc.trim() ? `Cc: ${cc}` : null,
      `Subject: ${replySubject}`,
      `In-Reply-To: ${messageId}`,
      `References: ${replyReferences}`,
      'Content-Type: text/plain; charset=UTF-8',
      'MIME-Version: 1.0',
    ].filter(Boolean);

    const rawMessage = `${headerLines.join('\r\n')}\r\n\r\n${body}`;
    const encodedMessage = Buffer.from(rawMessage).toString('base64url');

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
        threadId: threadId,
      },
    });

    console.log(`✅ Réponse envoyée — id: ${response.data.id}, thread: ${threadId}`);
    res.json({ success: true, messageId: response.data.id });
  } catch (error) {
    console.error('❌ Erreur sendReply:', error);
    if (isTokenError(error)) {
      return res.status(401).json({ error: 'Token expiré', requiresLogout: true });
    }
    res.status(500).json({ error: "Erreur lors de l'envoi de la réponse : " + error.message });
  }
};

// Exports supplémentaires pour les tests unitaires
module.exports.formatGmailEmail = formatGmailEmail;
module.exports.buildGmailQuery = buildGmailQuery;
