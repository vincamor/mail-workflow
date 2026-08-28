/**
 * Utilities shared between gmailService and outlookService.
 * Avoids duplication of filtering, SSE streaming and error handling.
 */

// ─────────────────────────────────────────────
//  Email filtering (identical Gmail / Outlook)
// ─────────────────────────────────────────────

/**
 * Determines if a formatted email should be excluded based on user filters.
 * Used as a safety net after API-side filtering (Gmail query / Outlook OData).
 * @param {Object} email - Formatted email ({ subject, from, ... })
 * @param {Object} filters - Filter configuration
 * @returns {boolean} true if the email should be excluded
 */
function shouldExcludeEmail(email, filters) {
  if (!filters) return false;

  const subject = (email.subject || '').toLowerCase();
  const from = (email.from || '').toLowerCase();

  if (filters.excludeNoSubject && (!email.subject || email.subject.trim() === '')) {
    return true;
  }

  if (filters.excludeNotifications && filters.notificationKeywords) {
    if (
      filters.notificationKeywords.some(
        (kw) => from.includes(kw.toLowerCase()) || subject.includes(kw.toLowerCase())
      )
    )
      return true;
  }

  if (filters.excludePromotional && filters.promotionalKeywords) {
    if (filters.promotionalKeywords.some((kw) => subject.includes(kw.toLowerCase()))) return true;
  }

  if (filters.blacklistedSenders && filters.blacklistedSenders.length > 0) {
    if (filters.blacklistedSenders.some((sender) => from.includes(sender.toLowerCase())))
      return true;
  }

  if (filters.blacklistedKeywords && filters.blacklistedKeywords.length > 0) {
    if (filters.blacklistedKeywords.some((kw) => subject.includes(kw.toLowerCase()))) return true;
  }

  // 6. Check excluded subjects
  if (filters.blacklistedSubjects && filters.blacklistedSubjects.length > 0) {
    // Normalize like frontend: remove Re:/Fwd: and trim
    const cleanSubject = (email.subject || '').replace(/^(Re:|Fwd:|FW:|RE:|FWD:)\s*/i, '').trim();
    if (filters.blacklistedSubjects.some((excluded) => excluded === cleanSubject)) {
      return true;
    }
  }

  return false;
}

// ─────────────────────────────────────────────
//  Auto-detection of repetitive senders
// ─────────────────────────────────────────────

const AUTO_EXCLUDE_THRESHOLD_1 = 5; // first evaluation
const AUTO_EXCLUDE_THRESHOLD_2 = 10; // re-evaluation if inconclusive at 5
const AUTO_EXCLUDE_SIMILARITY_RATIO = 0.6; // 60% identical subjects = spam
const AUTO_EXCLUDE_BODY_MIN_LENGTH = 1000; // body check only for large emails
const AUTO_EXCLUDE_BODY_DEVIATION = 0.1; // standard deviation < 10% of mean

/**
 * Normalizes a subject for comparison: removes Re:/Fwd:, digits, dates, punctuation.
 * "Your digest from 01/03/2026" → "your digest from"
 * "Re: Fwd: Connection alert #42" → "connection alert"
 */
