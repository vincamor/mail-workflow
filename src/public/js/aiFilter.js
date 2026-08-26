/**
 * Module de filtrage intelligent par IA
 * Pass 1 : tri rapide par nom de sujet uniquement
 * Pass 2 : analyse approfondie des sujets incertains avec contenu des emails
 */

import { getAIConfig } from './aiConfig.js';
import { stripQuotedText } from './aiChat.js';

// --- Pre-filter patterns (code-based, no AI needed) ---

const EXCLUDE_SUBJECT_PATTERNS = [
  /code\s*(de\s*)?(fidélité|promo|réduction|parrainage)/i,
  /offres?\s*(d['']emploi|exclusives?|spéciales?)/i,
  /\bpromo(tion)?\b/i,
  /\bnewsletter\b/i,
  /\bsoldes?\b/i,
  /\bunsubscribe\b/i,
  /\bse\s*désinscrire\b/i,
  /\bvos?\s*(droits?|données|compte)\b.*\b(expire|supprim|renouvell)/i,
  /\b(valable|expire)\s*(aujourd|demain|ce\s*soir|dans\s*\d)/i,
  /\bdernière\s*chance\b/i,
  /\b(nouveaux?|nouvelles?)\s*(postes?|offres?|opportunit)/i,
  /postulez/i,
  /votre\s*(commande|colis|livraison|facture)/i,
  /bienvenue\s*chez/i,
  /confirmation\s*(de\s*)?(commande|inscription|réservation)/i,
  /alerte\s*(sécurité|connexion|prix)/i,
  /\bdigest\b/i,
  /\bweekly\s*report\b/i,
  /^\(\d+\)\s/, // starts with (1), (2)... — notification count
];

const EXCLUDE_SENDER_PATTERNS = [
  /noreply|no-reply|ne-pas-repondre|ne_pas_repondre/i,
  /notification[s]?@/i,
  /newsletter@/i,
  /marketing@/i,
  /info@.*\.(com|fr|net|org)$/i, // generic info@ addresses
  /support@/i,
  /alert[es]?@/i,
];

const EXCLUDE_BODY_PATTERNS = [
  /se\s*désinscrire/i,
  /unsubscribe/i,
  /vous\s*recevez\s*ce\s*(mail|message|courriel)\s*(car|parce)/i,
  /cliquez\s*ici\s*pour\s*(ne\s*plus|vous\s*désabonner)/i,
  /manage\s*your\s*(preferences|subscription)/i,
];

/**
 * Pre-filtre les sujets par regles deterministes avant l'IA.
 * @param {Array<{subject: string, participants?: string[], userReplied?: boolean, userInTo?: boolean, isNewsletter?: boolean, snippets?: string, hasAttachments?: boolean}>} subjects
 * @param {string} userEmail - l'email de l'utilisateur connecte
 * @returns {{ autoExclude: string[], autoKeep: string[], needsAI: string[] }}
 */
export function preFilterSubjects(subjects, userEmail) {
  const autoExclude = [];
  const autoKeep = [];
  const needsAI = [];
  const normalizedUserEmail = (userEmail || '').toLowerCase().trim();

  for (const s of subjects) {
    const name = s.subject || '';
    const firstParticipant =
      s.participants && s.participants[0] ? s.participants[0].toLowerCase() : '';
    const snippets = s.snippets || '';

    // --- Auto-KEEP rules (checked first, takes priority) ---
    if (s.userReplied) {
      autoKeep.push(name);
      continue;
    }
    if (normalizedUserEmail && firstParticipant.includes(normalizedUserEmail)) {
      autoKeep.push(name);
      continue;
    }
    if (s.hasAttachments) {
      autoKeep.push(name);
      continue;
    }

    // --- Auto-EXCLUDE rules ---
    let excluded = false;

    // Newsletter already detected
    if (s.isNewsletter) {
      excluded = true;
    }

    // Subject patterns
    if (!excluded) {
      for (const pattern of EXCLUDE_SUBJECT_PATTERNS) {
        if (pattern.test(name)) {
          excluded = true;
          break;
        }
      }
    }

    // Sender patterns
    if (!excluded && firstParticipant) {
      for (const pattern of EXCLUDE_SENDER_PATTERNS) {
        if (pattern.test(firstParticipant)) {
          excluded = true;
          break;
        }
      }
    }

    // Body/snippet patterns
    if (!excluded && snippets) {
      for (const pattern of EXCLUDE_BODY_PATTERNS) {
        if (pattern.test(snippets)) {
          excluded = true;
          break;
        }
      }
    }

    if (excluded) {
      autoExclude.push(name);
    } else {
      needsAI.push(name);
    }
  }

  return { autoExclude, autoKeep, needsAI };
}

