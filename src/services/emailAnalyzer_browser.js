// === CORE FUNCTIONS ===

/**
 * Decodes base64 data from Gmail emails
 * @param {string} data - Base64 data to decode
 * @returns {string} - Decoded data
 */
function decodeBase64Data(data) {
  if (!data) return '';
  try {
    // Handling of special characters in base64
    // `let`, not `const`: padding is appended right below. With `const`,
    // the assignment threw a TypeError that was swallowed by the catch, and the
    // function returned the raw base64 instead of the decoded text — silently.
    let cleanData = data.replace(/-/g, '+').replace(/_/g, '/');
    const missingPadding = cleanData.length % 4;
    if (missingPadding) {
      cleanData += '='.repeat(4 - missingPadding);
    }

    const decodedString = atob(cleanData);
    return decodeURIComponent(escape(decodedString));
  } catch (error) {
    console.warn(`⚠️  Decoding error: ${error}`);
    return data;
  }
}

/**
 * Loads emails from a FileSystemHandle in chunks
 * @param {FileSystemFileHandle} fileHandle - File handle
 * @param {number} chunkSize - Chunk size (default: 500)
 * @returns {Array} - List of emails with chunk indices
 */
async function loadEmailsFromHandle(fileHandle, _chunkSize = 500) {
  const emails = [];

  try {
    const file = await fileHandle.getFile();

    let chunkCount = 0;
    const stream = file.stream();
    const textDecoder = new TextDecoder();

    // Buffer for incomplete lines
    let buffer = '';

    for await (const chunk of stream) {
      chunkCount++;
      const chunkText = textDecoder.decode(chunk, { stream: true });
      buffer += chunkText;

      // Process the complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep the last incomplete line

      // Process the complete lines
      for (const line of lines) {
        if (line.trim()) {
          try {
            const full = JSON.parse(line);
            // Immediately build a lightweight object with only the fields used.
            // The full object (full) — which holds bodyHtml and originalPayload —
            // goes out of scope at the end of this block and becomes GC-eligible
            // right away, avoiding an accumulation of 80+ KB per email in the heap.
            emails.push({
              id: full.id,
              threadId: full.threadId,
              subject: full.subject,
              from: full.from,
              to: full.to,
              cc: full.cc,
              date: full.date,
              messageId: full.messageId,
              inReplyTo: full.inReplyTo,
              references: full.references,
              internalDate: full.internalDate,
              bodyText: full.bodyText,
              snippet: full.snippet,
              labelIds: full.labelIds,
              hasAttachments: full.hasAttachments,
              _chunkIndex: chunkCount,
            });
          } catch (e) {
            console.warn('Malformed line ignored:', line.substring(0, 50));
          }
        }
      }
    }

    // Process the last line if it exists
    if (buffer.trim()) {
      try {
        const full = JSON.parse(buffer);
        emails.push({
          id: full.id,
          threadId: full.threadId,
          subject: full.subject,
          from: full.from,
          to: full.to,
          cc: full.cc,
          date: full.date,
          messageId: full.messageId,
          inReplyTo: full.inReplyTo,
          references: full.references,
          internalDate: full.internalDate,
          bodyText: full.bodyText,
          snippet: full.snippet,
          labelIds: full.labelIds,
          hasAttachments: full.hasAttachments,
          _chunkIndex: chunkCount,
        });
      } catch (e) {
        console.warn('Last malformed line ignored');
      }
    }

    console.log(`✅ ${emails.length} emails loaded in ${chunkCount} chunks`);
    return emails;
  } catch (error) {
    console.error('Error loading emails by chunks:', error);
    return [];
  }
}

/**
 * Extracts and cleans up the subject
 * @param {Object} email - Email to process
 * @returns {string} - Cleaned subject
 */