function normalizeSubject(subject) {
  return (subject || '')
    .toLowerCase()
    .replace(/^(re|fwd|fw|tr)\s*:\s*/gi, '') // email prefixes
    .replace(/\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}/g, '') // dates
    .replace(/\d+/g, '') // all digits
    .replace(/#/g, '') // hash
    .replace(/[^\p{L}\s]/gu, '') // punctuation (keep unicode letters)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Analyzes subjects and bodies stored for a sender that has reached the threshold.
 * @param {string[]} subjects - Original subjects
 * @param {number[]} bodyLengths - Body lengths
 * @param {number} [similarityRatio] - Minimum ratio of identical subjects (default: AUTO_EXCLUDE_SIMILARITY_RATIO)
 * @returns {boolean} true if the sender is detected as repetitive
 */
function isSenderRepetitive(
  subjects,
  bodyLengths,
  similarityRatio = AUTO_EXCLUDE_SIMILARITY_RATIO
) {
  const total = subjects.length;
  const minMatch = Math.ceil(total * similarityRatio);

  // Check 1: normalized subjects
  const normalized = subjects.map(normalizeSubject);
  const counts = {};
  for (const s of normalized) {
    counts[s] = (counts[s] || 0) + 1;
  }
  const maxCount = Math.max(...Object.values(counts));
  if (maxCount >= minMatch) {
    return true;
  }

  // Check 2: body length (only for large emails with non-empty body)
  const nonZeroLengths = bodyLengths.filter((l) => l > 0);
  if (nonZeroLengths.length >= 3) {
    const avgLength = nonZeroLengths.reduce((a, b) => a + b, 0) / nonZeroLengths.length;
    if (avgLength >= AUTO_EXCLUDE_BODY_MIN_LENGTH) {
      const variance =
        nonZeroLengths.reduce((sum, l) => sum + (l - avgLength) ** 2, 0) / nonZeroLengths.length;
      const stdDev = Math.sqrt(variance);
      if (stdDev / avgLength < AUTO_EXCLUDE_BODY_DEVIATION) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Extracts the email address from a From field (ignores display name).
 * "Railway <hello@notify.railway.app>" → "hello@notify.railway.app"
 * "hello@test.com" → "hello@test.com"
 */
function extractEmailAddress(from) {
  if (!from) return '';
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).toLowerCase().trim();
}

// ─────────────────────────────────────────────
//  SSE Streaming (identical Gmail / Outlook)
// ─────────────────────────────────────────────

/**
 * Downloads emails in chunks via SSE.
 * Logic is 100% identical between Gmail and Outlook — only fetchMessage differs.
 *
 * @param {Object} res - Express response
 * @param {Object} options
 * @param {Array} options.messageIds - List of IDs to download
 * @param {number} options.chunkSize - Chunk size (default 500)
 * @param {Object|null} options.filters - User filters
 * @param {Function} options.fetchMessage - async (msgId) => formattedEmail | null
 *   Provider-specific function that retrieves and formats an email by its ID.
 * @param {string} options.provider - Provider name (for logs)
 */
const RATE_LIMIT_BACKOFF_MS = 2000;

/**
 * Detects a rate-limit or provider unavailability error (429 / 503).
 */
function isRateLimitError(error) {
  const status = error?.code || error?.statusCode || error?.status || error?.response?.status;
  return status === 429 || status === 503;
}

async function streamEmailChunks(
  res,
  { messageIds, chunkSize = 500, filters = null, fetchMessage, provider = '' }
) {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendSSE = (data) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Stop loop if client disconnects (same pattern as routes/ai.js)
  let clientDisconnected = false;
  if (res.req && typeof res.req.on === 'function') {
    res.req.on('close', () => {
      clientDisconnected = true;
    });
  }

  const totalChunks = Math.ceil(messageIds.length / chunkSize);
  let totalRetrieved = 0;
  let totalRejected = 0;
  let totalFiltered = 0;
  let totalRateLimited = 0;

  // Auto-detection of repetitive senders
  const autoExcludeEnabled = filters && filters.autoExcludeRepetitive !== false;
  const senderCounts = new Map(); // sender → count
  const senderSamples = new Map(); // sender → { subjects: [], bodyLengths: [] }
  const senderExcluded = new Set(); // senders detected as repetitive
  const senderWhitelisted = new Set(); // senders analysed and legitimate
  const senderAnalysis = new Map(); // sender → { normalized, maxMatch, avgBody, decision }
  let totalAutoExcluded = 0;

  console.log(
    `📦 ${provider} downloadEmailsInChunks: ${messageIds.length} emails in ${totalChunks} chunk(s) of ${chunkSize}`
  );
  if (autoExcludeEnabled) {
    console.log(
      `🔍 Auto-exclusion enabled (threshold: ${AUTO_EXCLUDE_THRESHOLD_1}/${AUTO_EXCLUDE_THRESHOLD_2} emails, similarity: ${AUTO_EXCLUDE_SIMILARITY_RATIO * 100}%, body min: ${AUTO_EXCLUDE_BODY_MIN_LENGTH} chars)`
    );
  } else {
    console.log(`⏭️ Auto-exclusion disabled`);
  }

  sendSSE({
    type: 'start',
    totalEmails: messageIds.length,
    totalChunks,
    chunkSize,
  });

  try {
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const start = chunkIndex * chunkSize;
      const chunk = messageIds.slice(start, Math.min(start + chunkSize, messageIds.length));

      let chunkRetrieved = 0;
      let chunkRejected = 0;
      let chunkFiltered = 0;
      const chunkEmails = [];

      for (const msgRef of chunk) {
        if (clientDisconnected) break;
        const msgId = msgRef.id || msgRef;

        // Fetch with distinction between rate-limit (429/503) vs invalid email:
        // simple backoff + one unique retry, otherwise reject normally.
        let formatted = null;
        try {
          formatted = await fetchMessage(msgId);
        } catch (fetchErr) {
          if (isRateLimitError(fetchErr)) {
            totalRateLimited++;
            console.warn(
              `⏳ ${provider} provider rate-limit on ${msgId} — backoff ${RATE_LIMIT_BACKOFF_MS}ms then retry`
            );
            await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
            try {
              formatted = await fetchMessage(msgId);
            } catch (retryErr) {
              console.warn(
                `❌ ${provider} retry after rate-limit failed on ${msgId}: ${retryErr.message}`
              );
              chunkRejected++;
              continue;
            }
          } else {
            chunkRejected++;
            continue;
          }
        }

        try {
          if (!formatted) {
            chunkRejected++;
            continue;
          }
          if (filters && shouldExcludeEmail(formatted, filters)) {
            chunkFiltered++;
            totalFiltered++;
            continue;
          }

          // Auto-detection of repetitive senders
          if (autoExcludeEnabled) {
            const sender = extractEmailAddress(formatted.from);
            if (sender && senderExcluded.has(sender)) {
              // Already detected as repetitive → direct skip
              chunkFiltered++;
              totalFiltered++;
              totalAutoExcluded++;
              continue;
            }
            if (sender && !senderWhitelisted.has(sender)) {
              const count = (senderCounts.get(sender) || 0) + 1;
              senderCounts.set(sender, count);

              // Store samples while in evaluation phase
              if (count <= AUTO_EXCLUDE_THRESHOLD_2) {
                if (!senderSamples.has(sender)) {
                  senderSamples.set(sender, { subjects: [], bodyLengths: [] });
                }
                const samples = senderSamples.get(sender);
                samples.subjects.push(formatted.subject || '');
                samples.bodyLengths.push((formatted.bodyText || '').length);
              }

              // Evaluation at thresholds (5 and 10)
              if (count === AUTO_EXCLUDE_THRESHOLD_1 || count === AUTO_EXCLUDE_THRESHOLD_2) {
                const samples = senderSamples.get(sender);
                const normalized = samples.subjects.map(normalizeSubject);
                const subjectCounts = {};
                for (const s of normalized) subjectCounts[s] = (subjectCounts[s] || 0) + 1;
                const maxSubjectCount = Math.max(...Object.values(subjectCounts));
                const minRequired = Math.ceil(count * AUTO_EXCLUDE_SIMILARITY_RATIO);
                const avgBodyLen =
                  samples.bodyLengths.reduce((a, b) => a + b, 0) / samples.bodyLengths.length;

                const analysisDetail = {
                  normalized,
                  subjects: samples.subjects,
                  maxMatch: maxSubjectCount,
                  minRequired,
                  avgBody: Math.round(avgBodyLen),
                  bodyLengths: samples.bodyLengths,
                  evaluatedAt: count,
                };

                if (isSenderRepetitive(samples.subjects, samples.bodyLengths)) {
                  senderExcluded.add(sender);
                  senderWhitelisted.delete(sender); // in case whitelisted at 5, excluded at 10
                  analysisDetail.decision = 'EXCLUDED';
                  console.log(`🔄 AUTO-EXCLUDED: ${sender} (evaluation at ${count} emails)`);
                  console.log(`   ├─ Normalized subjects: ${JSON.stringify(normalized)}`);
                  console.log(
                    `   ├─ Similarity: ${maxSubjectCount}/${count} identical (threshold: ${minRequired})`
                  );
                  console.log(
                    `   ├─ Body lengths: [${samples.bodyLengths.join(', ')}] (avg: ${Math.round(avgBodyLen)})`
                  );
                  console.log(`   └─ Following emails from this sender will be filtered`);
                  senderSamples.delete(sender);
                } else if (count === AUTO_EXCLUDE_THRESHOLD_2) {
                  // Final whitelist only at 2nd threshold
                  senderWhitelisted.add(sender);
                  analysisDetail.decision = 'WHITELISTED';
                  console.log(`✅ WHITELISTED: ${sender} (final evaluation at ${count} emails)`);
                  console.log(`   ├─ Normalized subjects: ${JSON.stringify(normalized)}`);
                  console.log(
                    `   ├─ Similarity: ${maxSubjectCount}/${count} identical (threshold: ${minRequired} — not reached)`
                  );
                  console.log(
                    `   └─ Body avg: ${Math.round(avgBodyLen)} chars — legitimate sender`
                  );
                  senderSamples.delete(sender);
                } else {
                  // Threshold 1 inconclusive → continue sampling until threshold 2
                  analysisDetail.decision = 'PENDING';
                  console.log(
                    `⏳ PENDING: ${sender} (${maxSubjectCount}/${count} identical, threshold ${minRequired} — re-evaluation at ${AUTO_EXCLUDE_THRESHOLD_2} emails)`
                  );
                }
                senderAnalysis.set(sender, analysisDetail);
              }
            }
          }

          chunkEmails.push(formatted);
          chunkRetrieved++;
        } catch {
          chunkRejected++;
        }
      }

      totalRetrieved += chunkRetrieved;
      totalRejected += chunkRejected;

      if (clientDisconnected) {
        console.log(
          `🔌 ${provider} downloadEmailsInChunks: client disconnected — stopping streaming`
        );
        return;
      }

      if (chunkEmails.length > 0) {
        sendSSE({ type: 'emails', emails: chunkEmails });
      }

      sendSSE({
        type: 'progress',
        chunkIndex: chunkIndex + 1,
        totalChunks,
        chunkRetrieved,
        chunkFiltered,
        chunkRejected,
        totalRetrieved,
        totalFiltered,
        totalRejected,
        totalRequested: messageIds.length,
        percentage: Math.round(((chunkIndex + 1) / totalChunks) * 100),
      });
    }

    const autoExcludedSenders = Array.from(senderExcluded);

    // Diagnostic: top senders by email count (for debug)
    const topSenders = Array.from(senderCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([sender, count]) => {
        const analysis = senderAnalysis.get(sender);
        return {
          sender,
          count,
          status: senderExcluded.has(sender)
            ? 'EXCLUDED'
            : senderWhitelisted.has(sender)
              ? 'WHITELISTED'
              : 'NOT-ANALYSED',
          ...(analysis
            ? {
                normalized: analysis.normalized,
                subjects: analysis.subjects,
                maxMatch: analysis.maxMatch,
                avgBody: analysis.avgBody,
                bodyLengths: analysis.bodyLengths,
              }
            : {}),
        };
      });

    console.log(`\n📊 ═══ AUTO-EXCLUSION SUMMARY ═══`);
    console.log(`   Senders analysed: ${senderCounts.size}`);
    console.log(
      `   Excluded senders: ${senderExcluded.size} → ${autoExcludedSenders.join(', ') || '(none)'}`
    );
    console.log(`   Whitelisted senders: ${senderWhitelisted.size}`);
    console.log(`   Auto-excluded emails: ${totalAutoExcluded}`);
    console.log(`   Kept emails: ${totalRetrieved}`);
    console.log(`   Filtered emails (rules + auto): ${totalFiltered}`);
    console.log(`═══════════════════════════════\n`);

    sendSSE({
      type: 'complete',
      success: true,
      totalRequested: messageIds.length,
      totalRetrieved,
      totalRejected,
      totalFiltered,
      totalRateLimited,
      totalAutoExcluded,
      autoExcludedSenders,
      topSenders,
      chunksProcessed: totalChunks,
      message:
        `${totalRetrieved} emails downloaded` +
        (totalFiltered > 0 ? ` (${totalFiltered} filtered)` : '') +
        (totalAutoExcluded > 0
          ? ` (${totalAutoExcluded} auto-excluded from ${autoExcludedSenders.length} sender(s))`
          : ''),
    });

    res.end();
  } catch (error) {
    console.error(`❌ Error ${provider} downloadEmailsInChunks:`, error);
    sendSSE({
      type: 'error',
      error: error.message,
      requiresLogout:
        error.code === 401 ||
        error.statusCode === 401 ||
        error.message?.includes('invalid_grant') ||
        error.message?.includes('Token') ||
        error.message?.includes('token'),
    });
    res.end();
  }
}

// ─────────────────────────────────────────────
//  Error handling token (pattern repeated 10+ times)
// ─────────────────────────────────────────────

/**
 * Determines if an error is related to an expired/invalid token.
 */
function isTokenError(error) {
  return !!(
    error.code === 401 ||
    error.statusCode === 401 ||
    error.message?.includes('invalid_grant') ||
    error.message?.includes('Token') ||
    error.message?.includes('token')
  );
}

/**
 * Parses filters and afterDate from the query string or request body.
 */
function parseFiltersFromRequest(req) {
  const filters = req.query.filters ? JSON.parse(req.query.filters) : req.body?.filters || null;
  const afterDate = req.query.afterDate || null;
  return { filters, afterDate };
}

module.exports = {
  shouldExcludeEmail,
  streamEmailChunks,
  isTokenError,
  parseFiltersFromRequest,
  normalizeSubject,
  isSenderRepetitive,
  extractEmailAddress,
};