/**
 * Recupere la taille de contexte du modele configure
 * @returns {Promise<number>} taille du contexte en tokens
 */
// Pourcentage du contexte theorique reellement utilisable pour du suivi d'instructions
// Les petits modeles locaux perdent en qualite bien avant d'atteindre leur limite theorique
// Les gros modeles cloud maintiennent la qualite sur une plus grande partie de leur fenetre
const USABLE_CONTEXT_RATIO = {
  ollama: 0.03, // ~3% — modeles locaux legers, qualite se degrade vite
  openai: 0.25, // ~25% — gros modeles, bonne gestion du contexte long
  anthropic: 0.15, // ~15% — tres grand contexte (200k), 15% = ~30k utilisable
  custom: 0.05, // ~5% — conservatif, on ne connait pas le modele
};

// Compteur de stats pour le rapport
let filterStats = { totalRequests: 0, totalTokensEstimated: 0 };

export function getFilterStats() {
  return { ...filterStats };
}

async function getModelContextSize() {
  const config = getAIConfig();
  const ratio = USABLE_CONTEXT_RATIO[config.provider] || 0.05;

  try {
    const response = await fetch('/api/ai/model-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!response.ok) {
      const fallback = Math.floor(8192 * ratio);
      return Math.max(fallback, 1024); // minimum 1024 tokens
    }
    const data = await response.json();
    const theoreticalContext = data.contextLength || 8192;
    const effective = Math.max(Math.floor(theoreticalContext * ratio), 1024);
    console.log(
      `🧹 [AI Config] Modele: ${data.model}, contexte theorique: ${theoreticalContext}, ratio: ${(ratio * 100).toFixed(0)}%, effectif: ${effective} tokens`
    );
    return effective;
  } catch (e) {
    const fallback = Math.max(Math.floor(8192 * ratio), 1024);
    console.warn(
      `🧹 [AI Config] Impossible de recuperer la taille du contexte, defaut ${fallback} tokens (${(ratio * 100).toFixed(0)}% de 8192)`
    );
    return fallback;
  }
}

// --- System Prompts ---

const SYSTEM_PROMPT_PASS1 = `Tu tries des emails. Liste UNIQUEMENT les sujets a exclure.

exclure = newsletter, notification auto, spam, marketing, alerte systeme, facture auto, confirmation commande
NE PAS exclure si Participation=oui.

Reponds UNIQUEMENT en JSON, rien d'autre :
{"exclure":["sujet1","sujet2"]}`;

const SYSTEM_PROMPT_PASS2 = `Tu es un assistant specialise dans le tri d'emails professionnels.
On te donne des sujets d'emails avec un apercu de leur contenu (expediteurs et debut des messages).
Pour chaque sujet, classe-le dans une des 2 categories :
- "exclure" : notifications automatiques, newsletters, spam, alertes systeme, mails marketing, mails generes par des machines
- "garder" : conversations humaines, echanges professionnels, discussions de projet

Reponds UNIQUEMENT avec un JSON valide au format :
{"exclure": ["sujet1"], "garder": ["sujet2"], "incertain": []}

IMPORTANT : utilise les sujets EXACTEMENT comme fournis, sans les modifier.`;

