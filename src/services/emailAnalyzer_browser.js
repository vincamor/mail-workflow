// === FONCTIONS DE BASE ===

/**
 * Décode les données base64 des emails Gmail
 * @param {string} data - Données base64 à décoder
 * @returns {string} - Données décodées
 */
function decodeBase64Data(data) {
  if (!data) return '';
  try {
    // Gestion des caractères spéciaux dans base64
    // `let`, pas `const` : le padding est ajouté juste en dessous. Avec `const`,
    // l'affectation levait une TypeError avalée par le catch, et la fonction
    // retournait le base64 brut au lieu du texte décodé — silencieusement.
    let cleanData = data.replace(/-/g, '+').replace(/_/g, '/');
    const missingPadding = cleanData.length % 4;
    if (missingPadding) {
      cleanData += '='.repeat(4 - missingPadding);
    }
    
    const decodedString = atob(cleanData);
    return decodeURIComponent(escape(decodedString));
  } catch (error) {
    console.warn(`⚠️  Erreur décodage: ${error}`);
    return data;
  }
}

/**
 * Charge les emails depuis un FileSystemHandle par chunks
 * @param {FileSystemFileHandle} fileHandle - Handle du fichier
 * @param {number} chunkSize - Taille des chunks (défaut: 500)
 * @returns {Array} - Liste des emails avec index des chunks
 */
async function loadEmailsFromHandle(fileHandle, _chunkSize = 500) {
  const emails = [];

  try {
    const file = await fileHandle.getFile();

    let chunkCount = 0;
    const stream = file.stream();
    const textDecoder = new TextDecoder();
    
    // Buffer pour les lignes incomplètes
    let buffer = '';
    
    for await (const chunk of stream) {
      chunkCount++;
      const chunkText = textDecoder.decode(chunk, { stream: true });
      buffer += chunkText;
      
      // Traiter les lignes complètes
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Garder la dernière ligne incomplète
      
      // Traiter les lignes complètes
      for (const line of lines) {
        if (line.trim()) {
          try {
            const full = JSON.parse(line);
            // Construire immédiatement un objet allégé avec uniquement les champs utilisés.
            // L'objet complet (full) — qui contient bodyHtml et originalPayload — sort
            // de portée à la fin de ce bloc et devient éligible au GC sans délai,
            // évitant l'accumulation de 80+ Ko par email dans le heap.
            emails.push({
              id:           full.id,
              threadId:     full.threadId,
              subject:      full.subject,
              from:         full.from,
              to:           full.to,
              cc:           full.cc,
              date:         full.date,
              messageId:    full.messageId,
              inReplyTo:    full.inReplyTo,
              references:   full.references,
              internalDate: full.internalDate,
              bodyText:     full.bodyText,
              snippet:      full.snippet,
              labelIds:     full.labelIds,
              hasAttachments: full.hasAttachments,
              _chunkIndex:  chunkCount,
            });
          } catch (e) {
            console.warn("Ligne malformée ignorée:", line.substring(0, 50));
          }
        }
      }
    }
    
    // Traiter la dernière ligne si elle existe
    if (buffer.trim()) {
      try {
        const full = JSON.parse(buffer);
        emails.push({
          id:           full.id,
          threadId:     full.threadId,
          subject:      full.subject,
          from:         full.from,
          to:           full.to,
          cc:           full.cc,
          date:         full.date,
          messageId:    full.messageId,
          inReplyTo:    full.inReplyTo,
          references:   full.references,
          internalDate: full.internalDate,
          bodyText:     full.bodyText,
          snippet:      full.snippet,
          labelIds:     full.labelIds,
          hasAttachments: full.hasAttachments,
          _chunkIndex:  chunkCount,
        });
      } catch (e) {
        console.warn("Dernière ligne malformée ignorée");
      }
    }
    
    console.log(`✅ ${emails.length} emails chargés en ${chunkCount} chunks`);
    return emails;
  } catch (error) {
    console.error('Erreur chargement emails par chunks:', error);
    return [];
  }
}

/**
 * Extrait et nettoie le sujet
 * @param {Object} email - Email à traiter
 * @returns {string} - Sujet nettoyé
 */
