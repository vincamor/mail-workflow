const crypto = require('crypto');
const { google } = require('googleapis');
const oauthConfig = require('../config/oauth');
const { streamEmailChunks, isTokenError, parseFiltersFromRequest } = require('./emailUtils');
const { stripQuotedText } = require('./quoteStripper');

// Global timeout (30s) on all outgoing googleapis (gaxios) calls
google.options({ timeout: 30000 });
// Removal of all DB dependencies and local storage

// Utility function to decode base64 data from Gmail emails
function decodeBase64Data(data) {
  if (!data) return '';
  try {
    // Handling special characters in base64
    const cleanData = data.replace(/-/g, '+').replace(/_/g, '/');
    const buffer = Buffer.from(cleanData, 'base64');
    return buffer.toString('utf-8');
  } catch (error) {
    console.error('Base64 decoding error:', error);
    return data; // Returns original data if decoding fails
  }
}

// Function to extract and decode the content of a Gmail email
function extractEmailContent(payload) {
  if (!payload) return { text: '', html: '' };

  let textContent = '';
  let htmlContent = '';

  // Recursive function to traverse payload parts
  function processPart(part) {
    if (!part) return;

    // If it's a part with data
    if (part.body && part.body.data) {
      const decodedContent = decodeBase64Data(part.body.data);

      if (part.mimeType === 'text/plain') {
        textContent = decodedContent;
      } else if (part.mimeType === 'text/html') {
        htmlContent = decodedContent;
      }
    }

    // Process subparts if they exist
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

// Function to clean and format a Gmail email
function formatGmailEmail(email) {
  if (!email) return null;

  // Extract headers
  const headers = email.payload?.headers || [];
  const getHeader = (name) => {
    const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
    return header ? header.value : '';
  };

  // Extract content
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
    // Decoded content — bodyText is stripped of quoted text (forward-only, more compact JSONL)
    bodyText: stripQuotedText(content.text),
    bodyHtml: content.html,
  };
}

// Initialize Gmail OAuth
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
  // Anti-CSRF OAuth: random state stored in session, verified at callback
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

// Gmail OAuth callback
exports.handleCallback = async (req, res) => {
  const code = req.query.code;

  // Anti-CSRF state verification (generated in initAuth)
  const expectedState = req.session.oauthState;
  delete req.session.oauthState;
  if (!req.query.state || !expectedState || req.query.state !== expectedState) {
    console.error('Gmail callback error: OAuth state missing or invalid');
    return res.status(403).send('Gmail OAuth error: invalid state');
  }

  const oauth2Client = new google.auth.OAuth2(
    oauthConfig.gmail.clientId,
    oauthConfig.gmail.clientSecret,
    oauthConfig.gmail.redirectUri
  );
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    // Retrieve user email
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userinfo = await oauth2.userinfo.get();
    const email = userinfo.data.email;
    // Regenerate session (anti-fixation) then store tokens
    req.session.regenerate((err) => {
      if (err) {
        console.error('Gmail session regeneration error:', err);
        return res.status(500).send('Gmail OAuth error');
      }
      req.session.tokens = tokens;
      req.session.email = email;
      // Redirect to frontend with email and provider
      req.session.save(() => res.redirect('/?provider=gmail&email=' + encodeURIComponent(email)));
    });
  } catch (err) {
    console.error('Gmail callback error:', err);
    res.status(500).send('Gmail OAuth error');
  }
};