// --- Pure functions (also duplicated in tests) ---

export function parseAIFilterResponse(text) {
  let jsonStr = text.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();
  const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!objectMatch) {
    // Tenter d'extraire des sujets entre guillemets meme sans JSON valide
    const quotedItems = [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (quotedItems.length > 0) {
      console.warn(
        '🧹 [Parse] JSON invalide, extraction par guillemets:',
        quotedItems.length,
        'items'
      );
      return { exclure: quotedItems, garder: [], incertain: [] };
    }
    throw new Error('Aucun JSON trouve dans la reponse IA');
  }
  // Nettoyer les caracteres de controle qui cassent JSON.parse
  // eslint-disable-next-line no-control-regex -- match intentionnel des caracteres de controle a nettoyer
  let cleanJson = objectMatch[0].replace(/[\x00-\x1F\x7F]/g, (c) =>
    c === '\n' || c === '\r' || c === '\t' ? c : ''
  );

  // Tenter de reparer un JSON tronque (array non ferme)
  try {
    const parsed = JSON.parse(cleanJson);
    return normalizeResult(parsed);
  } catch (e) {
    // Essayer de fermer les arrays/objets tronques
    console.warn('🧹 [Parse] JSON tronque, tentative de reparation...');
    // Retirer le dernier element incomplet (apres la derniere virgule)
    cleanJson = cleanJson.replace(/,\s*"[^"]*$/, '');
    // Fermer les crochets et accolades manquants
    const openBrackets = (cleanJson.match(/\[/g) || []).length;
    const closeBrackets = (cleanJson.match(/\]/g) || []).length;
    const openBraces = (cleanJson.match(/\{/g) || []).length;
    const closeBraces = (cleanJson.match(/\}/g) || []).length;
    cleanJson += ']'.repeat(Math.max(0, openBrackets - closeBrackets));
    cleanJson += '}'.repeat(Math.max(0, openBraces - closeBraces));

    try {
      const parsed = JSON.parse(cleanJson);
      console.log('🧹 [Parse] JSON repare avec succes');
      return normalizeResult(parsed);
    } catch (e2) {
      // Dernier recours: extraire les sujets entre guillemets
      const quotedItems = [...text.matchAll(/"([^"]{3,})"/g)].map((m) => m[1]);
      if (quotedItems.length > 0) {
        console.warn('🧹 [Parse] Extraction par guillemets:', quotedItems.length, 'items');
        return { exclure: quotedItems, garder: [], incertain: [] };
      }
      throw new Error('Aucun JSON trouve dans la reponse IA');
    }
  }
}

function normalizeResult(parsed) {
  return {
    exclure: Array.isArray(parsed.exclure) ? parsed.exclure : [],
    garder: Array.isArray(parsed.garder) ? parsed.garder : [],
    incertain: Array.isArray(parsed.incertain) ? parsed.incertain : [],
  };
}

