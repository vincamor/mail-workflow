const crypto = require('crypto');
const oauthConfig = require('../config/oauth');
const { streamEmailChunks, isTokenError, parseFiltersFromRequest } = require('./emailUtils');
const { stripQuotedText } = require('./quoteStripper');

// Global fetch Node 18+ (node-fetch removed — phantom dependency), wrapped with
// a 30s timeout via AbortController on all outgoing calls (Graph, MS login).
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
//  Microsoft Identity endpoint
// ─────────────────────────────────────────────
// OUTLOOK_TENANT_ID was previously read to build an MSAL client that was
// NEVER used: the three OAuth calls below hardcoded /common/. The variable was
// thus documented but had no effect, and a single-tenant Entra registration
// would fail without explanation.
//
// This MSAL client made things worse: `new ConfidentialClientApplication()`
// throws `invalid_client_credential` when the secret is empty — so a user who
// copied .env.example as-is would see the server crash at startup, before even
// configuring anything.
//
// The variable is now genuinely honoured, and the dead client has been removed.
const OUTLOOK_TENANT = oauthConfig.outlook.tenantId || 'common';
const MS_LOGIN_BASE = `https://login.microsoftonline.com/${OUTLOOK_TENANT}/oauth2/v2.0`;
const REDIRECT_URI = oauthConfig.outlook.redirectUri;

// ─────────────────────────────────────────────
//  Outlook refresh token (prevents logout after 1h)
// ─────────────────────────────────────────────
const TOKEN_REFRESH_MARGIN_MS = 60000; // 1 min before expiration

/**
 * Call Microsoft endpoint to obtain a new access_token via refresh_token.
 * Updates session.tokens with new fields (access_token, expires_in, expires_at).
 * @param {object} session - req.session
 * @throws {Error} if refresh fails (401, etc.)
 */
