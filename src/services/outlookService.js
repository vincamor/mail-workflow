const crypto = require('crypto');
const msal = require('@azure/msal-node');
const oauthConfig = require('../config/oauth');
const { streamEmailChunks, isTokenError, parseFiltersFromRequest } = require('./emailUtils');
const { stripQuotedText } = require('./quoteStripper');

// fetch global Node 18+ (node-fetch supprimé — dépendance fantôme), wrappé avec
// un timeout de 30s via AbortController sur tous les appels sortants (Graph, MS login).
const OUTBOUND_TIMEOUT_MS = 30000;
const fetch = async (url, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
  try {
    return await globalThis.fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

// ─────────────────────────────────────────────
//  MSAL config (inchangé)
// ─────────────────────────────────────────────
const msalConfig = {
  auth: {
    clientId: oauthConfig.outlook.clientId,
    authority: `https://login.microsoftonline.com/${oauthConfig.outlook.tenantId}`,
    clientSecret: oauthConfig.outlook.clientSecret,
  },
};
const REDIRECT_URI = oauthConfig.outlook.redirectUri;
const pca = new msal.ConfidentialClientApplication(msalConfig);

// ─────────────────────────────────────────────
//  Refresh token Outlook (évite déconnexion après 1h)
// ─────────────────────────────────────────────
const TOKEN_REFRESH_MARGIN_MS = 60000; // 1 min avant expiration

/**
 * Appelle l'endpoint Microsoft pour obtenir un nouvel access_token via refresh_token.
 * Met à jour session.tokens avec les nouveaux champs (access_token, expires_in, expires_at).
 * @param {object} session - req.session
 * @throws {Error} si le refresh échoue (401, etc.)
 */
async function refreshOutlookAccessToken(session) {
  const refreshToken = session?.tokens?.refresh_token;
  if (!refreshToken) {
    const err = new Error('Refresh token Outlook manquant');
    err.statusCode = 401;
    throw err;
  }

  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: oauthConfig.outlook.clientId,
      client_secret: oauthConfig.outlook.clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'openid profile offline_access User.Read Mail.Read Mail.ReadWrite Mail.Send'
    })
  });

  const data = await res.json();
  if (data.error) {
    console.error('❌ refreshOutlookAccessToken:', data.error, data.error_description);
    const err = new Error(data.error_description || data.error);
    err.statusCode = res.status === 401 ? 401 : 500;
    throw err;
  }

  session.tokens = {
    ...session.tokens,
    access_token: data.access_token,
    expires_in: data.expires_in,
    expires_at: Date.now() + (data.expires_in * 1000)
  };
  if (data.refresh_token) session.tokens.refresh_token = data.refresh_token;

  console.log('✅ Outlook access_token rafraîchi — expiration dans', data.expires_in, 's');
}

/**
 * Retourne un access_token valide pour Outlook : utilise celui en session s'il reste
 * plus d'une minute avant expiration, sinon appelle refreshOutlookAccessToken puis
 * retourne le nouveau token.
 * @param {object} session - req.session
 * @returns {Promise<string|null>} access_token ou null si pas de session/tokens
 */
async function getValidAccessToken(session) {
  if (!session?.tokens) return null;
  const expiresAt = session.tokens.expires_at;
  const now = Date.now();
  if (expiresAt != null && now < expiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return session.tokens.access_token;
  }
  await refreshOutlookAccessToken(session);
  return session.tokens.access_token;
}

// ─────────────────────────────────────────────
//  Champs sélectionnés dans Microsoft Graph
//  (doit inclure internetMessageHeaders pour inReplyTo / references)
// ─────────────────────────────────────────────
const OUTLOOK_SELECT_FIELDS = [
  'id',
  'conversationId',
  'subject',
  'bodyPreview',
  'from',
  'toRecipients',
  'ccRecipients',
  'sentDateTime',
  'receivedDateTime',
  'internetMessageId',
  'internetMessageHeaders',
  'body',
  'categories',
  'hasAttachments'
].join(',');

// ─────────────────────────────────────────────
//  Helpers de formatage
// ─────────────────────────────────────────────

/**
 * Formate un objet destinataire Graph en "Nom <email>" ou "email"
 */
function formatRecipient(r) {
  if (!r?.emailAddress) return '';
  const { name, address } = r.emailAddress;
  if (name && name !== address) return `${name} <${address}>`;
  return address || '';
}