function extractSubject(email) {
  let subject = '';

  // First look directly in email.subject
  if (email.subject) {
    subject = email.subject;
  }
  // Otherwise look in the headers (fallback)
  else if (email.payload && email.payload.headers) {
    subject = 'No subject';
    for (const header of email.payload.headers) {
      if (header.name.toLowerCase() === 'subject') {
        subject = header.value;
        break;
      }
    }
  } else {
    return 'No subject';
  }

  // Clean-up (removes Re:, Fwd:, etc.)
  subject = subject.replace(/^(Re:|Fwd:|FW:|RE:|FWD:)\s*/i, '');
  return subject.trim();
}

/**
 * Extracts the sender
 * @param {Object} email - Email to process
 * @returns {string} - Sender
 */
function extractFrom(email) {
  // First look directly in email.from
  if (email.from) {
    return email.from;
  }
  // Otherwise look in the headers (fallback)
  else if (email.payload && email.payload.headers) {
    for (const header of email.payload.headers) {
      if (header.name.toLowerCase() === 'from') {
        return header.value;
      }
    }
  }
  return 'Unknown';
}

/**
 * Extracts the date
 * @param {Object} email - Email to process
 * @returns {Date} - Email date
 */
function extractDate(email) {
  if (email.internalDate) {
    const timestamp = parseInt(email.internalDate) / 1000;
    return new Date(timestamp * 1000);
  }
  return new Date();
}

/**
 * Extracts the body content
 * @param {Object} email - Email to process
 * @returns {string} - Body content
 */
function extractBodyContent(email) {
  // If the server has already decoded the content (gmailService format), use it directly
  if (email.bodyText) {
    return email.bodyText;
  }

  // Fallback to the snippet (bodyText is always present since it is decoded server-side)
  return email.snippet || '';
}

// === ANALYSIS FUNCTIONS ===

/**
 * Groups emails by subject
 * @param {Array} emails - List of emails
 * @returns {Object} - Emails grouped by subject
 */
function groupBySubject(emails) {
  const conversations = {};

  for (const email of emails) {
    const subject = extractSubject(email);
    if (!conversations[subject]) {
      conversations[subject] = [];
    }
    conversations[subject].push(email);
  }

  // Sort each conversation by date
  for (const subject in conversations) {
    conversations[subject].sort((a, b) => extractDate(a) - extractDate(b));
  }

  return conversations;
}

/**
 * Creates a graph for a conversation
 * @param {Array} emails - List of emails in a conversation
 * @param {string} subject - Conversation subject
 * @returns {Object} - Graph with nodes and links
 */
function createConversationGraph(emails, subject) {
  const nodes = [];
  const links = [];

  // Create the nodes
  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    const node = {
      id: email.id,
      index: i,
      from: extractFrom(email),
      subject: extractSubject(email),
      date: extractDate(email).toISOString().slice(0, 16).replace('T', ' '),
      bodyPreview: extractBodyContent(email).substring(0, 200),
      snippet: email.snippet || '',
    };
    nodes.push(node);
  }

  // Create the chronological links (email i -> email i+1)
  for (let i = 0; i < emails.length - 1; i++) {
    const link = {
      source: i,
      target: i + 1,
      type: 'chronological',
    };
    links.push(link);
  }

  return {
    subject: subject,
    nodes: nodes,
    links: links,
    emailCount: emails.length,
  };
}

// === CLEAN-UP FUNCTIONS ===

/**
 * Cleans up and normalises an email
 * @param {Object} email - Raw email
 * @returns {Object} - Cleaned email
 */
function cleanEmail(email) {
  return {
    id: email.id,
    threadId: email.threadId,
    subject: extractSubject(email),
    subjectRaw: email.subject || '',
    from: extractFrom(email),
    to: email.to || '',
    cc: email.cc || '',
    bcc: email.bcc || '',
    date: extractDate(email),
    messageId: email.messageId || '',
    inReplyTo: email.inReplyTo || '',
    references: email.references || '',
    bodyText: extractBodyContent(email),
    snippet: email.snippet || '',
    hasAttachments: email.hasAttachments === true,
    _chunkIndex: email._chunkIndex, // Keep the chunk index
  };
}