function extractSubject(email) {
  let subject = '';
  
  // D'abord chercher directement dans email.subject
  if (email.subject) {
    subject = email.subject;
  }
  // Sinon chercher dans les headers (fallback)
  else if (email.payload && email.payload.headers) {
    subject = 'Sans sujet';
    for (const header of email.payload.headers) {
      if (header.name.toLowerCase() === 'subject') {
        subject = header.value;
        break;
      }
    }
  } else {
    return 'Sans sujet';
  }
  
  // Nettoyage (supprime Re:, Fwd:, etc.)
  subject = subject.replace(/^(Re:|Fwd:|FW:|RE:|FWD:)\s*/i, '');
  return subject.trim();
}

/**
 * Extrait l'expéditeur
 * @param {Object} email - Email à traiter
 * @returns {string} - Expéditeur
 */
function extractFrom(email) {
  // D'abord chercher directement dans email.from
  if (email.from) {
    return email.from;
  }
  // Sinon chercher dans les headers (fallback)
  else if (email.payload && email.payload.headers) {
    for (const header of email.payload.headers) {
      if (header.name.toLowerCase() === 'from') {
        return header.value;
      }
    }
  }
  return 'Inconnu';
}

/**
 * Extrait la date
 * @param {Object} email - Email à traiter
 * @returns {Date} - Date de l'email
 */
function extractDate(email) {
  if (email.internalDate) {
    const timestamp = parseInt(email.internalDate) / 1000;
    return new Date(timestamp * 1000);
  }
  return new Date();
}

/**
 * Extrait le contenu du corps
 * @param {Object} email - Email à traiter
 * @returns {string} - Contenu du corps
 */
function extractBodyContent(email) {
  // Si le serveur a déjà décodé le contenu (format gmailService), l'utiliser directement
  if (email.bodyText) {
    return email.bodyText;
  }
  
  // Fallback sur le snippet (bodyText est toujours présent car décodé côté serveur)
  return email.snippet || '';
}

// === FONCTIONS D'ANALYSE ===

/**
 * Groupe les emails par sujet
 * @param {Array} emails - Liste des emails
 * @returns {Object} - Emails groupés par sujet
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
  
  // Trie chaque conversation par date
  for (const subject in conversations) {
    conversations[subject].sort((a, b) => extractDate(a) - extractDate(b));
  }
  
  return conversations;
}

/**
 * Crée un graphique pour une conversation
 * @param {Array} emails - Liste des emails d'une conversation
 * @param {string} subject - Sujet de la conversation
 * @returns {Object} - Graphique avec nodes et links
 */
function createConversationGraph(emails, subject) {
  const nodes = [];
  const links = [];
  
  // Crée les nodes
  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    const node = {
      id: email.id,
      index: i,
      from: extractFrom(email),
      subject: extractSubject(email),
      date: extractDate(email).toISOString().slice(0, 16).replace('T', ' '),
      bodyPreview: extractBodyContent(email).substring(0, 200),
      snippet: email.snippet || ''
    };
    nodes.push(node);
  }
  
  // Crée les liens chronologiques (email i -> email i+1)
  for (let i = 0; i < emails.length - 1; i++) {
    const link = {
      source: i,
      target: i + 1,
      type: 'chronological'
    };
    links.push(link);
  }
  
  return {
    subject: subject,
    nodes: nodes,
    links: links,
    emailCount: emails.length
  };
}

// === FONCTIONS DE NETTOYAGE ===

/**
 * Nettoie et normalise un email
 * @param {Object} email - Email brut
 * @returns {Object} - Email nettoyé
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
    _chunkIndex: email._chunkIndex // Conserver l'index du chunk
  };
}

// === FONCTIONS POUR LES SUJETS AVEC MINIMUM D'EMAILS ===

/**
 * Retourne les sujets ayant au minimum X emails avec index des chunks
 * @param {Array} emailsClean - Liste des emails nettoyés
 * @param {number} minCount - Nombre minimum d'emails (défaut: 3)
 * @returns {Array} - Liste des sujets valides avec index des chunks
 */