/**
 * Formate un tableau de destinataires en chaîne séparée par des virgules
 */
function formatRecipients(arr) {
  if (!arr || !arr.length) return '';
  return arr.map(formatRecipient).filter(Boolean).join(', ');
}

/**
 * Supprime les balises HTML pour obtenir un texte brut lisible
 */
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─────────────────────────────────────────────
//  formatOutlookEmail
//  Transforme un message Microsoft Graph en format JSONL unifié,
//  identique au format produit par formatGmailEmail() dans gmailService.js
// ─────────────────────────────────────────────
function formatOutlookEmail(message) {
  if (!message) return null;

  // Extraction des headers internet (In-Reply-To, References, Message-ID)
  const headers = message.internetMessageHeaders || [];
  if (!headers.length) {
    console.warn(`⚠️  formatOutlookEmail: internetMessageHeaders absent pour le message ${message.id} — inReplyTo/references seront vides`);
  }
  const getHeader = (name) => {
    const h = headers.find(h => h.name?.toLowerCase() === name.toLowerCase());
    return h ? h.value : '';
  };

  // internalDate : timestamp ms sous forme de string — RÉFÉRENCE de sync incrémentale
  // Priorité : sentDateTime (emails envoyés) puis receivedDateTime (emails reçus)
  const dateStr = message.sentDateTime || message.receivedDateTime || '';
  const internalDate = dateStr ? new Date(dateStr).getTime().toString() : '0';

  // Corps de l'email : text et html séparés
  const bodyContent = message.body?.content || '';
  const isHtml = message.body?.contentType?.toLowerCase() === 'html';
  const bodyText = isHtml ? stripHtml(bodyContent) : bodyContent;
  // Strip des citations (forward-only, JSONL plus compact)
  const bodyTextStripped = stripQuotedText(bodyText);
  const bodyHtml = isHtml ? bodyContent : '';

  const formatted = {
    id: message.id || '',
    threadId: message.conversationId || '',
    snippet: message.bodyPreview || '',
    subject: message.subject || '',
    from: formatRecipient(message.from),
    to: formatRecipients(message.toRecipients),
    cc: formatRecipients(message.ccRecipients),
    date: dateStr,
    messageId: message.internetMessageId || getHeader('Message-ID') || '',
    inReplyTo: getHeader('In-Reply-To'),
    references: getHeader('References'),
    internalDate,
    hasAttachments: message.hasAttachments || false,
    bodyText: bodyTextStripped,
    bodyHtml
  };

  return formatted;
}

// ─────────────────────────────────────────────
//  buildOutlookQuery
//  Construit le filtre OData pour Microsoft Graph
//  Équivalent de buildGmailQuery() dans gmailService.js
// ─────────────────────────────────────────────
function buildOutlookQuery(filters, afterDate = null) {
  const filterParts = [];

  if (afterDate) {
    const date = new Date(parseInt(afterDate));
    const isoDate = date.toISOString();
    filterParts.push(`receivedDateTime gt ${isoDate}`);
    console.log(`📅 Outlook filtre date sync incrémentale: receivedDateTime gt ${isoDate}`);
  }

  // Les filtres de mots-clés / expéditeurs sont appliqués côté client
  // via shouldExcludeEmail — les filtres OData Graph sont limités pour les champs de texte
  if (filters && (filters.excludeNotifications || filters.excludePromotional || filters.blacklistedSenders?.length)) {
    console.log(`🔍 Outlook: filtres textuel/expéditeur appliqués côté client (shouldExcludeEmail)`);
  }

  const filter = filterParts.join(' and ') || null;
  if (filter) console.log(`🔍 Filtre OData Outlook: ${filter}`);
  return filter;
}

// shouldExcludeEmail importé depuis emailUtils.js