// === FUNCTIONS FOR SUBJECTS WITH A MINIMUM NUMBER OF EMAILS ===

/**
 * Returns subjects with at least X emails, with chunk indices
 * @param {Array} emailsClean - List of cleaned emails
 * @param {number} minCount - Minimum number of emails (default: 3)
 * @returns {Array} - List of valid subjects with chunk indices
 */
function getSubjectsWithMinEmails(emailsClean, minCount = 3, userEmail = null) {
  // Group by subject
  const conversations = groupBySubject(emailsClean);

  // Filter subjects with at least X emails
  const validSubjects = [];

  for (const [subject, emailList] of Object.entries(conversations)) {
    if (emailList.length >= minCount) {
      const participants = [...new Set(emailList.map((email) => extractFrom(email)))];

      // Collect all recipients (to/cc) for search
      const recipientSet = new Set();
      const allParticipantSet = new Set(participants.map((p) => p.toLowerCase()));
      let snippetBuf = '';

      const chunkIndex = new Set();
      for (const email of emailList) {
        if (email._chunkIndex !== undefined) {
          chunkIndex.add(email._chunkIndex);
        }
        // Collect to/cc for search
        if (email.to) {
          email.to.split(/[,;]/).forEach((addr) => {
            const trimmed = addr.trim().toLowerCase();
            if (trimmed) {
              recipientSet.add(trimmed);
              allParticipantSet.add(trimmed);
            }
          });
        }
        if (email.cc) {
          email.cc.split(/[,;]/).forEach((addr) => {
            const trimmed = addr.trim().toLowerCase();
            if (trimmed) {
              recipientSet.add(trimmed);
              allParticipantSet.add(trimmed);
            }
          });
        }
        // Collect snippets (capped)
        if (email.snippet && snippetBuf.length < 500) {
          snippetBuf += ' ' + email.snippet;
        }
      }

      // ── Interaction detection ──
      let userReplied = false;
      let userInTo = false;
      let userInCcOnly = false;
      const userLower = userEmail ? userEmail.toLowerCase() : '';

      if (userLower) {
        for (const email of emailList) {
          const fromLower = (extractFrom(email) || '').toLowerCase();
          const toLower = (email.to || '').toLowerCase();
          const ccLower = (email.cc || '').toLowerCase();

          if (fromLower.includes(userLower)) {
            userReplied = true;
          }
          if (toLower.includes(userLower)) {
            userInTo = true;
          }
          if (ccLower.includes(userLower) && !toLower.includes(userLower)) {
            userInCcOnly = true;
          }
        }
        // CC-only is only meaningful if user was never in To
        if (userInTo) userInCcOnly = false;
      }

      // ── Newsletter detection ──
      const NEWSLETTER_KEYWORDS_SUBJECT = [
        'newsletter',
        'digest',
        'weekly update',
        'monthly update',
        'bulletin',
      ];
      const NEWSLETTER_KEYWORDS_SNIPPET = [
        'unsubscribe',
        'se désabonner',
        'opt-out',
        'opt out',
        'manage your subscription',
        'email preferences',
        'view in browser',
        'voir dans le navigateur',
      ];
      const NEWSLETTER_KEYWORDS_FROM = [
        'newsletter@',
        'news@',
        'digest@',
        'updates@',
        'noreply@',
        'no-reply@',
        'mailer-daemon@',
        'bulk@',
      ];

      const subjectLower = subject.toLowerCase();
      const fromAll = participants.map((p) => p.toLowerCase());

      const hasNewsletterKeywordInSubject = NEWSLETTER_KEYWORDS_SUBJECT.some((kw) =>
        subjectLower.includes(kw)
      );
      const hasNewsletterKeywordInSnippet = NEWSLETTER_KEYWORDS_SNIPPET.some((kw) =>
        snippetBuf.toLowerCase().includes(kw)
      );
      const hasNewsletterFrom = fromAll.some((f) =>
        NEWSLETTER_KEYWORDS_FROM.some((kw) => f.includes(kw))
      );
      const isSingleSender = participants.length === 1;

      // Newsletter score: 2+ signals = newsletter
      let newsletterScore = 0;
      if (hasNewsletterKeywordInSubject) newsletterScore += 2;
      if (hasNewsletterKeywordInSnippet) newsletterScore++;
      if (hasNewsletterFrom) newsletterScore++;
      if (isSingleSender && !userReplied) newsletterScore++;

      const isNewsletter = newsletterScore >= 2;

      validSubjects.push({
        subject: subject,
        emailCount: emailList.length,
        chunks: Array.from(chunkIndex).sort((a, b) => a - b),
        participants: participants,
        recipients: [...recipientSet],
        allParticipants: [...allParticipantSet],
        snippets: snippetBuf.substring(0, 500).toLowerCase(),
        userReplied,
        userInTo,
        userInCcOnly,
        hasAttachments: emailList.some((e) => e.hasAttachments === true),
        isNewsletter,
        dateRange: {
          start: extractDate(emailList[0]).toISOString().slice(0, 16).replace('T', ' '),
          end: extractDate(emailList[emailList.length - 1])
            .toISOString()
            .slice(0, 16)
            .replace('T', ' '),
        },
      });
    }
  }

  // Sort by descending email count
  validSubjects.sort((a, b) => b.emailCount - a.emailCount);

  return validSubjects;
}