function getSubjectsWithMinEmails(emailsClean, minCount = 3, userEmail = null) {
  // Grouper par sujet
  const conversations = groupBySubject(emailsClean);
  
  // Filtrer les sujets avec minimum X emails
  const validSubjects = [];
  
  for (const [subject, emailList] of Object.entries(conversations)) {
    if (emailList.length >= minCount) {
      const participants = [...new Set(emailList.map(email => extractFrom(email)))];

      // Collect all recipients (to/cc) for search
      const recipientSet = new Set();
      const allParticipantSet = new Set(participants.map(p => p.toLowerCase()));
      let snippetBuf = '';

      const chunkIndex = new Set();
      for (const email of emailList) {
        if (email._chunkIndex !== undefined) {
          chunkIndex.add(email._chunkIndex);
        }
        // Collect to/cc for search
        if (email.to) {
          email.to.split(/[,;]/).forEach(addr => {
            const trimmed = addr.trim().toLowerCase();
            if (trimmed) {
              recipientSet.add(trimmed);
              allParticipantSet.add(trimmed);
            }
          });
        }
        if (email.cc) {
          email.cc.split(/[,;]/).forEach(addr => {
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
      const NEWSLETTER_KEYWORDS_SUBJECT = ['newsletter', 'digest', 'weekly update', 'monthly update', 'bulletin'];
      const NEWSLETTER_KEYWORDS_SNIPPET = ['unsubscribe', 'se désabonner', 'opt-out', 'opt out', 'manage your subscription', 'email preferences', 'view in browser', 'voir dans le navigateur'];
      const NEWSLETTER_KEYWORDS_FROM = ['newsletter@', 'news@', 'digest@', 'updates@', 'noreply@', 'no-reply@', 'mailer-daemon@', 'bulk@'];

      const subjectLower = subject.toLowerCase();
      const fromAll = participants.map(p => p.toLowerCase());

      const hasNewsletterKeywordInSubject = NEWSLETTER_KEYWORDS_SUBJECT.some(kw => subjectLower.includes(kw));
      const hasNewsletterKeywordInSnippet = NEWSLETTER_KEYWORDS_SNIPPET.some(kw => snippetBuf.toLowerCase().includes(kw));
      const hasNewsletterFrom = fromAll.some(f => NEWSLETTER_KEYWORDS_FROM.some(kw => f.includes(kw)));
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
        hasAttachments: emailList.some(e => e.hasAttachments === true),
        isNewsletter,
        dateRange: {
          start: extractDate(emailList[0]).toISOString().slice(0, 16).replace('T', ' '),
          end: extractDate(emailList[emailList.length - 1]).toISOString().slice(0, 16).replace('T', ' ')
        }
      });
    }
  }
  
  // Trier par nombre d'emails décroissant
  validSubjects.sort((a, b) => b.emailCount - a.emailCount);
  
  return validSubjects;
}

/**
 * Affiche les sujets valides de manière lisible
 * @param {Array} validSubjects - Liste des sujets valides
 */
function displayValidSubjects(validSubjects) {
  console.log(`📧 SUJETS AVEC MINIMUM 3 EMAILS (${validSubjects.length} trouvés)`);
  console.log('='.repeat(70));
  
  for (let i = 0; i < validSubjects.length; i++) {
    const subjectInfo = validSubjects[i];
    console.log(`\n${i + 1}. 📌 ${subjectInfo.subject}`);
    console.log(`   📊 ${subjectInfo.emailCount} emails`);
    console.log(`   👥 Participants: ${subjectInfo.participants.join(', ')}`);
    console.log(`   📅 Du ${subjectInfo.dateRange.start} au ${subjectInfo.dateRange.end}`);
  }
}

// === FONCTION PRINCIPALE POUR CRÉER L'ARBRE TEMPOREL ===

/**
 * Extrait le groupe de participants d'un email
 * @param {Object} email - Email à analyser
 * @returns {Set} - Ensemble des participants
 */
function getParticipantsGroup(email) {
  const participants = new Set();
  
  // Ajouter l'expéditeur
  if (email.from) {
    const fromEmail = email.from.split('<').pop().replace('>', '');
    participants.add(fromEmail.toLowerCase());
  }
  
  // Ajouter les destinataires
  if (email.to) {
    for (const to of email.to.split(',')) {
      const toEmail = to.split('<').pop().replace('>', '').trim();
      if (toEmail) {
        participants.add(toEmail.toLowerCase());
      }
    }
  }
  
  // Ajouter les CC
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
 * Crée un arbre temporel avec logique de groupes de participants
 * @param {Array} emails - Liste des emails nettoyés
 * @param {string} subject - Sujet de la conversation
 * @returns {Object} - Arbre avec nodes et links
 */
function createTemporalGroupTree(emails, subject) {
  // Filtrer et trier par date
  const subjectEmails = emails.filter(e => e.subject === subject);
  subjectEmails.sort((a, b) => a.date - b.date);
  
  if (subjectEmails.length === 0) {
    return { nodes: [], links: [], metadata: {} };
  }
  
  // Créer les nodes
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
      isRoot: (i === 0)
    };
    nodes.push(node);
    emailToIndex[email.messageId] = i;
  }
  
  // PARCOURIR DU PLUS RÉCENT AU PLUS ANCIEN
  for (let i = subjectEmails.length - 1; i > 0; i--) {
    const currentEmail = subjectEmails[i];
    const currentGroup = new Set(nodes[i].participantsGroup);
    
    let parentIndex = null;
    
    // 1. Chercher le mail juste avant avec le même groupe
    for (let j = i - 1; j >= 0; j--) {
      const previousGroup = new Set(nodes[j].participantsGroup);
      if (setsAreEqual(currentGroup, previousGroup)) {
        parentIndex = j;
        break;
      }
    }
    
    // 2. Sinon utiliser inReplyTo
    if (parentIndex === null) {
      const parentId = currentEmail.inReplyTo;
      if (parentId && Object.prototype.hasOwnProperty.call(emailToIndex, parentId)) {
        parentIndex = emailToIndex[parentId];
      }
    }
    
    // 3. Sinon lier au root
    if (parentIndex === null) {
      parentIndex = 0;
    }
    
    // Ajouter aux children du parent
    nodes[parentIndex].children.push(currentEmail.messageId);
  }
  
  // Créer les links à partir des children
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
        targetId: childId
      });
    }
  }
  
  return {
    subject: subject,
    nodes: nodes,
    links: links,
    metadata: {
      totalEmails: subjectEmails.length,
      rootId: subjectEmails[0].id
    }
  };
}