// ─────────────────────────────────────────────
//  getAllMessagesFromFolder
//  Récupère tous les messages d'un dossier Outlook avec pagination automatique.
//  Suit les @odata.nextLink jusqu'à épuisement.
// ─────────────────────────────────────────────
async function getAllMessagesFromFolder(accessToken, folder, filterQuery) {
  let allMessages = [];
  let pageCount = 0;

  // Construction de l'URL initiale
  // $orderby uniquement sans filtre (Graph peut rejeter orderby + filter sur certains champs)
  const orderby = filterQuery ? '' : '&$orderby=receivedDateTime desc';
  let url =
    `https://graph.microsoft.com/v1.0/me/mailfolders/${folder}/messages` +
    `?$select=${OUTLOOK_SELECT_FIELDS}` +
    `&$top=50` +
    orderby;

  if (filterQuery) {
    url += `&$filter=${encodeURIComponent(filterQuery)}`;
  }

  console.log(`📁 Début récupération dossier Outlook "${folder}"`);
  console.log(`🔗 URL initiale: ${url}`);

  while (url) {
    pageCount++;
    console.log(`📄 ${folder} — Page ${pageCount}...`);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const errMsg = errData.error?.message || response.statusText;
      console.error(`❌ Graph API erreur (dossier: ${folder}, page: ${pageCount}): ${errMsg}`);
      console.error(`❌ Code HTTP: ${response.status}`);
      throw Object.assign(new Error(`Graph API: ${errMsg}`), { statusCode: response.status });
    }

    const data = await response.json();
    const messages = data.value || [];
    allMessages = allMessages.concat(messages);

    console.log(`📄 ${folder} — Page ${pageCount}: ${messages.length} messages reçus (cumul: ${allMessages.length})`);

    // nextLink présent → il reste des pages
    url = data['@odata.nextLink'] || null;
    if (url) {
      console.log(`⏭️  ${folder} — Prochaine page disponible, continuation...`);
    }
  }

  console.log(`✅ Dossier "${folder}" terminé: ${allMessages.length} messages en ${pageCount} page(s)`);
  return allMessages;
}

// ─────────────────────────────────────────────
//  getEmailCount
//  Endpoint léger pour le polling toutes les 5 min.
//  Retourne uniquement { newCount } — aucun contenu d'email chargé.
//  Équivalent de gmailService.getEmailCount().
// ─────────────────────────────────────────────
exports.getEmailCount = async (req, res) => {
  let accessToken;
  try {
    accessToken = await getValidAccessToken(req.session);
  } catch (err) {
    if (err.statusCode === 401) {
      return res.status(401).json({ error: 'Token expiré', requiresLogout: true });
    }
    throw err;
  }
  if (!accessToken) {
    return res.status(401).json({ error: 'Non authentifié', requiresLogout: true });
  }

  const { filters, afterDate } = parseFiltersFromRequest(req);

  console.log(`📬 Outlook polling count — afterDate: ${afterDate ? new Date(parseInt(afterDate)).toISOString() : 'aucun'}`);

  // Helper : récupère uniquement les IDs d'un dossier depuis afterDate (sans charger les corps)
  async function listMessageIds(folder, filterQuery) {
    const ids = new Map();
    let url =
      `https://graph.microsoft.com/v1.0/me/mailfolders/${folder}/messages` +
      `?$select=id&$top=50` +
      (filterQuery ? `&$filter=${encodeURIComponent(filterQuery)}` : '');

    while (url) {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const errMsg = errData.error?.message || response.statusText;
        console.error(`❌ Outlook getEmailCount erreur (dossier: ${folder}): ${errMsg}`);
        throw Object.assign(new Error(`Graph API: ${errMsg}`), { statusCode: response.status });
      }

      const data = await response.json();
      (data.value || []).forEach(m => ids.set(m.id, true));
      url = data['@odata.nextLink'] || null;
    }

    return ids;
  }

  try {
    const filterQuery = buildOutlookQuery(filters, afterDate);

    // Deux appels parallèles : inbox + sentitems (comme Gmail fait INBOX + SENT + ALL MAIL)
    const [inboxIds, sentIds] = await Promise.all([
      listMessageIds('inbox', filterQuery),
      listMessageIds('sentitems', filterQuery)
    ]);

    // Déduplication
    const allIds = new Map([...inboxIds, ...sentIds]);
    const newCount = allIds.size;

    console.log(`📬 Outlook polling: ${newCount} messages depuis afterDate (${inboxIds.size} inbox + ${sentIds.size} sentitems avant dédup)`);
    res.json({ newCount });

  } catch (error) {
    console.error('❌ Erreur Outlook getEmailCount:', error);
    if (isTokenError(error)) {
      return res.status(401).json({ error: 'Token expiré', requiresLogout: true });
    }
    res.status(500).json({ error: 'Erreur comptage emails Outlook' });
  }
};