/**
 * Displays the valid subjects in a readable form
 * @param {Array} validSubjects - List of valid subjects
 */
function displayValidSubjects(validSubjects) {
  console.log(`📧 SUBJECTS WITH AT LEAST 3 EMAILS (${validSubjects.length} found)`);
  console.log('='.repeat(70));

  for (let i = 0; i < validSubjects.length; i++) {
    const subjectInfo = validSubjects[i];
    console.log(`\n${i + 1}. 📌 ${subjectInfo.subject}`);
    console.log(`   📊 ${subjectInfo.emailCount} emails`);
    console.log(`   👥 Participants: ${subjectInfo.participants.join(', ')}`);
    console.log(`   📅 From ${subjectInfo.dateRange.start} to ${subjectInfo.dateRange.end}`);
  }
}

// === MAIN FUNCTION TO BUILD THE CONVERSATION TREE ===

/**
 * Extracts the participant group of an email
 * @param {Object} email - Email to analyse
 * @returns {Set} - Set of participants
 */
function getParticipantsGroup(email) {
  const participants = new Set();

  // Add the sender
  if (email.from) {
    const fromEmail = email.from.split('<').pop().replace('>', '');
    participants.add(fromEmail.toLowerCase());
  }

  // Add the recipients
  if (email.to) {
    for (const to of email.to.split(',')) {
      const toEmail = to.split('<').pop().replace('>', '').trim();
      if (toEmail) {
        participants.add(toEmail.toLowerCase());
      }
    }
  }

  // Add the CC
  if (email.cc) {
    for (const cc of email.cc.split(',')) {
      const ccEmail = cc.split('<').pop().replace('>', '').trim();
      if (ccEmail) {
        participants.add(ccEmail.toLowerCase());
      }
    }
  }

  return participants;
}

/**
 * Builds a conversation tree using participant-group logic
 * @param {Array} emails - List of cleaned emails
 * @param {string} subject - Conversation subject
 * @returns {Object} - Tree with nodes and links
 */
