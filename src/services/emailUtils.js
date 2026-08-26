/**
 * Utilitaires partages entre gmailService et outlookService.
 * Evite la duplication du filtrage, du streaming SSE et du error handling.
 */

// ─────────────────────────────────────────────
//  Filtrage email (identique Gmail / Outlook)
// ─────────────────────────────────────────────

/**
 * Determine si un email formate doit etre exclu selon les filtres utilisateur.
 * Utilise comme filet de securite apres le filtrage cote API (query Gmail / OData Outlook).
 * @param {Object} email - Email formate ({ subject, from, ... })
 * @param {Object} filters - Configuration des filtres
 * @returns {boolean} true si l'email doit etre exclu
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

  // 6. Vérifier les sujets exclus
  if (filters.blacklistedSubjects && filters.blacklistedSubjects.length > 0) {
    // Normaliser comme le frontend : retirer Re:/Fwd: et trim
    const cleanSubject = (email.subject || '').replace(/^(Re:|Fwd:|FW:|RE:|FWD:)\s*/i, '').trim();
    if (filters.blacklistedSubjects.some((excluded) => excluded === cleanSubject)) {
      return true;
    }
  }

  return false;
}

// ─────────────────────────────────────────────
//  Auto-detection des expéditeurs répétitifs
// ─────────────────────────────────────────────

const AUTO_EXCLUDE_THRESHOLD_1 = 5; // première évaluation
const AUTO_EXCLUDE_THRESHOLD_2 = 10; // réévaluation si non-concluant à 5
const AUTO_EXCLUDE_SIMILARITY_RATIO = 0.6; // 60% de sujets identiques = spam
const AUTO_EXCLUDE_BODY_MIN_LENGTH = 1000; // body check uniquement pour gros mails
const AUTO_EXCLUDE_BODY_DEVIATION = 0.1; // écart-type < 10% de la moyenne

/**
 * Normalise un sujet pour comparaison : retire Re:/Fwd:, chiffres, dates, ponctuation.
 * "Votre digest du 01/03/2026" → "votre digest du"
 * "Re: Fwd: Alert connexion #42" → "alert connexion"
 */
