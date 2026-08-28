/**
 * AI-powered smart filtering module
 * Pass 1: quick triage on subject names only
 * Pass 2: deep analysis of the unsure subjects, using the email content
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
 * Pre-filters the subjects with deterministic rules before calling the AI.
 * @param {Array<{subject: string, participants?: string[], userReplied?: boolean, userInTo?: boolean, isNewsletter?: boolean, snippets?: string, hasAttachments?: boolean}>} subjects
 * @param {string} userEmail - the signed-in user's email address
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
 * Reads the context size of the configured model
 * @returns {Promise<number>} context size in tokens
 */
// Share of the theoretical context that is really usable for instruction following.
// Small local models lose quality well before reaching their theoretical limit.
// Large cloud models keep their quality over a bigger share of their window.
const USABLE_CONTEXT_RATIO = {
  ollama: 0.03, // ~3% — lightweight local models, quality degrades fast
  openai: 0.25, // ~25% — large models, good long-context handling
  anthropic: 0.15, // ~15% — very large context (200k), 15% = ~30k usable
  custom: 0.05, // ~5% — conservative, the model is unknown
};

// Stats counter for the report
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
      `🧹 [AI Config] Model: ${data.model}, theoretical context: ${theoreticalContext}, ratio: ${(ratio * 100).toFixed(0)}%, effective: ${effective} tokens`
    );
    return effective;
  } catch (e) {
    const fallback = Math.max(Math.floor(8192 * ratio), 1024);
    console.warn(
      `🧹 [AI Config] Could not read the context size, defaulting to ${fallback} tokens (${(ratio * 100).toFixed(0)}% of 8192)`
    );
    return fallback;
  }
}

// --- System Prompts ---

// The JSON keys ("exclure", "garder", "incertain") are the wire format shared with
// aiFilterReport.js and the saved filters — they stay as-is, only the instructions
// around them are in English.
const SYSTEM_PROMPT_PASS1 = `You sort emails. List ONLY the subjects to exclude.

exclure = newsletter, automated notification, spam, marketing, system alert, automated invoice, order confirmation
Do NOT exclude when Participation=yes.

Answer with JSON ONLY, nothing else:
{"exclure":["subject1","subject2"]}`;

const SYSTEM_PROMPT_PASS2 = `You are an assistant specialised in sorting work emails.
You are given email subjects with a preview of their content (senders and the beginning of the messages).
For each subject, classify it into one of 2 categories:
- "exclure": automated notifications, newsletters, spam, system alerts, marketing emails, machine-generated emails
- "garder": human conversations, professional exchanges, project discussions

Answer with valid JSON ONLY, in the format:
{"exclure": ["subject1"], "garder": ["subject2"], "incertain": []}

IMPORTANT: use the subjects EXACTLY as provided, without modifying them.`;

// --- Pure functions (also duplicated in tests) ---

export function parseAIFilterResponse(text) {
  let jsonStr = text.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();
  const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!objectMatch) {
    // Try to extract quoted subjects even without valid JSON
    const quotedItems = [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (quotedItems.length > 0) {
      console.warn('🧹 [Parse] Invalid JSON, extracting from quotes:', quotedItems.length, 'items');
      return { exclure: quotedItems, garder: [], incertain: [] };
    }
    throw new Error('No JSON found in the AI response');
  }
  // Strip the control characters that break JSON.parse
  // eslint-disable-next-line no-control-regex -- intentionally matching the control characters to strip
  let cleanJson = objectMatch[0].replace(/[\x00-\x1F\x7F]/g, (c) =>
    c === '\n' || c === '\r' || c === '\t' ? c : ''
  );

  // Try to repair a truncated JSON (unclosed array)
  try {
    const parsed = JSON.parse(cleanJson);
    return normalizeResult(parsed);
  } catch (e) {
    // Try to close the truncated arrays/objects
    console.warn('🧹 [Parse] Truncated JSON, attempting repair...');
    // Drop the last incomplete item (after the last comma)
    cleanJson = cleanJson.replace(/,\s*"[^"]*$/, '');
    // Close the missing brackets and braces
    const openBrackets = (cleanJson.match(/\[/g) || []).length;
    const closeBrackets = (cleanJson.match(/\]/g) || []).length;
    const openBraces = (cleanJson.match(/\{/g) || []).length;
    const closeBraces = (cleanJson.match(/\}/g) || []).length;
    cleanJson += ']'.repeat(Math.max(0, openBrackets - closeBrackets));
    cleanJson += '}'.repeat(Math.max(0, openBraces - closeBraces));

    try {
      const parsed = JSON.parse(cleanJson);
      console.log('🧹 [Parse] JSON repaired successfully');
      return normalizeResult(parsed);
    } catch (e2) {
      // Last resort: extract the quoted subjects
      const quotedItems = [...text.matchAll(/"([^"]{3,})"/g)].map((m) => m[1]);
      if (quotedItems.length > 0) {
        console.warn('🧹 [Parse] Extracting from quotes:', quotedItems.length, 'items');
        return { exclure: quotedItems, garder: [], incertain: [] };
      }
      throw new Error('No JSON found in the AI response');
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
      const participation = typeof s === 'object' && s.userReplied ? 'yes' : 'no';
      return `${i + 1}. "${name}" | From: ${from || '?'} | Participation: ${participation}`;
    })
    .join('\n');
}