// Télécharge les emails par tranches avec SSE (via streamEmailChunks partagé)
exports.downloadEmailsInChunks = async (req, res) => {
  let accessToken;
  try {
    accessToken = await getValidAccessToken(req.session);
  } catch (err) {
    if (err.statusCode === 401) {
      return res.status(401).json({ error: 'Token expiré', requiresLogout: true });
    }
    throw err;
  }
  if (!accessToken) {
    return res.status(401).json({ error: 'Non authentifié', requiresLogout: true });
  }

  const { messageIds, chunkSize = 500, filters = null } = req.body;
  if (!messageIds || !Array.isArray(messageIds)) {
    return res.status(400).json({ error: 'Liste des IDs de messages requise' });
  }

  await streamEmailChunks(res, {
    messageIds,
    chunkSize,
    filters,
    provider: 'Outlook',
    fetchMessage: async (msgId) => {
      const url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(msgId)}?$select=${OUTLOOK_SELECT_FIELDS}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!response.ok) return null;
      const message = await response.json();
      return formatOutlookEmail(message);
    },
  });
};

// ─────────────────────────────────────────────
//  sendReply
//  Envoie une réponse à un email Outlook via Microsoft Graph.
//  Équivalent de gmailService.sendReply() pour Outlook.
//
//  Body attendu : { to, cc?, subject, body, id, threadId, messageId, references? }
//    - id        : ID interne Outlook du message auquel on répond (AAMkADAwATM0...)
//    - to        : destinataire(s) — chaîne "Nom <email>, ..."
//    - cc        : destinataires en copie (optionnel)
//    - body      : texte brut de la réponse
//    - subject   : non utilisé côté Graph (le sujet est géré automatiquement)
// ─────────────────────────────────────────────
exports.sendReply = async (req, res) => {
  let accessToken;
  try {
    accessToken = await getValidAccessToken(req.session);
  } catch (err) {
    if (err.statusCode === 401) {
      return res.status(401).json({ error: 'Token expiré', requiresLogout: true });
    }
    throw err;
  }
  if (!accessToken) {
    return res.status(401).json({ error: 'Non authentifié', requiresLogout: true });
  }

  const { id, to, cc, body } = req.body;

  if (!id || !body) {
    return res.status(400).json({ error: 'Champs requis manquants (id, body)' });
  }

  console.log(`📤 sendReply Outlook — message ID: ${id}`);
  console.log(`   To: ${to || '(non fourni)'}, CC: ${cc || '(aucun)'}`);

  // Helper : parse une chaîne "Nom <email>, ..." en tableau de recipients Graph
  function parseRecipients(str) {
    if (!str || !str.trim()) return [];
    return str.split(',')
      .map(r => r.trim())
      .filter(Boolean)
      .map(r => {
        const match = r.match(/^(.+?)\s*<([^>]+)>$/);
        if (match) {
          return { emailAddress: { name: match[1].trim(), address: match[2].trim() } };
        }
        return { emailAddress: { name: r, address: r } };
      })
      .filter(r => r.emailAddress.address.includes('@'));
  }

  const toRecipients  = parseRecipients(to);
  const ccRecipients  = parseRecipients(cc);

  console.log(`   Destinataires parsés — To: ${toRecipients.length}, CC: ${ccRecipients.length}`);

  try {
    // Microsoft Graph : POST /me/messages/{id}/reply
    // Retourne 202 Accepted sans corps si l'envoi réussit
    const url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}/reply`;
    console.log(`🔗 sendReply Outlook URL: ${url}`);

    const payload = {
      comment: body
    };

    // Ajouter les destinataires uniquement s'ils sont fournis
    // (Graph peut utiliser les destinataires originaux si on ne les précise pas)
    if (toRecipients.length > 0) {
      payload.message = { toRecipients };
    }
    if (ccRecipients.length > 0) {
      payload.message = payload.message || {};
      payload.message.ccRecipients = ccRecipients;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    // Graph retourne 202 Accepted (pas de corps) en cas de succès
    if (response.status === 202) {
      console.log(`✅ sendReply Outlook: réponse envoyée avec succès (202 Accepted)`);
      return res.json({ success: true });
    }

    // Erreur Graph
    const errData = await response.json().catch(() => ({}));
    const errMsg = errData.error?.message || response.statusText;
    console.error(`❌ sendReply Outlook erreur Graph (${response.status}): ${errMsg}`);

    if (response.status === 401) {
      return res.status(401).json({ error: 'Token expiré ou invalide', requiresLogout: true });
    }
    if (response.status === 404) {
      return res.status(404).json({ error: 'Message introuvable dans Outlook' });
    }

    res.status(500).json({ error: `Erreur lors de l'envoi : ${errMsg}` });

  } catch (error) {
    console.error('❌ Erreur sendReply Outlook:', error);
    res.status(500).json({ error: 'Erreur lors de l\'envoi de la réponse : ' + error.message });
  }
};