function normalizeSubject(subject) {
  return (subject || '')
    .toLowerCase()
    .replace(/^(re|fwd|fw|tr)\s*:\s*/gi, '') // prefixes email
    .replace(/\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}/g, '') // dates
    .replace(/\d+/g, '') // tous les chiffres
    .replace(/#/g, '') // hash
    .replace(/[^\p{L}\s]/gu, '') // ponctuation (garde lettres unicode)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Analyse les sujets et bodies stockés pour un sender ayant atteint le seuil.
 * @param {string[]} subjects - Sujets originaux
 * @param {number[]} bodyLengths - Longueurs des bodies
 * @param {number} [similarityRatio] - Ratio minimum de sujets identiques (defaut: AUTO_EXCLUDE_SIMILARITY_RATIO)
 * @returns {boolean} true si le sender est détecté comme répétitif
 */
function isSenderRepetitive(
  subjects,
  bodyLengths,
  similarityRatio = AUTO_EXCLUDE_SIMILARITY_RATIO
) {
  const total = subjects.length;
  const minMatch = Math.ceil(total * similarityRatio);

  // Check 1 : sujets normalisés
  const normalized = subjects.map(normalizeSubject);
  const counts = {};
  for (const s of normalized) {
    counts[s] = (counts[s] || 0) + 1;
  }
  const maxCount = Math.max(...Object.values(counts));
  if (maxCount >= minMatch) {
    return true;
  }

  // Check 2 : body length (uniquement pour gros mails avec body non-vide)
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
 * Extrait l'adresse email d'un champ From (ignore le display name).
 * "Railway <hello@notify.railway.app>" → "hello@notify.railway.app"
 * "hello@test.com" → "hello@test.com"
 */
function extractEmailAddress(from) {
  if (!from) return '';
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).toLowerCase().trim();
}

// ─────────────────────────────────────────────
//  SSE Streaming (identique Gmail / Outlook)
// ─────────────────────────────────────────────

/**
 * Telecharge des emails par tranches via SSE.
 * Logique 100% identique entre Gmail et Outlook — seul le fetchMessage differe.
 *
 * @param {Object} res - Express response
 * @param {Object} options
 * @param {Array} options.messageIds - Liste des IDs a telecharger
 * @param {number} options.chunkSize - Taille des tranches (default 500)
 * @param {Object|null} options.filters - Filtres utilisateur
 * @param {Function} options.fetchMessage - async (msgId) => formattedEmail | null
 *   Fonction provider-specific qui recupere et formate un email par son ID.
 * @param {string} options.provider - Nom du provider (pour les logs)
 */
const RATE_LIMIT_BACKOFF_MS = 2000;

/**
 * Detecte une erreur de rate-limit / indisponibilite provider (429 / 503).
 */
function isRateLimitError(error) {
  const status = error?.code || error?.statusCode || error?.status || error?.response?.status;
  return status === 429 || status === 503;
}

async function streamEmailChunks(
  res,
  { messageIds, chunkSize = 500, filters = null, fetchMessage, provider = '' }
) {
  // Headers SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendSSE = (data) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Arret de la boucle si le client se deconnecte (meme pattern que routes/ai.js)
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

  // Auto-detection des expéditeurs répétitifs
  const autoExcludeEnabled = filters && filters.autoExcludeRepetitive !== false;
  const senderCounts = new Map(); // sender → count
  const senderSamples = new Map(); // sender → { subjects: [], bodyLengths: [] }
  const senderExcluded = new Set(); // senders détectés comme répétitifs
  const senderWhitelisted = new Set(); // senders analysés et légitimes
  const senderAnalysis = new Map(); // sender → { normalized, maxMatch, avgBody, decision }
  let totalAutoExcluded = 0;

  console.log(
    `📦 ${provider} downloadEmailsInChunks: ${messageIds.length} emails en ${totalChunks} tranche(s) de ${chunkSize}`
  );
  if (autoExcludeEnabled) {
    console.log(
      `🔍 Auto-exclusion activée (seuil: ${AUTO_EXCLUDE_THRESHOLD_1}/${AUTO_EXCLUDE_THRESHOLD_2} mails, similarité: ${AUTO_EXCLUDE_SIMILARITY_RATIO * 100}%, body min: ${AUTO_EXCLUDE_BODY_MIN_LENGTH} chars)`
    );
  } else {
    console.log(`⏭️ Auto-exclusion désactivée`);
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

        // Fetch avec distinction rate-limit (429/503) vs email invalide :
        // backoff simple + un retry unique, sinon rejet classique.
        let formatted = null;
        try {
          formatted = await fetchMessage(msgId);
        } catch (fetchErr) {
          if (isRateLimitError(fetchErr)) {
            totalRateLimited++;
            console.warn(
              `⏳ ${provider} rate-limit provider sur ${msgId} — backoff ${RATE_LIMIT_BACKOFF_MS}ms puis retry`
            );
            await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
            try {
              formatted = await fetchMessage(msgId);
            } catch (retryErr) {
              console.warn(
                `❌ ${provider} retry apres rate-limit echoue sur ${msgId}: ${retryErr.message}`
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

          // Auto-detection des expéditeurs répétitifs
          if (autoExcludeEnabled) {
            const sender = extractEmailAddress(formatted.from);
            if (sender && senderExcluded.has(sender)) {
              // Déjà détecté comme répétitif → skip direct
              chunkFiltered++;
              totalFiltered++;
              totalAutoExcluded++;
              continue;
            }
            if (sender && !senderWhitelisted.has(sender)) {
              const count = (senderCounts.get(sender) || 0) + 1;
              senderCounts.set(sender, count);

              // Stocker les samples tant qu'on est en phase d'évaluation
              if (count <= AUTO_EXCLUDE_THRESHOLD_2) {
                if (!senderSamples.has(sender)) {
                  senderSamples.set(sender, { subjects: [], bodyLengths: [] });
                }
                const samples = senderSamples.get(sender);
                samples.subjects.push(formatted.subject || '');
                samples.bodyLengths.push((formatted.bodyText || '').length);
              }

              // Évaluation aux seuils (5 et 10)
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
                  senderWhitelisted.delete(sender); // au cas où whitelisté à 5, exclu à 10
                  analysisDetail.decision = 'EXCLU';
                  console.log(`🔄 AUTO-EXCLU: ${sender} (évaluation à ${count} mails)`);
                  console.log(`   ├─ Sujets normalisés: ${JSON.stringify(normalized)}`);
                  console.log(
                    `   ├─ Similarité: ${maxSubjectCount}/${count} identiques (seuil: ${minRequired})`
                  );
                  console.log(
                    `   ├─ Body lengths: [${samples.bodyLengths.join(', ')}] (moy: ${Math.round(avgBodyLen)})`
                  );
                  console.log(`   └─ Les emails suivants de ce sender seront filtrés`);
                  senderSamples.delete(sender);
                } else if (count === AUTO_EXCLUDE_THRESHOLD_2) {
                  // Whitelist définitive seulement au 2ème seuil
                  senderWhitelisted.add(sender);
                  analysisDetail.decision = 'WHITELIST';
                  console.log(`✅ WHITELISTE: ${sender} (évaluation finale à ${count} mails)`);
                  console.log(`   ├─ Sujets normalisés: ${JSON.stringify(normalized)}`);
                  console.log(
                    `   ├─ Similarité: ${maxSubjectCount}/${count} identiques (seuil: ${minRequired} — non atteint)`
                  );
                  console.log(`   └─ Body moy: ${Math.round(avgBodyLen)} chars — sender légitime`);
                  senderSamples.delete(sender);
                } else {
                  // Seuil 1 non-concluant → on continue à sampler jusqu'au seuil 2
                  analysisDetail.decision = 'EN-ATTENTE';
                  console.log(
                    `⏳ EN ATTENTE: ${sender} (${maxSubjectCount}/${count} identiques, seuil ${minRequired} — réévaluation à ${AUTO_EXCLUDE_THRESHOLD_2} mails)`
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
          `🔌 ${provider} downloadEmailsInChunks: client deconnecte — arret du streaming`
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

    // Diagnostic : top senders par nombre d'emails (pour debug)
    const topSenders = Array.from(senderCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([sender, count]) => {
        const analysis = senderAnalysis.get(sender);
        return {
          sender,
          count,
          status: senderExcluded.has(sender)
            ? 'EXCLU'
            : senderWhitelisted.has(sender)
              ? 'WHITELIST'
              : 'NON-ANALYSE',
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

    console.log(`\n📊 ═══ BILAN AUTO-EXCLUSION ═══`);
    console.log(`   Senders analysés: ${senderCounts.size}`);
    console.log(
      `   Senders exclus: ${senderExcluded.size} → ${autoExcludedSenders.join(', ') || '(aucun)'}`
    );
    console.log(`   Senders whitelistés: ${senderWhitelisted.size}`);
    console.log(`   Emails auto-exclus: ${totalAutoExcluded}`);
    console.log(`   Emails gardés: ${totalRetrieved}`);
    console.log(`   Emails filtrés (règles + auto): ${totalFiltered}`);
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
        `${totalRetrieved} emails téléchargés` +
        (totalFiltered > 0 ? ` (${totalFiltered} filtrés)` : '') +
        (totalAutoExcluded > 0
          ? ` (${totalAutoExcluded} auto-exclus de ${autoExcludedSenders.length} sender(s))`
          : ''),
    });

    res.end();
  } catch (error) {
    console.error(`❌ Erreur ${provider} downloadEmailsInChunks:`, error);
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
//  Error handling token (pattern repete 10+ fois)
// ─────────────────────────────────────────────

/**
 * Determine si une erreur est liee a un token expire/invalide.
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
 * Parse les filtres et afterDate depuis la query string ou le body de la requete.
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