export function validateFilterResults(aiResult, originalSubjects) {
  const originalSet = new Set(originalSubjects);
  return {
    exclure: aiResult.exclure.filter((s) => originalSet.has(s)),
    garder: aiResult.garder.filter((s) => originalSet.has(s)),
    incertain: aiResult.incertain.filter((s) => originalSet.has(s)),
  };
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// --- Prompt builders ---

export function buildPass1UserMessage(subjects) {
  return subjects
    .map((s, i) => {
      const name = typeof s === 'string' ? s : s.subject;
      const from =
        typeof s === 'object' && s.participants && s.participants[0] ? s.participants[0] : '';
      const participation = typeof s === 'object' && s.userReplied ? 'oui' : 'non';
      return `${i + 1}. "${name}" | De: ${from || '?'} | Participation: ${participation}`;
    })
    .join('\n');
}

/**
 * Decoupe les sujets en batches pour la passe 1 (max ~4000 tokens par batch)
 */
export function buildPass1Batches(subjects, maxCharsPerBatch = 5000) {
  const batches = [];
  let currentBatch = [];
  let currentChars = 0;

  for (const s of subjects) {
    const name = typeof s === 'string' ? s : s.subject;
    const lineChars = name.length + 80; // overhead per line
    if (currentBatch.length > 0 && currentChars + lineChars > maxCharsPerBatch) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
    currentBatch.push(s);
    currentChars += lineChars;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);
  return batches;
}

export function buildPass2PromptBlock(subject, emails) {
  const maxEmails = 5;
  const maxBodyChars = 200;
  const selected = emails.slice(0, maxEmails);
  let block = `## Sujet : ${subject}\n`;
  for (const email of selected) {
    // Retire le contenu cite pour ne comparer que le contenu neuf de chaque mail —
    // evite de fausser la detection de template (sinon 5 mails "memes" a cause des citations).
    const stripped = stripQuotedText(email.bodyText || '');
    const body = stripped.slice(0, maxBodyChars);
    block += `- De: ${email.from || 'inconnu'}\n  Debut: ${body}${body.length >= maxBodyChars ? '...' : ''}\n`;
  }
  return block;
}

export function buildPass2Batches(subjects, maxTokensPerBatch = 7000) {
  const systemPromptTokens = 400;
  const outputReserve = 300;
  const available = maxTokensPerBatch - systemPromptTokens - outputReserve;
  const batches = [];
  let currentBatch = [];
  let currentTokens = 0;
  for (const subject of subjects) {
    const subjectTokens = estimateTokens(subject.promptBlock);
    if (currentBatch.length > 0 && currentTokens + subjectTokens > available) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }
    currentBatch.push(subject);
    currentTokens += subjectTokens;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);
  return batches;
}

// --- AI call ---