async function refreshOutlookAccessToken(session) {
  const refreshToken = session?.tokens?.refresh_token;
  if (!refreshToken) {
    const err = new Error('Missing Outlook refresh token');
    err.statusCode = 401;
    throw err;
  }

  const res = await fetch(`${MS_LOGIN_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: oauthConfig.outlook.clientId,
      client_secret: oauthConfig.outlook.clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'openid profile offline_access User.Read Mail.Read Mail.ReadWrite Mail.Send',
    }),
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
    expires_at: Date.now() + data.expires_in * 1000,
  };
  if (data.refresh_token) session.tokens.refresh_token = data.refresh_token;

  console.log('✅ Outlook access_token refreshed — expires in', data.expires_in, 's');
}

/**
 * Returns a valid access_token for Outlook: uses the one in session if more than
 * a minute remains before expiration, otherwise calls refreshOutlookAccessToken
 * then returns the new token.
 * @param {object} session - req.session
 * @returns {Promise<string|null>} access_token or null if no session/tokens
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
//  Fields selected in Microsoft Graph
//  (must include internetMessageHeaders for inReplyTo / references)
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
  'hasAttachments',
].join(',');

// ─────────────────────────────────────────────
//  Formatting helpers
// ─────────────────────────────────────────────

/**
 * Format a Graph recipient object as "Name <email>" or "email"
 */
function formatRecipient(r) {
  if (!r?.emailAddress) return '';
  const { name, address } = r.emailAddress;
  if (name && name !== address) return `${name} <${address}>`;
  return address || '';
}

/**
 * Format an array of recipients as a comma-separated string
 */
function formatRecipients(arr) {
  if (!arr || !arr.length) return '';
  return arr.map(formatRecipient).filter(Boolean).join(', ');
}

/**
 * Strip HTML tags to get readable plain text
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
//  Transform a Microsoft Graph message to unified JSONL format,
//  identical to the format produced by formatGmailEmail() in gmailService.js
// ─────────────────────────────────────────────
function formatOutlookEmail(message) {
  if (!message) return null;

  // Extract internet headers (In-Reply-To, References, Message-ID)
  const headers = message.internetMessageHeaders || [];
  if (!headers.length) {
    console.warn(
      `⚠️  formatOutlookEmail: internetMessageHeaders missing for message ${message.id} — inReplyTo/references will be empty`
    );
  }
  const getHeader = (name) => {
    const h = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
    return h ? h.value : '';
  };

  // internalDate: timestamp in ms as string — REFERENCE for incremental sync
  // Priority: sentDateTime (sent emails) then receivedDateTime (received emails)
  const dateStr = message.sentDateTime || message.receivedDateTime || '';
  const internalDate = dateStr ? new Date(dateStr).getTime().toString() : '0';

  // Email body: text and html separated
  const bodyContent = message.body?.content || '';
  const isHtml = message.body?.contentType?.toLowerCase() === 'html';
  const bodyText = isHtml ? stripHtml(bodyContent) : bodyContent;
  // Strip of quoted text (forward-only, more compact JSONL)
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
    bodyHtml,
  };

  return formatted;
}

// ─────────────────────────────────────────────
//  buildOutlookQuery
//  Build OData filter for Microsoft Graph
//  Equivalent of buildGmailQuery() in gmailService.js
// ─────────────────────────────────────────────
function buildOutlookQuery(filters, afterDate = null) {
  const filterParts = [];

  if (afterDate) {
    const date = new Date(parseInt(afterDate));
    const isoDate = date.toISOString();
    filterParts.push(`receivedDateTime gt ${isoDate}`);
    console.log(`📅 Outlook incremental sync date filter: receivedDateTime gt ${isoDate}`);
  }

  // Keyword/sender filters are applied client-side
  // via shouldExcludeEmail — OData Graph filters are limited for text fields
  if (
    filters &&
    (filters.excludeNotifications ||
      filters.excludePromotional ||
      filters.blacklistedSenders?.length)
  ) {
    console.log(`🔍 Outlook: text/sender filters applied client-side (shouldExcludeEmail)`);
  }

  const filter = filterParts.join(' and ') || null;
  if (filter) console.log(`🔍 Outlook OData filter: ${filter}`);
  return filter;
}

// shouldExcludeEmail imported from emailUtils.js

// ─────────────────────────────────────────────
//  getAllMessagesFromFolder
//  Retrieve all messages from an Outlook folder with automatic pagination.
//  Follow @odata.nextLink until exhaustion.
// ─────────────────────────────────────────────
async function getAllMessagesFromFolder(accessToken, folder, filterQuery) {
  let allMessages = [];
  let pageCount = 0;

  // Build initial URL
  // $orderby only without filter (Graph may reject orderby + filter on certain fields)
  const orderby = filterQuery ? '' : '&$orderby=receivedDateTime desc';
  let url =
    `https://graph.microsoft.com/v1.0/me/mailfolders/${folder}/messages` +
    `?$select=${OUTLOOK_SELECT_FIELDS}` +
    `&$top=50` +
    orderby;

  if (filterQuery) {
    url += `&$filter=${encodeURIComponent(filterQuery)}`;
  }

  console.log(`📁 Start retrieving Outlook folder "${folder}"`);
  console.log(`🔗 Initial URL: ${url}`);

  while (url) {
    pageCount++;
    console.log(`📄 ${folder} — Page ${pageCount}...`);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const errMsg = errData.error?.message || response.statusText;
      console.error(`❌ Graph API error (folder: ${folder}, page: ${pageCount}): ${errMsg}`);
      console.error(`❌ HTTP code: ${response.status}`);
      throw Object.assign(new Error(`Graph API: ${errMsg}`), { statusCode: response.status });
    }

    const data = await response.json();
    const messages = data.value || [];
    allMessages = allMessages.concat(messages);

    console.log(
      `📄 ${folder} — Page ${pageCount}: ${messages.length} messages received (total: ${allMessages.length})`
    );

    // nextLink present → more pages remain
    url = data['@odata.nextLink'] || null;
    if (url) {
      console.log(`⏭️  ${folder} — Next page available, continuing...`);
    }
  }

  console.log(
    `✅ Folder "${folder}" complete: ${allMessages.length} messages in ${pageCount} page(s)`
  );
  return allMessages;
}