/**
 * Splits the subjects into batches for pass 1 (max ~4000 tokens per batch)
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
  let block = `## Subject: ${subject}\n`;
  for (const email of selected) {
    // Strips the quoted text so that only each email's own new content is compared —
    // avoids skewing template detection (otherwise 5 "identical" emails because of quotes).
    const stripped = stripQuotedText(email.bodyText || '');
    const body = stripped.slice(0, maxBodyChars);
    block += `- From: ${email.from || 'unknown'}\n  Beginning: ${body}${body.length >= maxBodyChars ? '...' : ''}\n`;
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
    `🧹 [AI Call] Sending request (${userMessage.length} chars, ~${inputTokens} tokens, retries: ${retries})`
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
      throw new Error(err.error || `AI API error (${response.status})`);
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

    if (!text) throw new Error('Empty AI response');

    console.log(
      `🧹 [AI Call] Response received (${text.length} chars) — attempt ${attempt + 1}/${retries + 1}`
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
        `🧹 [AI Call] Attempt ${attempt + 1}/${retries + 1} failed:`,
        parseError.message
      );
      console.warn(`🧹 [AI Call] Raw text received:`, text.substring(0, 500));
    }
  }
}

/**
 * Calls the AI with retries and an automatic split when the JSON is truncated
 * @param {string} systemPrompt
 * @param {Array} subjectBatch - array of subjects or {subject, promptBlock} objects
 * @param {Function} buildMessage - function(batch) => user message string
 * @param {string[]} subjectNames - original subject names for validation
 * @param {number} maxDepth - max recursive split depth
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
    // If the batch is already down to 1 or max depth is reached, give up on it
    if (subjectBatch.length <= 1 || maxDepth <= 0) {
      console.warn(
        `🧹 [AI Split] Cannot process the batch (${subjectBatch.length} subjects), skipping:`,
        e.message
      );
      return { exclure: [], garder: [], incertain: subjectNames };
    }

    // Split the batch in 2 and retry
    const mid = Math.ceil(subjectBatch.length / 2);
    const firstHalf = subjectBatch.slice(0, mid);
    const secondHalf = subjectBatch.slice(mid);
    const firstNames = subjectNames.slice(0, mid);
    const secondNames = subjectNames.slice(mid);

    console.log(
      `🧹 [AI Split] JSON failed, splitting in 2 (${firstHalf.length} + ${secondHalf.length}) — depth ${maxDepth - 1}`
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
 * Runs the 2-pass AI filtering
 * @param {string[]} subjects - list of the subjects to sort
 * @param {function} getEmailsForSubject - (subject) => email[] - loads a subject's emails
 * @param {function} onProgress - ({ phase, progress, message }) => void
 * @returns {Promise<{exclure: string[], garder: string[], incertain: string[]}>}
 */