async function callAI(systemPrompt, userMessage, retries = 2) {
  const config = getAIConfig();
  const body = {
    ...config,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    stream: false,
  };

  const inputTokens = estimateTokens(systemPrompt + userMessage);
  console.log(
    `🧹 [AI Call] Envoi requete (${userMessage.length} chars, ~${inputTokens} tokens, retries: ${retries})`
  );
  filterStats.totalRequests++;
  filterStats.totalTokensEstimated += inputTokens;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Erreur API IA (${response.status})`);
    }

    const data = await response.json();

    // Extract text from different provider response formats
    let text = '';
    if (data.choices && data.choices[0] && data.choices[0].message) {
      // OpenAI / Ollama format
      text = data.choices[0].message.content;
    } else if (data.content && data.content[0] && data.content[0].text) {
      // Anthropic format
      text = data.content[0].text;
    } else if (typeof data === 'string') {
      text = data;
    }

    if (!text) throw new Error('Reponse IA vide');

    console.log(
      `🧹 [AI Call] Reponse recue (${text.length} chars) — tentative ${attempt + 1}/${retries + 1}`
    );

    try {
      const parsed = parseAIFilterResponse(text);
      console.log(
        `🧹 [AI Call] Parse OK — exclure: ${parsed.exclure.length}, garder: ${parsed.garder.length}, incertain: ${parsed.incertain.length}`
      );
      return parsed;
    } catch (parseError) {
      if (attempt === retries) throw parseError;
      console.warn(
        `🧹 [AI Call] Tentative ${attempt + 1}/${retries + 1} echouee:`,
        parseError.message
      );
      console.warn(`🧹 [AI Call] Texte brut recu:`, text.substring(0, 500));
    }
  }
}

/**
 * Appelle l'IA avec retry et split automatique si JSON tronque
 * @param {string} systemPrompt
 * @param {Array} subjectBatch - array of subjects or {subject, promptBlock} objects
 * @param {Function} buildMessage - function(batch) => user message string
 * @param {string[]} subjectNames - original subject names for validation
 * @param {number} maxDepth - profondeur max de split recursif
 * @returns {Promise<{exclure: string[], garder: string[], incertain: string[]}>}
 */
async function callAIWithAutoSplit(
  systemPrompt,
  subjectBatch,
  buildMessage,
  subjectNames,
  maxDepth = 3
) {
  const userMessage = buildMessage(subjectBatch);

  try {
    const result = await callAI(systemPrompt, userMessage);
    return validateFilterResults(result, subjectNames);
  } catch (e) {
    // Si le batch est deja de taille 1 ou profondeur max atteinte, abandonner ce batch
    if (subjectBatch.length <= 1 || maxDepth <= 0) {
      console.warn(
        `🧹 [AI Split] Impossible de traiter le batch (${subjectBatch.length} sujets), skip:`,
        e.message
      );
      return { exclure: [], garder: [], incertain: subjectNames };
    }

    // Split le batch en 2 et retenter
    const mid = Math.ceil(subjectBatch.length / 2);
    const firstHalf = subjectBatch.slice(0, mid);
    const secondHalf = subjectBatch.slice(mid);
    const firstNames = subjectNames.slice(0, mid);
    const secondNames = subjectNames.slice(mid);

    console.log(
      `🧹 [AI Split] JSON echoue, split en 2 (${firstHalf.length} + ${secondHalf.length}) — profondeur ${maxDepth - 1}`
    );

    const [r1, r2] = await Promise.all([
      callAIWithAutoSplit(systemPrompt, firstHalf, buildMessage, firstNames, maxDepth - 1),
      callAIWithAutoSplit(systemPrompt, secondHalf, buildMessage, secondNames, maxDepth - 1),
    ]);

    return {
      exclure: [...r1.exclure, ...r2.exclure],
      garder: [...r1.garder, ...r2.garder],
      incertain: [...r1.incertain, ...r2.incertain],
    };
  }
}

// --- Orchestrator ---

/**
 * Lance le filtrage IA en 2 passes
 * @param {string[]} subjects - Liste des sujets a trier
 * @param {function} getEmailsForSubject - (subject) => email[] - recupere les emails d'un sujet
 * @param {function} onProgress - ({ phase, progress, message }) => void
 * @returns {Promise<{exclure: string[], garder: string[], incertain: string[]}>}
 */
export async function startAIFiltering(subjects, getEmailsForSubject, onProgress = () => {}) {
  // subjects peut etre un array d'objets {subject, participants, userReplied, ...} ou de strings
  const subjectObjects = subjects.map((s) => (typeof s === 'string' ? { subject: s } : s));
  const subjectMap = new Map(subjectObjects.map((s) => [s.subject, s]));

  // Reset stats
  filterStats = { totalRequests: 0, totalTokensEstimated: 0 };

  // --- Pre-filtrage code — cas evidents sans IA ---
  const userEmail = new URLSearchParams(window.location.search).get('email') || '';
  const preFiltered = preFilterSubjects(subjectObjects, userEmail);

  console.log(
    `🧹 [Pre-filter] Auto-exclure: ${preFiltered.autoExclude.length}, Auto-garder: ${preFiltered.autoKeep.length}, A analyser par IA: ${preFiltered.needsAI.length}`
  );
  onProgress({
    phase: 'prefilter',
    progress: 5,
    message: `Pre-filtrage : ${preFiltered.autoExclude.length} exclus, ${preFiltered.autoKeep.length} gardes automatiquement`,
  });

  // Filtrer les sujets pour ne garder que ceux qui necessitent l'IA
  const needsAISet = new Set(preFiltered.needsAI);
  const aiSubjectObjects = subjectObjects.filter((s) => needsAISet.has(s.subject));

  if (aiSubjectObjects.length === 0) {
    console.log(`🧹 [AI Filter] Pre-filtrage a tout classe, pas besoin d'IA`);
    onProgress({
      phase: 'done',
      progress: 100,
      message: 'Analyse terminee (pre-filtrage uniquement) !',
    });
    return {
      exclure: [...preFiltered.autoExclude],
      garder: [...preFiltered.autoKeep],
      incertain: [],
    };
  }

  // Detecter la taille de contexte du modele
  const contextSize = await getModelContextSize();
  // Reserve ~30% pour le system prompt + output, le reste pour l'input
  const inputBudgetTokens = Math.floor(contextSize * 0.6);
  const inputBudgetChars = inputBudgetTokens * 4; // ~4 chars per token

  console.log(
    `🧹 [AI Filter] Demarrage IA — ${aiSubjectObjects.length} sujets (sur ${subjectObjects.length}), contexte effectif: ${contextSize} tokens, budget input: ${inputBudgetChars} chars`
  );

  // --- Pass 1: tri par nom de sujet (en batches) ---
  const pass1Batches = buildPass1Batches(aiSubjectObjects, inputBudgetChars);
  console.log(
    `🧹 [AI Filter] Passe 1 — ${aiSubjectObjects.length} sujets en ${pass1Batches.length} batches`
  );

  const pass1 = { exclure: [], garder: [], incertain: [] };

  for (let i = 0; i < pass1Batches.length; i++) {
    const batch = pass1Batches[i];
    const batchNames = batch.map((s) => (typeof s === 'string' ? s : s.subject));
    const percent = 5 + ((i + 1) / pass1Batches.length) * 25;
    onProgress({
      phase: 'pass1',
      progress: percent,
      message: `Passe 1 : Batch ${i + 1}/${pass1Batches.length} (${batchNames.length} sujets)...`,
    });

    console.log(
      `🧹 [AI Filter] Passe 1 batch ${i + 1}/${pass1Batches.length} — ${batchNames.length} sujets`
    );

    const batchValidated = await callAIWithAutoSplit(
      SYSTEM_PROMPT_PASS1,
      batch,
      buildPass1UserMessage,
      batchNames
    );
    console.log(`🧹 [AI Filter] Passe 1 batch ${i + 1} reponse:`, batchValidated);

    pass1.exclure.push(...batchValidated.exclure);

    // Sujets avec Participation=oui → garder directement
    const excludedSet = new Set(batchValidated.exclure);
    for (const s of batch) {
      const name = typeof s === 'string' ? s : s.subject;
      if (excludedSet.has(name)) continue;
      if (typeof s === 'object' && s.userReplied) {
        pass1.garder.push(name);
      } else {
        pass1.incertain.push(name);
      }
    }

    console.log(
      `🧹 [AI Filter] Passe 1 batch ${i + 1} — exclure: ${batchValidated.exclure.length}, reste: ${batchNames.length - batchValidated.exclure.length}`
    );
  }

  console.log(
    `🧹 [AI Filter] Passe 1 terminee — exclure: ${pass1.exclure.length}, garder: ${pass1.garder.length}, incertain: ${pass1.incertain.length}`
  );
  onProgress({
    phase: 'pass1',
    progress: 30,
    message: `Passe 1 terminee : ${pass1.exclure.length} exclus, ${pass1.garder.length} gardes, ${pass1.incertain.length} incertains`,
  });

  if (pass1.incertain.length === 0) {
    console.log(`🧹 [AI Filter] Pas d'incertains, fin de l'analyse`);
    return {
      exclure: [...preFiltered.autoExclude, ...pass1.exclure],
      garder: [...preFiltered.autoKeep, ...pass1.garder],
      incertain: [],
    };
  }

  // --- Pass 2: analyse approfondie des incertains ---
  onProgress({
    phase: 'pass2',
    progress: 35,
    message: `Passe 2 : Chargement des mails pour ${pass1.incertain.length} sujets...`,
  });

  const pass2Subjects = [];
  for (let idx = 0; idx < pass1.incertain.length; idx++) {
    const subjectName = pass1.incertain[idx];
    if (idx % 10 === 0) {
      const loadPercent = 35 + (idx / pass1.incertain.length) * 15;
      onProgress({
        phase: 'pass2',
        progress: loadPercent,
        message: `Passe 2 : Chargement des mails (${idx}/${pass1.incertain.length})...`,
      });
    }
    const subjectInfo = subjectMap.get(subjectName);
    if (!subjectInfo) {
      console.warn(`🧹 [AI Filter] Sujet "${subjectName}" introuvable dans subjectMap, skip`);
      continue;
    }
    try {
      const emails = await getEmailsForSubject(subjectInfo);
      console.log(
        `🧹 [AI Filter] Passe 2 — "${subjectName}": ${(emails || []).length} mails charges`
      );
      const promptBlock = buildPass2PromptBlock(subjectName, emails || []);
      pass2Subjects.push({ subject: subjectName, promptBlock });
    } catch (e) {
      console.warn(`🧹 [AI Filter] Erreur chargement mails pour "${subjectName}":`, e.message);
      const promptBlock = buildPass2PromptBlock(subjectName, []);
      pass2Subjects.push({ subject: subjectName, promptBlock });
    }
  }

  const pass2TokenBudget = Math.floor(contextSize * 0.7); // more room for pass 2 output
  const batches = buildPass2Batches(pass2Subjects, pass2TokenBudget);
  console.log(
    `🧹 [AI Filter] Passe 2 — ${pass2Subjects.length} sujets en ${batches.length} batches`
  );

  const pass2Result = { exclure: [], garder: [], incertain: [] };

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const userMessage = batch.map((s) => s.promptBlock).join('\n\n');
    const batchSubjectNames = batch.map((s) => s.subject);
    const percent = 35 + ((i + 1) / batches.length) * 60;

    console.log(
      `🧹 [AI Filter] Passe 2 — batch ${i + 1}/${batches.length} (${batchSubjectNames.length} sujets, ${userMessage.length} chars)`
    );
    onProgress({
      phase: 'pass2',
      progress: percent,
      message: `Passe 2 : Analyse batch ${i + 1}/${batches.length}...`,
    });

    const batchResult = await callAIWithAutoSplit(
      SYSTEM_PROMPT_PASS2,
      batch,
      (b) => b.map((s) => s.promptBlock).join('\n\n'),
      batchSubjectNames
    );
    console.log(`🧹 [AI Filter] Passe 2 batch ${i + 1} reponse:`, batchResult);

    pass2Result.exclure.push(...batchResult.exclure);
    pass2Result.garder.push(...batchResult.garder);
    pass2Result.incertain.push(...batchResult.incertain);

    // Sujets non mentionnes dans ce batch → incertain
    const mentionedBatch = new Set([
      ...batchResult.exclure,
      ...batchResult.garder,
      ...batchResult.incertain,
    ]);
    const unmBatch = batchSubjectNames.filter((s) => !mentionedBatch.has(s));
    if (unmBatch.length > 0) {
      console.log(
        `🧹 [AI Filter] Passe 2 batch ${i + 1} — ${unmBatch.length} sujets non mentionnes → incertain`
      );
      pass2Result.incertain.push(...unmBatch);
    }
  }

  // Merge results (pre-filter + AI passes)
  const finalResults = {
    exclure: [...preFiltered.autoExclude, ...pass1.exclure, ...pass2Result.exclure],
    garder: [...preFiltered.autoKeep, ...pass1.garder, ...pass2Result.garder],
    incertain: [...pass2Result.incertain],
  };

  console.log(
    `🧹 [AI Filter] TERMINE — exclure: ${finalResults.exclure.length}, garder: ${finalResults.garder.length}, incertain: ${finalResults.incertain.length}`
  );
  onProgress({ phase: 'done', progress: 100, message: 'Analyse terminee !' });

  return finalResults;
}