// Exports supplémentaires pour les tests unitaires
module.exports.formatOutlookEmail = formatOutlookEmail;
module.exports.buildOutlookQuery = buildOutlookQuery;

// ─────────────────────────────────────────────
//  OAuth — initAuth (inchangé)
// ─────────────────────────────────────────────
exports.initAuth = (req, res) => {
  console.log('🔐 Outlook initAuth — démarrage OAuth');
  // Anti-CSRF OAuth : state aléatoire stocké en session, vérifié au callback
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: oauthConfig.outlook.clientId,
    response_type: 'code',
    redirect_uri: oauthConfig.outlook.redirectUri,
    response_mode: 'query',
    scope: [
      'openid',
      'profile',
      'offline_access',
      'User.Read',
      'Mail.Read',
      'Mail.ReadWrite',
      'Mail.Send'
    ].join(' '),
    prompt: 'consent',
    state
  });
  req.session.save(() =>
    res.redirect('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?' + params.toString())
  );
};

// ─────────────────────────────────────────────
//  OAuth — handleCallback (inchangé, stocke dans req.session.tokens)
// ─────────────────────────────────────────────
exports.handleCallback = async (req, res) => {
  const code = req.query.code;

  // Vérification du state anti-CSRF (généré dans initAuth)
  const expectedState = req.session.oauthState;
  delete req.session.oauthState;
  if (!req.query.state || !expectedState || req.query.state !== expectedState) {
    console.error('❌ Outlook handleCallback: state OAuth absent ou invalide');
    return res.status(403).send('Erreur OAuth Outlook : state invalide');
  }

  console.log('🔐 Outlook handleCallback — échange du code contre les tokens');
  try {
    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: oauthConfig.outlook.clientId,
        client_secret: oauthConfig.outlook.clientSecret,
        code,
        redirect_uri: oauthConfig.outlook.redirectUri,
        grant_type: 'authorization_code',
        scope: [
          'openid',
          'profile',
          'offline_access',
          'User.Read',
          'Mail.Read',
          'Mail.ReadWrite',
          'Mail.Send'
        ].join(' ')
      })
    });
    const tokens = await tokenRes.json();

    if (tokens.error) {
      console.error('❌ Outlook handleCallback — erreur token:', tokens.error, tokens.error_description);
      return res.status(500).send('Erreur OAuth Outlook : ' + tokens.error_description);
    }

    // Pour le refresh automatique (getValidAccessToken) : date d'expiration en ms
    tokens.expires_at = Date.now() + (tokens.expires_in * 1000);
    console.log('✅ Outlook tokens reçus — expiration dans:', tokens.expires_in, 'secondes');

    // Récupérer l'email utilisateur via Microsoft Graph
    const userRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const userinfo = await userRes.json();
    const email = userinfo.mail || userinfo.userPrincipalName;

    console.log(`✅ Outlook handleCallback — utilisateur: ${email}`);

    // Régénérer la session (anti-fixation) puis stocker les tokens
    // — même clé que Gmail : req.session.tokens
    req.session.regenerate((err) => {
      if (err) {
        console.error('❌ Erreur régénération session Outlook:', err);
        return res.status(500).send('Erreur OAuth Outlook');
      }
      req.session.tokens = tokens;
      req.session.email = email;
      req.session.save(() => res.redirect('/?provider=outlook&email=' + encodeURIComponent(email)));
    });
  } catch (err) {
    console.error('❌ Erreur callback Outlook:', err);
    res.status(500).send('Erreur OAuth Outlook');
  }
};