// ─────────────────────────────────────────────
//  getEmailCount
//  Lightweight endpoint for polling every 5 minutes.
//  Returns only { newCount } — no email content loaded.
//  Equivalent of gmailService.getEmailCount().
// ─────────────────────────────────────────────
exports.getEmailCount = async (req, res) => {
  let accessToken;
  try {
    accessToken = await getValidAccessToken(req.session);
  } catch (err) {
    if (err.statusCode === 401) {
      return res.status(401).json({ error: 'Token expired', requiresLogout: true });
    }
    throw err;
  }
  if (!accessToken) {
    return res.status(401).json({ error: 'Not authenticated', requiresLogout: true });
  }

  const { filters, afterDate } = parseFiltersFromRequest(req);

  console.log(
    `📬 Outlook polling count — afterDate: ${afterDate ? new Date(parseInt(afterDate)).toISOString() : 'none'}`
  );

  // Helper: retrieve only IDs from a folder since afterDate (without loading bodies)
  async function listMessageIds(folder, filterQuery) {
    const ids = new Map();
    let url =
      `https://graph.microsoft.com/v1.0/me/mailfolders/${folder}/messages` +
      `?$select=id&$top=50` +
      (filterQuery ? `&$filter=${encodeURIComponent(filterQuery)}` : '');

    while (url) {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const errMsg = errData.error?.message || response.statusText;
        console.error(`❌ Outlook getEmailCount error (folder: ${folder}): ${errMsg}`);
        throw Object.assign(new Error(`Graph API: ${errMsg}`), { statusCode: response.status });
      }

      const data = await response.json();
      (data.value || []).forEach((m) => ids.set(m.id, true));
      url = data['@odata.nextLink'] || null;
    }

    return ids;
  }

  try {
    const filterQuery = buildOutlookQuery(filters, afterDate);

    // Two parallel calls: inbox + sentitems (like Gmail does INBOX + SENT + ALL MAIL)
    const [inboxIds, sentIds] = await Promise.all([
      listMessageIds('inbox', filterQuery),
      listMessageIds('sentitems', filterQuery),
    ]);

    // Deduplication
    const allIds = new Map([...inboxIds, ...sentIds]);
    const newCount = allIds.size;

    console.log(
      `📬 Outlook polling: ${newCount} messages since afterDate (${inboxIds.size} inbox + ${sentIds.size} sentitems before dedup)`
    );
    res.json({ newCount });
  } catch (error) {
    console.error('❌ Outlook getEmailCount error:', error);
    if (isTokenError(error)) {
      return res.status(401).json({ error: 'Token expired', requiresLogout: true });
    }
    res.status(500).json({ error: 'Error counting Outlook emails' });
  }
};

// Download emails in chunks with SSE (via shared streamEmailChunks)
exports.downloadEmailsInChunks = async (req, res) => {
  let accessToken;
  try {
    accessToken = await getValidAccessToken(req.session);
  } catch (err) {
    if (err.statusCode === 401) {
      return res.status(401).json({ error: 'Token expired', requiresLogout: true });
    }
    throw err;
  }
  if (!accessToken) {
    return res.status(401).json({ error: 'Not authenticated', requiresLogout: true });
  }

  const { messageIds, chunkSize = 500, filters = null } = req.body;
  if (!messageIds || !Array.isArray(messageIds)) {
    return res.status(400).json({ error: 'List of message IDs required' });
  }

  await streamEmailChunks(res, {
    messageIds,
    chunkSize,
    filters,
    provider: 'Outlook',
    fetchMessage: async (msgId) => {
      const url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(msgId)}?$select=${OUTLOOK_SELECT_FIELDS}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) return null;
      const message = await response.json();
      return formatOutlookEmail(message);
    },
  });
};