/**
 * Compare deux ensembles pour vérifier l'égalité
 * @param {Set} set1 - Premier ensemble
 * @param {Set} set2 - Deuxième ensemble
 * @returns {boolean} - True si égaux
 */
function setsAreEqual(set1, set2) {
  if (set1.size !== set2.size) return false;
  for (const item of set1) {
    if (!set2.has(item)) return false;
  }
  return true;
}

// === FONCTIONS D'UTILISATION ===

/**
 * Récupère les emails d'un sujet (version simplifiée)
 * @param {FileSystemFileHandle} fileHandle - Handle du fichier
 * @param {Object} subjectInfo - Informations du sujet
 * @returns {Array} - Liste des emails du sujet
 */
async function getEmailsForSubjectOptimized(fileHandle, subjectInfo) {
  try {
    console.log(`🔍 DEBUG: Recherche des emails pour le sujet "${subjectInfo.subject}"`);
    
    // Charger tous les emails et filtrer par sujet
    const allEmails = await loadEmailsFromHandle(fileHandle, 500);
    console.log(`🔍 DEBUG: ${allEmails.length} emails chargés au total`);
    
    // Filtrer par sujet
    const subjectEmails = allEmails.filter(email => {
      const emailSubject = extractSubject(email);
      return emailSubject === subjectInfo.subject;
    });
    
    console.log(`✅ ${subjectEmails.length} emails trouvés pour "${subjectInfo.subject}"`);
    return subjectEmails;
  } catch (error) {
    console.error("Erreur récupération emails optimisée:", error);
    return [];
  }
}

// === EXPORTS ===

// ✅ AJOUTER à la fin du fichier :
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
  setsAreEqual
};
 