export async function startAIFiltering(subjects, getEmailsForSubject, onProgress = () => {}) {
  // subjects can be an array of {subject, participants, userReplied, ...} objects or of strings
  const subjectObjects = subjects.map((s) => (typeof s === 'string' ? { subject: s } : s));
  const subjectMap = new Map(subjectObjects.map((s) => [s.subject, s]));

  // Reset stats
  filterStats = { totalRequests: 0, totalTokensEstimated: 0 };

  // --- Code pre-filtering — obvious cases, no AI needed ---
  const userEmail = new URLSearchParams(window.location.search).get('email') || '';
  const preFiltered = preFilterSubjects(subjectObjects, userEmail);

  console.log(
    `🧹 [Pre-filter] Auto-exclude: ${preFiltered.autoExclude.length}, Auto-keep: ${preFiltered.autoKeep.length}, To analyse with AI: ${preFiltered.needsAI.length}`
  );
  onProgress({
    phase: 'prefilter',
    progress: 5,
    message: `Pre-filtering: ${preFiltered.autoExclude.length} excluded, ${preFiltered.autoKeep.length} kept automatically`,
  });

  // Keep only the subjects that still need the AI
  const needsAISet = new Set(preFiltered.needsAI);
  const aiSubjectObjects = subjectObjects.filter((s) => needsAISet.has(s.subject));

  if (aiSubjectObjects.length === 0) {
    console.log(`🧹 [AI Filter] Pre-filtering classified everything, no AI needed`);
    onProgress({
      phase: 'done',
      progress: 100,
      message: 'Analysis complete (pre-filtering only)!',
    });
    return {
      exclure: [...preFiltered.autoExclude],
      garder: [...preFiltered.autoKeep],
      incertain: [],
    };
  }

  // Detect the model context size
  const contextSize = await getModelContextSize();
  // Reserve ~30% for the system prompt + output, the rest for the input
  const inputBudgetTokens = Math.floor(contextSize * 0.6);
  const inputBudgetChars = inputBudgetTokens * 4; // ~4 chars per token

  console.log(
    `🧹 [AI Filter] Starting AI — ${aiSubjectObjects.length} subjects (out of ${subjectObjects.length}), effective context: ${contextSize} tokens, input budget: ${inputBudgetChars} chars`
  );

  // --- Pass 1: triage by subject name (in batches) ---
  const pass1Batches = buildPass1Batches(aiSubjectObjects, inputBudgetChars);
  console.log(
    `🧹 [AI Filter] Pass 1 — ${aiSubjectObjects.length} subjects in ${pass1Batches.length} batches`
  );

  const pass1 = { exclure: [], garder: [], incertain: [] };

  for (let i = 0; i < pass1Batches.length; i++) {
    const batch = pass1Batches[i];
    const batchNames = batch.map((s) => (typeof s === 'string' ? s : s.subject));
    const percent = 5 + ((i + 1) / pass1Batches.length) * 25;
    onProgress({
      phase: 'pass1',
      progress: percent,
      message: `Pass 1: batch ${i + 1}/${pass1Batches.length} (${batchNames.length} subjects)...`,
    });

    console.log(
      `🧹 [AI Filter] Pass 1 batch ${i + 1}/${pass1Batches.length} — ${batchNames.length} subjects`
    );

    const batchValidated = await callAIWithAutoSplit(
      SYSTEM_PROMPT_PASS1,
      batch,
      buildPass1UserMessage,
      batchNames
    );
    console.log(`🧹 [AI Filter] Pass 1 batch ${i + 1} response:`, batchValidated);

    pass1.exclure.push(...batchValidated.exclure);

    // Subjects with Participation=yes → kept straight away
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
      `🧹 [AI Filter] Pass 1 batch ${i + 1} — exclure: ${batchValidated.exclure.length}, left: ${batchNames.length - batchValidated.exclure.length}`
    );
  }

  console.log(
    `🧹 [AI Filter] Pass 1 done — exclure: ${pass1.exclure.length}, garder: ${pass1.garder.length}, incertain: ${pass1.incertain.length}`
  );
  onProgress({
    phase: 'pass1',
    progress: 30,
    message: `Pass 1 complete: ${pass1.exclure.length} excluded, ${pass1.garder.length} kept, ${pass1.incertain.length} unsure`,
  });

  if (pass1.incertain.length === 0) {
    console.log(`🧹 [AI Filter] No unsure subjects, analysis finished`);
    return {
      exclure: [...preFiltered.autoExclude, ...pass1.exclure],
      garder: [...preFiltered.autoKeep, ...pass1.garder],
      incertain: [],
    };
  }

  // --- Pass 2: deep analysis of the unsure subjects ---
  onProgress({
    phase: 'pass2',
    progress: 35,
    message: `Pass 2: loading the emails for ${pass1.incertain.length} subjects...`,
  });

  const pass2Subjects = [];
  for (let idx = 0; idx < pass1.incertain.length; idx++) {
    const subjectName = pass1.incertain[idx];
    if (idx % 10 === 0) {
      const loadPercent = 35 + (idx / pass1.incertain.length) * 15;
      onProgress({
        phase: 'pass2',
        progress: loadPercent,
        message: `Pass 2: loading the emails (${idx}/${pass1.incertain.length})...`,
      });
    }
    const subjectInfo = subjectMap.get(subjectName);
    if (!subjectInfo) {
      console.warn(`🧹 [AI Filter] Subject "${subjectName}" not found in subjectMap, skipping`);
      continue;
    }
    try {
      const emails = await getEmailsForSubject(subjectInfo);
      console.log(
        `🧹 [AI Filter] Pass 2 — "${subjectName}": ${(emails || []).length} emails loaded`
      );
      const promptBlock = buildPass2PromptBlock(subjectName, emails || []);
      pass2Subjects.push({ subject: subjectName, promptBlock });
    } catch (e) {
      console.warn(`🧹 [AI Filter] Error loading the emails for "${subjectName}":`, e.message);
      const promptBlock = buildPass2PromptBlock(subjectName, []);
      pass2Subjects.push({ subject: subjectName, promptBlock });
    }
  }

  const pass2TokenBudget = Math.floor(contextSize * 0.7); // more room for pass 2 output
  const batches = buildPass2Batches(pass2Subjects, pass2TokenBudget);
  console.log(
    `🧹 [AI Filter] Pass 2 — ${pass2Subjects.length} subjects in ${batches.length} batches`
  );

  const pass2Result = { exclure: [], garder: [], incertain: [] };

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const userMessage = batch.map((s) => s.promptBlock).join('\n\n');
    const batchSubjectNames = batch.map((s) => s.subject);
    const percent = 35 + ((i + 1) / batches.length) * 60;

    console.log(
      `🧹 [AI Filter] Pass 2 — batch ${i + 1}/${batches.length} (${batchSubjectNames.length} subjects, ${userMessage.length} chars)`
    );
    onProgress({
      phase: 'pass2',
      progress: percent,
      message: `Pass 2: analysing batch ${i + 1}/${batches.length}...`,
    });

    const batchResult = await callAIWithAutoSplit(
      SYSTEM_PROMPT_PASS2,
      batch,
      (b) => b.map((s) => s.promptBlock).join('\n\n'),
      batchSubjectNames
    );
    console.log(`🧹 [AI Filter] Pass 2 batch ${i + 1} response:`, batchResult);

    pass2Result.exclure.push(...batchResult.exclure);
    pass2Result.garder.push(...batchResult.garder);
    pass2Result.incertain.push(...batchResult.incertain);

    // Subjects not mentioned in this batch → incertain
    const mentionedBatch = new Set([
      ...batchResult.exclure,
      ...batchResult.garder,
      ...batchResult.incertain,
    ]);
    const unmBatch = batchSubjectNames.filter((s) => !mentionedBatch.has(s));
    if (unmBatch.length > 0) {
      console.log(
        `🧹 [AI Filter] Pass 2 batch ${i + 1} — ${unmBatch.length} subjects not mentioned → incertain`
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
    `🧹 [AI Filter] DONE — exclure: ${finalResults.exclure.length}, garder: ${finalResults.garder.length}, incertain: ${finalResults.incertain.length}`
  );
  onProgress({ phase: 'done', progress: 100, message: 'Analysis complete!' });

  return finalResults;
}