// ─────────────────────────────────────────────
//  sendReply
//  Send a reply to an Outlook email via Microsoft Graph.
//  Equivalent of gmailService.sendReply() for Outlook.
//
//  Expected body: { to, cc?, subject, body, id, threadId, messageId, references? }
//    - id        : Internal Outlook ID of the message being replied to (AAMkADAwATM0...)
//    - to        : recipient(s) — string "Name <email>, ..."
//    - cc        : carbon copy recipients (optional)
//    - body      : plain text of the reply
//    - subject   : not used on Graph side (subject is managed automatically)
// ─────────────────────────────────────────────
exports.sendReply = async (req, res) => {
  let accessToken;
  try {
    accessToken = await getValidAccessToken(req.session);
  } catch (err) {
    if (err.statusCode === 401) {
      return res.status(401).json({ error: 'Token expired', requiresLogout: true });
    }
    throw err;
  }
  if (!accessToken) {
    return res.status(401).json({ error: 'Not authenticated', requiresLogout: true });
  }

  const { id, to, cc, body } = req.body;

  if (!id || !body) {
    return res.status(400).json({ error: 'Missing required fields (id, body)' });
  }

  console.log(`📤 Outlook sendReply — message ID: ${id}`);
  console.log(`   To: ${to || '(not provided)'}, CC: ${cc || '(none)'}`);

  // Helper: parse a string "Name <email>, ..." to Graph recipients array
  function parseRecipients(str) {
    if (!str || !str.trim()) return [];
    return str
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const match = r.match(/^(.+?)\s*<([^>]+)>$/);
        if (match) {
          return { emailAddress: { name: match[1].trim(), address: match[2].trim() } };
        }
        return { emailAddress: { name: r, address: r } };
      })
      .filter((r) => r.emailAddress.address.includes('@'));
  }

  const toRecipients = parseRecipients(to);
  const ccRecipients = parseRecipients(cc);

  console.log(`   Parsed recipients — To: ${toRecipients.length}, CC: ${ccRecipients.length}`);

  try {
    // Microsoft Graph: POST /me/messages/{id}/reply
    // Returns 202 Accepted without body if send succeeds
    const url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}/reply`;
    console.log(`🔗 Outlook sendReply URL: ${url}`);

    const payload = {
      comment: body,
    };

    // Add recipients only if provided
    // (Graph may use original recipients if not specified)
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
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    // Graph returns 202 Accepted (no body) on success
    if (response.status === 202) {
      console.log(`✅ Outlook sendReply: reply sent successfully (202 Accepted)`);
      return res.json({ success: true });
    }

    // Graph error
    const errData = await response.json().catch(() => ({}));
    const errMsg = errData.error?.message || response.statusText;
    console.error(`❌ Outlook sendReply Graph error (${response.status}): ${errMsg}`);

    if (response.status === 401) {
      return res.status(401).json({ error: 'Token expired or invalid', requiresLogout: true });
    }
    if (response.status === 404) {
      return res.status(404).json({ error: 'Message not found in Outlook' });
    }

    res.status(500).json({ error: `Error sending: ${errMsg}` });
  } catch (error) {
    console.error('❌ Outlook sendReply error:', error);
    res.status(500).json({ error: 'Error sending reply: ' + error.message });
  }
};

// Additional exports for unit tests
module.exports.formatOutlookEmail = formatOutlookEmail;
module.exports.buildOutlookQuery = buildOutlookQuery;

// ─────────────────────────────────────────────
//  OAuth — initAuth (unchanged)
// ─────────────────────────────────────────────
exports.initAuth = (req, res) => {
  console.log('🔐 Outlook initAuth — starting OAuth');
  // Anti-CSRF OAuth: random state stored in session, verified at callback
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
      'Mail.Send',
    ].join(' '),
    prompt: 'consent',
    state,
  });
  req.session.save(() => res.redirect(`${MS_LOGIN_BASE}/authorize?` + params.toString()));
};

// ─────────────────────────────────────────────
//  OAuth — handleCallback (unchanged, stores in req.session.tokens)
// ─────────────────────────────────────────────
exports.handleCallback = async (req, res) => {
  const code = req.query.code;

  // Anti-CSRF state verification (generated in initAuth)
  const expectedState = req.session.oauthState;
  delete req.session.oauthState;
  if (!req.query.state || !expectedState || req.query.state !== expectedState) {
    console.error('❌ Outlook handleCallback: OAuth state missing or invalid');
    return res.status(403).send('Outlook OAuth error: invalid state');
  }

  console.log('🔐 Outlook handleCallback — exchanging code for tokens');
  try {
    const tokenRes = await fetch(`${MS_LOGIN_BASE}/token`, {
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
          'Mail.Send',
        ].join(' '),
      }),
    });
    const tokens = await tokenRes.json();

    if (tokens.error) {
      console.error(
        '❌ Outlook handleCallback — token error:',
        tokens.error,
        tokens.error_description
      );
      return res.status(500).send('Outlook OAuth error: ' + tokens.error_description);
    }

    // For automatic refresh (getValidAccessToken): expiration date in ms
    tokens.expires_at = Date.now() + tokens.expires_in * 1000;
    console.log('✅ Outlook tokens received — expires in:', tokens.expires_in, 'seconds');

    // Retrieve user email via Microsoft Graph
    const userRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userinfo = await userRes.json();
    const email = userinfo.mail || userinfo.userPrincipalName;

    console.log(`✅ Outlook handleCallback — user: ${email}`);

    // Regenerate session (anti-fixation) then store tokens
    // — same key as Gmail: req.session.tokens
    req.session.regenerate((err) => {
      if (err) {
        console.error('❌ Outlook session regeneration error:', err);
        return res.status(500).send('Outlook OAuth error');
      }
      req.session.tokens = tokens;
      req.session.email = email;
      req.session.save(() => res.redirect('/?provider=outlook&email=' + encodeURIComponent(email)));
    });
  } catch (err) {
    console.error('❌ Outlook callback error:', err);
    res.status(500).send('Outlook OAuth error');
  }
};

// ─────────────────────────────────────────────
//  getEmails — refactored
//  Return the same structure as gmailService.getEmails:
//  { displayEmails, totalAvailable, messageIds, metadata }
// ─────────────────────────────────────────────
exports.getEmails = async (req, res) => {
  let accessToken;
  try {
    accessToken = await getValidAccessToken(req.session);
  } catch (err) {
    if (err.statusCode === 401) {
      return res.status(401).json({ error: 'Token expired', requiresLogout: true });
    }
    throw err;
  }
  if (!accessToken) {
    return res.status(401).json({
      error: 'Not authenticated (no tokens in session)',
      requiresLogout: true,
    });
  }

  const { filters, afterDate } = parseFiltersFromRequest(req);

  console.log(
    `📬 Outlook getEmails — afterDate: ${afterDate ? new Date(parseInt(afterDate)).toISOString() : 'none'}, filters: ${filters ? 'yes' : 'no'}`
  );

  try {
    const filterQuery = buildOutlookQuery(filters, afterDate);

    // Inbox (received emails)
    console.log('📥 Retrieving Outlook Inbox...');
    const inboxMessages = (await getAllMessagesFromFolder(accessToken, 'inbox', filterQuery)).map(
      (m) => ({ ...m, _type: 'recu' })
    );
    console.log(`📥 Inbox: ${inboxMessages.length} messages`);

    // SentItems (sent emails)
    console.log('📤 Retrieving Outlook SentItems...');
    const sentMessages = (
      await getAllMessagesFromFolder(accessToken, 'sentitems', filterQuery)
    ).map((m) => ({ ...m, _type: 'envoye' }));
    console.log(`📤 SentItems: ${sentMessages.length} messages`);

    // Deduplication by ID
    const allMessagesMap = new Map();
    [...inboxMessages, ...sentMessages].forEach((m) => allMessagesMap.set(m.id, m));
    const allMessages = Array.from(allMessagesMap.values());
    console.log(`🔗 TOTAL Outlook: ${allMessages.length} unique messages`);

    // Format the first 20 for display in the interface
    const displayEmails = [];
    let rejectedCount = 0;
    const emailsToProcess = allMessages.slice(0, 20);

    for (const msg of emailsToProcess) {
      const formatted = formatOutlookEmail(msg);
      if (formatted) {
        displayEmails.push(formatted);
      } else {
        rejectedCount++;
        console.warn(`⚠️  Email ignored during formatting (id: ${msg.id})`);
      }
    }

    console.log(
      `✅ Outlook getEmails: ${displayEmails.length} emails formatted for display, ${rejectedCount} rejected`
    );

    res.json({
      displayEmails,
      totalAvailable: allMessages.length,
      messageIds: allMessages.map((m) => ({ id: m.id, type: m._type })),
      metadata: {
        inboxCount: inboxMessages.length,
        sentCount: sentMessages.length,
        uniqueCount: allMessages.length,
      },
    });
  } catch (error) {
    console.error('❌ Outlook getEmails error:', error);
    if (isTokenError(error)) {
      return res.status(401).json({ error: 'Token expired or invalid', requiresLogout: true });
    }
    res.status(500).json({ error: 'Error retrieving Outlook emails' });
  }
};

// ─────────────────────────────────────────────
//  getEmailDetail — bug fix (req.session.tokens, not outlookTokens)
//  + now returns unified JSONL format
// ─────────────────────────────────────────────
exports.getEmailDetail = async (req, res) => {
  try {
    const { messageId } = req.params;

    let accessToken;
    try {
      accessToken = await getValidAccessToken(req.session);
    } catch (err) {
      if (err.statusCode === 401) {
        return res.status(401).json({ error: 'Token expired or invalid', requiresLogout: true });
      }
      throw err;
    }
    if (!accessToken) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log(`🔍 Outlook getEmailDetail: retrieving message ${messageId}`);

    const url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}?$select=${OUTLOOK_SELECT_FIELDS}`;
    console.log(`🔗 getEmailDetail URL: ${url}`);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const errMsg = errData.error?.message || response.statusText;
      console.error(`❌ Graph API getEmailDetail error: ${errMsg} (HTTP code: ${response.status})`);
      throw Object.assign(new Error(errMsg), { statusCode: response.status });
    }

    const message = await response.json();
    const formatted = formatOutlookEmail(message);

    console.log(`✅ Outlook getEmailDetail: message ${messageId} formatted successfully`);
    console.log(
      `   subject: "${formatted.subject}", from: "${formatted.from}", internalDate: ${formatted.internalDate}`
    );

    res.json(formatted);
  } catch (error) {
    console.error('❌ Outlook getEmailDetail error:', error);
    if (error.statusCode === 401) {
      return res.status(401).json({ error: 'Token expired or invalid', requiresLogout: true });
    }
    res.status(500).json({ error: 'Error retrieving email detail' });
  }
};