// Retrieve emails for a user (directly via Gmail API)
exports.getEmails = async (req, res) => {
  const tokens = req.session.tokens;
  if (!tokens) {
    return res.status(401).json({
      error: 'Not authenticated (no tokens in session)',
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

  // Helper function to retrieve all messages with pagination
  async function getAllMessages(labelIds = null, maxResults = 5000, query = '') {
    let allMessages = [];
    let nextPageToken = null;
    let pageCount = 0;

    do {
      pageCount++;
      console.log(`📄 Page ${pageCount} - Retrieving messages...`);

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
        `📄 Page ${pageCount} - ${messages.length} messages retrieved (total: ${allMessages.length})`
      );
    } while (nextPageToken);

    return allMessages;
  }

  try {
    // Build Gmail query from filters + afterDate (incremental sync)
    const gmailQuery = buildGmailQuery(filters, afterDate);

    if (gmailQuery) {
      console.log(`🔍 Applying Gmail API filters: ${gmailQuery}`);
      console.log(`📋 Filters received:`, JSON.stringify(filters, null, 2));
      if (afterDate)
        console.log(
          `📅 Incremental sync mode since: ${new Date(parseInt(afterDate)).toISOString()}`
        );
    } else {
      console.log(`⚠️ No filters applied — full download`);
    }

    // INBOX - received emails with pagination (all available emails)
    console.log('📥 Retrieving INBOX emails...');
    const inboxMessages = (await getAllMessages(['INBOX'], 5000, gmailQuery)).map((m) => ({
      ...m,
      _type: 'recu',
    }));
    console.log(`📥 INBOX: ${inboxMessages.length} messages`);

    // SENT - sent emails with pagination (all available emails)
    console.log('📤 Retrieving SENT emails...');
    const sentMessages = (await getAllMessages(['SENT'], 5000, gmailQuery)).map((m) => ({
      ...m,
      _type: 'envoye',
    }));
    console.log(`📤 SENT: ${sentMessages.length} messages`);

    // ALL MAIL - archived/other labels emails with pagination (all available emails)
    console.log('📁 Retrieving ALL MAIL emails...');
    const allMailMessages = (await getAllMessages(null, 5000, gmailQuery)).map((m) => ({
      ...m,
      _type: 'archive',
    }));
    console.log(`📁 ALL MAIL: ${allMailMessages.length} messages`);

    // Merging and deduplication
    const allMessagesMap = new Map();
    [...inboxMessages, ...sentMessages, ...allMailMessages].forEach((m) => {
      allMessagesMap.set(m.id, m);
    });
    const allMessages = Array.from(allMessagesMap.values());
    console.log(`🔗 TOTAL: ${allMessages.length} unique messages`);

    // Retrieving details (only for display - first 20)
    const displayEmails = [];
    let rejectedCount = 0;

    // Process only the first 20 for display
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
      `✅ ${displayEmails.length} emails displayed (out of ${allMessages.length} available)`
    );
    console.log(`❌ ${rejectedCount} emails rejected`);

    // Return display emails + metadata for download
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
    console.error('❌ Error:', error);

    if (isTokenError(error)) {
      return res.status(401).json({ error: 'Token expired or invalid', requiresLogout: true });
    }
    res.status(500).json({ error: 'Error retrieving emails' });
  }
};

/**
 * Convert filters to Gmail API query
 * @param {Object} filters - Filter configuration
 * @param {string|null} afterDate - Gmail internalDate (ms since epoch) of the last stored email.
 *   If provided, adds "after:YYYY/MM/DD" to the query for incremental sync.
 *   If null, no date filter (behavior identical to full download).
 * @returns {string} - Query string for Gmail API
 */
function buildGmailQuery(filters, afterDate = null) {
  const queryParts = [];

  // Date filter for incremental sync (optional)
  if (afterDate) {
    const date = new Date(parseInt(afterDate));
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    queryParts.push(`after:${year}/${month}/${day}`);
    console.log(`📅 Incremental sync date filter: after:${year}/${month}/${day}`);
  }

  if (!filters) {
    const query = queryParts.join(' ');
    if (query) console.log(`🔍 Gmail query: ${query}`);
    return query;
  }

  // 1. Exclude notifications by sender
  if (filters.excludeNotifications && filters.notificationKeywords) {
    filters.notificationKeywords.forEach((keyword) => {
      queryParts.push(`-from:${keyword}`);
    });
  }

  // 2. Exclude blacklisted senders
  if (filters.blacklistedSenders && filters.blacklistedSenders.length > 0) {
    filters.blacklistedSenders.forEach((sender) => {
      // Extract just the email address if format "Name <email>"
      const match = sender.match(/<([^>]+)>/);
      const emailOnly = match ? match[1] : sender;
      queryParts.push(`-from:${emailOnly}`);
    });
  }

  // 3. Exclude subject keywords
  if (filters.blacklistedKeywords && filters.blacklistedKeywords.length > 0) {
    filters.blacklistedKeywords.forEach((keyword) => {
      queryParts.push(`-subject:"${keyword}"`);
    });
  }

  // 4. Exclude promotions by keywords
  if (filters.excludePromotional && filters.promotionalKeywords) {
    filters.promotionalKeywords.forEach((keyword) => {
      queryParts.push(`-subject:${keyword}`);
    });
  }

  // 5. Exclude emails without subject (not directly supported by Gmail API)
  // We'll filter them server-side after download

  const query = queryParts.join(' ');
  if (query) {
    console.log(`🔍 Gmail query: ${query}`);
  }

  return query;
}

// shouldExcludeEmail imported from emailUtils.js

// Download emails in chunks with SSE progress (via shared streamEmailChunks)
exports.downloadEmailsInChunks = async (req, res) => {
  const tokens = req.session.tokens;
  if (!tokens) {
    return res.status(401).json({ error: 'Not authenticated', requiresLogout: true });
  }

  const { messageIds, chunkSize = 500, filters = null } = req.body;
  if (!messageIds || !Array.isArray(messageIds)) {
    return res.status(400).json({ error: 'List of message IDs required' });
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
 * Returns only the count of available messages since a given date.
 * Lightweight endpoint used for polling every 5 minutes — does not retrieve any email content.
 */
exports.getEmailCount = async (req, res) => {
  const tokens = req.session.tokens;
  if (!tokens) {
    return res.status(401).json({ error: 'Not authenticated', requiresLogout: true });
  }

  const { filters, afterDate } = parseFiltersFromRequest(req);

  const oauth2Client = new google.auth.OAuth2(
    oauthConfig.gmail.clientId,
    oauthConfig.gmail.clientSecret,
    oauthConfig.gmail.redirectUri
  );
  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Local helper to list IDs (without retrieving details)
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

    // Deduplication
    const allIds = new Map([...inboxIds, ...sentIds, ...allMailIds]);
    const newCount = allIds.size;

    console.log(
      `📬 Polling count: ${newCount} messages (afterDate: ${afterDate ? new Date(parseInt(afterDate)).toISOString() : 'none'})`
    );
    res.json({ newCount });
  } catch (error) {
    console.error('❌ getEmailCount error:', error);
    if (isTokenError(error)) {
      return res.status(401).json({ error: 'Token expired', requiresLogout: true });
    }
    res.status(500).json({ error: 'Error counting emails' });
  }
};

/**
 * Send a reply to an email in an existing Gmail thread.
 * Requires gmail.send scope.
 *
 * Expected body: { to, cc?, subject, body, threadId, messageId, references? }
 *   - to         : recipient(s) — address from the original email's from field
 *   - cc         : carbon copy recipients (optional)
 *   - subject    : subject of the original email (prefixed with "Re:" if absent)
 *   - body       : plain text of the reply
 *   - threadId   : ID of the Gmail thread (to attach reply to the correct conversation)
 *   - messageId  : Message-ID of the email being replied to (for In-Reply-To)
 *   - references : References chain of the original email (optional)
 */
exports.sendReply = async (req, res) => {
  const tokens = req.session.tokens;
  if (!tokens) {
    return res.status(401).json({ error: 'Not authenticated', requiresLogout: true });
  }

  const { to, cc, subject, body, threadId, messageId, references } = req.body;

  if (!to || !body || !threadId || !messageId) {
    return res
      .status(400)
      .json({ error: 'Missing required fields (to, body, threadId, messageId)' });
  }

  const oauth2Client = new google.auth.OAuth2(
    oauthConfig.gmail.clientId,
    oauthConfig.gmail.clientSecret,
    oauthConfig.gmail.redirectUri
  );
  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  try {
    // Building subject — avoid doubling "Re:"
    const replySubject = /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;

    // References chain: adds the messageId of the original email at the end
    const replyReferences = references ? `${references} ${messageId}` : messageId;

    // Building RFC 2822 message
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

    console.log(`✅ Reply sent — id: ${response.data.id}, thread: ${threadId}`);
    res.json({ success: true, messageId: response.data.id });
  } catch (error) {
    console.error('❌ sendReply error:', error);
    if (isTokenError(error)) {
      return res.status(401).json({ error: 'Token expired', requiresLogout: true });
    }
    res.status(500).json({ error: 'Error sending reply: ' + error.message });
  }
};

// Additional exports for unit tests
module.exports.formatGmailEmail = formatGmailEmail;
module.exports.buildGmailQuery = buildGmailQuery;