// ─────────────────────────────────────────────
//  getEmails — refactorisé
//  Retourne la même structure que gmailService.getEmails :
//  { displayEmails, totalAvailable, messageIds, metadata }
// ─────────────────────────────────────────────
exports.getEmails = async (req, res) => {
  let accessToken;
  try {
    accessToken = await getValidAccessToken(req.session);
  } catch (err) {
    if (err.statusCode === 401) {
      return res.status(401).json({ error: 'Token expiré', requiresLogout: true });
    }
    throw err;
  }
  if (!accessToken) {
    return res.status(401).json({
      error: 'Non authentifié (pas de tokens en session)',
      requiresLogout: true
    });
  }

  const { filters, afterDate } = parseFiltersFromRequest(req);

  console.log(`📬 getEmails Outlook — afterDate: ${afterDate ? new Date(parseInt(afterDate)).toISOString() : 'aucun'}, filters: ${filters ? 'oui' : 'non'}`);

  try {
    const filterQuery = buildOutlookQuery(filters, afterDate);

    // Inbox (emails reçus)
    console.log('📥 Récupération Inbox Outlook...');
    const inboxMessages = (await getAllMessagesFromFolder(accessToken, 'inbox', filterQuery))
      .map(m => ({ ...m, _type: 'recu' }));
    console.log(`📥 Inbox: ${inboxMessages.length} messages`);

    // SentItems (emails envoyés)
    console.log('📤 Récupération SentItems Outlook...');
    const sentMessages = (await getAllMessagesFromFolder(accessToken, 'sentitems', filterQuery))
      .map(m => ({ ...m, _type: 'envoye' }));
    console.log(`📤 SentItems: ${sentMessages.length} messages`);

    // Déduplication par ID
    const allMessagesMap = new Map();
    [...inboxMessages, ...sentMessages].forEach(m => allMessagesMap.set(m.id, m));
    const allMessages = Array.from(allMessagesMap.values());
    console.log(`🔗 TOTAL Outlook: ${allMessages.length} messages uniques`);

    // Formater les 20 premiers pour affichage dans l'interface
    const displayEmails = [];
    let rejectedCount = 0;
    const emailsToProcess = allMessages.slice(0, 20);

    for (const msg of emailsToProcess) {
      const formatted = formatOutlookEmail(msg);
      if (formatted) {
        displayEmails.push(formatted);
      } else {
        rejectedCount++;
        console.warn(`⚠️  Email ignoré lors du formatage (id: ${msg.id})`);
      }
    }

    console.log(`✅ getEmails Outlook: ${displayEmails.length} emails formatés pour affichage, ${rejectedCount} rejetés`);

    res.json({
      displayEmails,
      totalAvailable: allMessages.length,
      messageIds: allMessages.map(m => ({ id: m.id, type: m._type })),
      metadata: {
        inboxCount: inboxMessages.length,
        sentCount: sentMessages.length,
        uniqueCount: allMessages.length
      }
    });

  } catch (error) {
    console.error('❌ Erreur getEmails Outlook:', error);
    if (isTokenError(error)) {
      return res.status(401).json({ error: 'Token expiré ou invalide', requiresLogout: true });
    }
    res.status(500).json({ error: 'Erreur récupération emails Outlook' });
  }
};

// ─────────────────────────────────────────────
//  getEmailDetail — bug fix (req.session.tokens, pas outlookTokens)
//  + retourne maintenant le format JSONL unifié
// ─────────────────────────────────────────────
exports.getEmailDetail = async (req, res) => {
  try {
    const { messageId } = req.params;

    let accessToken;
    try {
      accessToken = await getValidAccessToken(req.session);
    } catch (err) {
      if (err.statusCode === 401) {
        return res.status(401).json({ error: 'Token expiré ou invalide', requiresLogout: true });
      }
      throw err;
    }
    if (!accessToken) {
      return res.status(401).json({ error: 'Utilisateur non authentifié' });
    }

    console.log(`🔍 getEmailDetail Outlook: récupération du message ${messageId}`);

    const url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}?$select=${OUTLOOK_SELECT_FIELDS}`;
    console.log(`🔗 URL getEmailDetail: ${url}`);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const errMsg = errData.error?.message || response.statusText;
      console.error(`❌ Graph API getEmailDetail erreur: ${errMsg} (code HTTP: ${response.status})`);
      throw Object.assign(new Error(errMsg), { statusCode: response.status });
    }

    const message = await response.json();
    const formatted = formatOutlookEmail(message);

    console.log(`✅ getEmailDetail Outlook: message ${messageId} formaté avec succès`);
    console.log(`   subject: "${formatted.subject}", from: "${formatted.from}", internalDate: ${formatted.internalDate}`);

    res.json(formatted);

  } catch (error) {
    console.error('❌ Erreur getEmailDetail Outlook:', error);
    if (error.statusCode === 401) {
      return res.status(401).json({ error: 'Token expiré ou invalide', requiresLogout: true });
    }
    res.status(500).json({ error: 'Erreur récupération détail email' });
  }
};