function createTemporalGroupTree(emails, subject) {
  // Filter and sort by date
  const subjectEmails = emails.filter((e) => e.subject === subject);
  subjectEmails.sort((a, b) => a.date - b.date);

  if (subjectEmails.length === 0) {
    return { nodes: [], links: [], metadata: {} };
  }

  // Create the nodes
  const nodes = [];
  const emailToIndex = {};

  for (let i = 0; i < subjectEmails.length; i++) {
    const email = subjectEmails[i];
    const participantsGroup = getParticipantsGroup(email);

    const node = {
      id: email.id,
      index: i,
      messageId: email.messageId,
      from: email.from,
      to: email.to,
      cc: email.cc,
      date: email.date.toISOString().slice(0, 19).replace('T', ' '),
      timestamp: email.date.getTime() / 1000,
      subject: email.subject,
      bodyText: email.bodyText.substring(0, 200),
      inReplyTo: email.inReplyTo,
      participantsGroup: Array.from(participantsGroup),
      hasAttachments: email.hasAttachments === true,
      children: [],
      isRoot: i === 0,
    };
    nodes.push(node);
    emailToIndex[email.messageId] = i;
  }

  // WALK FROM MOST RECENT TO OLDEST
  for (let i = subjectEmails.length - 1; i > 0; i--) {
    const currentEmail = subjectEmails[i];
    const currentGroup = new Set(nodes[i].participantsGroup);

    let parentIndex = null;

    // 1. Look for the mail just before with the same group
    for (let j = i - 1; j >= 0; j--) {
      const previousGroup = new Set(nodes[j].participantsGroup);
      if (setsAreEqual(currentGroup, previousGroup)) {
        parentIndex = j;
        break;
      }
    }

    // 2. Otherwise use inReplyTo
    if (parentIndex === null) {
      const parentId = currentEmail.inReplyTo;
      if (parentId && Object.prototype.hasOwnProperty.call(emailToIndex, parentId)) {
        parentIndex = emailToIndex[parentId];
      }
    }

    // 3. Otherwise link to the root
    if (parentIndex === null) {
      parentIndex = 0;
    }

    // Add to the parent's children
    nodes[parentIndex].children.push(currentEmail.messageId);
  }

  // Create the links from the children
  const links = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    for (const childId of node.children) {
      const childIndex = emailToIndex[childId];
      links.push({
        source: i,
        target: childIndex,
        type: 'temporal_group',
        sourceId: node.messageId,
        targetId: childId,
      });
    }
  }

  return {
    subject: subject,
    nodes: nodes,
    links: links,
    metadata: {
      totalEmails: subjectEmails.length,
      rootId: subjectEmails[0].id,
    },
  };
}

/**
 * Compares two sets for equality
 * @param {Set} set1 - First set
 * @param {Set} set2 - Second set
 * @returns {boolean} - True if equal
 */
function setsAreEqual(set1, set2) {
  if (set1.size !== set2.size) return false;
  for (const item of set1) {
    if (!set2.has(item)) return false;
  }
  return true;
}

// === USAGE FUNCTIONS ===

/**
 * Retrieves the emails for a subject (simplified version)
 * @param {FileSystemFileHandle} fileHandle - File handle
 * @param {Object} subjectInfo - Subject information
 * @returns {Array} - List of emails for the subject
 */
async function getEmailsForSubjectOptimized(fileHandle, subjectInfo) {
  try {
    console.log(`🔍 DEBUG: Looking up emails for subject "${subjectInfo.subject}"`);

    // Load all emails and filter by subject
    const allEmails = await loadEmailsFromHandle(fileHandle, 500);
    console.log(`🔍 DEBUG: ${allEmails.length} emails loaded in total`);

    // Filter by subject
    const subjectEmails = allEmails.filter((email) => {
      const emailSubject = extractSubject(email);
      return emailSubject === subjectInfo.subject;
    });

    console.log(`✅ ${subjectEmails.length} emails found for "${subjectInfo.subject}"`);
    return subjectEmails;
  } catch (error) {
    console.error('Error retrieving optimised emails:', error);
    return [];
  }
}

// === EXPORTS ===

// ✅ ADD at the end of the file:
export default {
  createTemporalGroupTree,
  getSubjectsWithMinEmails,
  decodeBase64Data,
  loadEmailsFromHandle,
  getEmailsForSubjectOptimized,
  extractSubject,
  extractFrom,
  extractDate,
  extractBodyContent,
  groupBySubject,
  createConversationGraph,
  cleanEmail,
  displayValidSubjects,
  getParticipantsGroup,
  setsAreEqual,
};
