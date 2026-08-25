/**
 * Orchestrateur du chat IA par sujet.
 * - buildInitialContext : formate les emails d'un thread pour injection IA
 * - sendMessage : envoie un message user, streame la reponse, persiste
 * - regenerateLastMessage : supprime + regenere le dernier message assistant
 * - resetConversation : efface l'historique d'un sujet
 */

import { loadChat, saveChat, deleteChat } from './aiChatStore.js';
import { getAIConfig } from './aiConfig.js';

const MAX_EMAILS_IN_CONTEXT = 20;
const MAX_BODY_CHARS = 3000;

const SYSTEM_PROMPT = `Tu es un assistant email expert. Tu aides un utilisateur a comprendre et a
traiter ses conversations email.

Tu as 3 roles :
1. Q&A FACTUEL : reponds aux questions sur le thread fourni, UNIQUEMENT
   avec les informations presentes dans les mails. Si l'info n'y est pas,
   dis-le franchement : "D'apres le contexte fourni, je ne peux pas repondre a cette question."
2. REDACTION : quand l'utilisateur demande une reponse, redige-la dans
   un ton professionnel (sauf indication contraire), adaptee au destinataire
   et au contexte du thread.
3. COMPREHENSION : aide a comprendre l'historique — resumes, chronologie,
   decisions prises, points en suspens.

REGLES CRITIQUES :
- NE JAMAIS inventer de dates, noms, engagements, chiffres qui ne sont pas
  explicitement dans les mails. L'hallucination est interdite.
- Cite les mails quand c'est pertinent (ex: "D'apres le mail du 12 avril de Jean...").
- Reste concis sauf si on te demande du detail.
- Reponds dans la langue de l'utilisateur.`;

/**
 * Supprime le contenu cite (historique des reponses precedentes) du corps d'un mail.
 * Recherche par substring (sans ancrage ^) pour etre robuste aux bodies collapses
 * en une seule ligne (ex: HTML converti sans preservation des \n).
 */
export function stripQuotedText(body) {
  if (!body) return '';

  // Patterns detectes n'importe ou dans le texte — on coupe a la premiere occurrence.
  const QUOTE_MARKERS = [
    /Le\s+\S+\s+\d{1,2}\s+\S+\s+\d{4}\s+[àa]\s+\d{1,2}:\d{2}[^]*?a\s+[ée]crit\s*:/i,  // Gmail FR
    /On\s+\w+,?\s+\w+\.?\s+\d{1,2},?\s+\d{4}\s+at\s+\d{1,2}:\d{2}[^]*?wrote:/i,       // Gmail EN date "On Thu, Sep 19, 2024 at..."
    /On\s+\w+\s+\d{1,2}\s+\w+\s+\d{4}\s+at\s+\d{1,2}:\d{2}[^]*?wrote:/i,               // Gmail EN variant
    /[-_]{3,}\s*(Original|Forwarded|Begin\s+forwarded)\s+message/i,                     // Outlook dividers
    /_{5,}/,                                                                             // Underscore separator
    /From:\s*.+?Sent:\s*.+?To:/is,                                                       // Outlook header block
    /^De\s*:\s*.+<.+@/im,                                                                // Outlook FR "De : ..."
    /^Envoy[ée]\s*:\s*/im,                                                               // Outlook FR "Envoye : ..."
    /^Sent\s*:\s*/im,                                                                    // Outlook EN "Sent: ..."
  ];

  // Cherche la plus ancienne occurrence de citation
  let earliestIndex = body.length;
  for (const re of QUOTE_MARKERS) {
    const m = body.match(re);
    if (m && m.index !== undefined && m.index < earliestIndex) {
      earliestIndex = m.index;
    }
  }

  const result = body.slice(0, earliestIndex);

  // Retire aussi les lignes commencant par > (citation classique) presentes avant un marker
  const lines = result.split('\n');
  const out = [];
  for (const line of lines) {
    if (line.trim().startsWith('>')) break;
    out.push(line);
  }

  return out.join('\n').trim();
}

/**
 * Construit le message-contexte initial a injecter a la premiere requete.
 */
export function buildInitialContext(subjectKey, emails, totalCount) {
  const sorted = [...emails].sort((a, b) => (b.date || 0) - (a.date || 0));
  const selected = sorted.slice(0, MAX_EMAILS_IN_CONTEXT);

  let out = `# Thread : ${subjectKey}\n`;
  out += `# ${selected.length} mails envoyes (sur ${totalCount} au total)\n`;
  out += `# Contenu cite (reponses precedentes) strippe — chaque mail ne contient que son contenu propre\n\n`;

  selected.forEach((email, i) => {
    const date = email.date
      ? new Date(email.date).toISOString().split('T')[0]
      : 'inconnue';
    const from = email.from || 'inconnu';
    const stripped = stripQuotedText(email.bodyText || '');
    const body = stripped.slice(0, MAX_BODY_CHARS);
    const suffix = stripped.length > MAX_BODY_CHARS ? '...' : '';
    out += `## Mail ${i + 1} — ${date} — De: ${from}\n${body || '(contenu vide apres retrait des citations)'}${suffix}\n\n`;
  });

  return out;
}

// --- SSE chunk parsers (one per provider family) ---

export function parseOpenAIChunk(line) {
  if (!line.startsWith('data: ')) return null;
  const dataStr = line.slice(6).trim();
  if (!dataStr) return null;
  if (dataStr === '[DONE]') return { done: true };

  try {
    const obj = JSON.parse(dataStr);
    const delta = obj.choices?.[0]?.delta?.content;
    if (delta) return { delta };
    if (obj.usage) {
      return {
        usage: {
          input_tokens: obj.usage.prompt_tokens || 0,
          output_tokens: obj.usage.completion_tokens || 0
        }
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

export function parseAnthropicChunk(line) {
  if (!line.startsWith('data: ')) return null;
  const dataStr = line.slice(6).trim();
  if (!dataStr) return null;

  try {
    const obj = JSON.parse(dataStr);
    if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') {
      return { delta: obj.delta.text };
    }
    if (obj.type === 'message_start' && obj.message?.usage) {
      return {
        usage: {
          input_tokens: obj.message.usage.input_tokens || 0,
          output_tokens: 0
        }
      };
    }
    if (obj.type === 'message_delta' && obj.usage) {
      return {
        usage: {
          input_tokens: 0,
          output_tokens: obj.usage.output_tokens || 0
        }
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Consomme un stream SSE depuis /api/ai/chat.
 * Retourne { assistantContent, usage, error }.
 * - assistantContent : contenu final accumule
 * - usage : { input_tokens, output_tokens } ou null si provider n'en fournit pas
 * - error : message d'erreur si quelque chose a echoue, sinon null
 * @param {Object} body
 * @param {'openai'|'ollama'|'custom'|'anthropic'} provider
 * @param {(partial: string) => void} onDelta
 */
async function streamChat(body, provider, onDelta) {
  let response;
  try {
    response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return { assistantContent: '', usage: null, error: `Impossible de joindre le serveur: ${e.message}` };
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    return { assistantContent: '', usage: null, error: err.error || `HTTP ${response.status}` };
  }

  const parseFn = provider === 'anthropic' ? parseAnthropicChunk : parseOpenAIChunk;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let assistantContent = '';
  let usage = null;

  const handleLine = (line) => {
    if (!line.trim()) return;
    const parsed = parseFn(line);
    if (!parsed) return;
    if (parsed.delta) {
      assistantContent += parsed.delta;
      onDelta && onDelta(assistantContent);
    }
    if (parsed.usage) {
      usage = usage || { input_tokens: 0, output_tokens: 0 };
      if (parsed.usage.input_tokens) usage.input_tokens = parsed.usage.input_tokens;
      if (parsed.usage.output_tokens) usage.output_tokens = parsed.usage.output_tokens;
    }
  };

  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (e) {
      return { assistantContent, usage, error: `Stream interrompu: ${e.message}` };
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) handleLine(line);
  }
  // Flush trailing buffer if server didn't terminate on \n (edge case)
  if (buffer.trim()) handleLine(buffer);

  return { assistantContent, usage, error: null };
}

function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/**
 * Execute un tour assistant sur un chat existant : streame, push le message, persiste.
 * Partage entre sendMessage et regenerateLastMessage.
 * @returns {Promise<{ chat, error }>}
 */
async function runAssistantTurn(chat, onDelta) {
  const config = getAIConfig();
  const body = {
    ...config,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...chat.messages.map(m => ({ role: m.role, content: m.content }))
    ],
    stream: true
  };

  const { assistantContent, usage, error } = await streamChat(body, config.provider, onDelta);
  if (error) return { chat, error };

  chat.messages.push({ role: 'assistant', content: assistantContent, ts: Date.now() });
  const inputEst = body.messages.reduce((acc, m) => acc + estimateTokens(m.content), 0);
  chat.tokensIn += (usage && usage.input_tokens) || inputEst;
  chat.tokensOut += (usage && usage.output_tokens) || estimateTokens(assistantContent);
  chat.msgCount = chat.messages.length;
  chat.updatedAt = Date.now();

  try {
    await saveChat(chat.subjectKey, chat);
  } catch (e) {
    return { chat, error: `Erreur sauvegarde: ${e.message}` };
  }
  return { chat, error: null };
}

/**
 * Envoie un message user et streame la reponse assistant.
 */
export async function sendMessage(subjectKey, userMessage, opts) {
  const { subjectInfo, getEmailsForSubject, onDelta, onComplete, onError } = opts;

  let chat = await loadChat(subjectKey);
  if (!chat) {
    chat = {
      subjectKey,
      messages: [],
      tokensIn: 0,
      tokensOut: 0,
      msgCount: 0,
      updatedAt: Date.now()
    };
  }

  if (chat.messages.length === 0) {
    let emails = [];
    try {
      emails = await getEmailsForSubject(subjectInfo);
    } catch (e) {
      onError && onError(`Erreur chargement des mails: ${e.message}`);
      return;
    }
    const ctxContent = buildInitialContext(subjectKey, emails, emails.length);
    chat.messages.push({
      role: 'user',
      content: ctxContent,
      ts: Date.now(),
      isContextMessage: true
    });
  }

  chat.messages.push({ role: 'user', content: userMessage, ts: Date.now() });

  const { chat: updatedChat, error } = await runAssistantTurn(chat, onDelta);
  if (error) {
    onError && onError(error);
    return;
  }
  onComplete && onComplete(updatedChat);
}

/**
 * Supprime le dernier message assistant et relance un stream sur le meme historique.
 */
export async function regenerateLastMessage(subjectKey, opts) {
  const { onDelta, onComplete, onError } = opts;
  const chat = await loadChat(subjectKey);
  if (!chat || chat.messages.length === 0) {
    onError && onError('Aucune conversation a regenerer');
    return;
  }
  if (chat.messages[chat.messages.length - 1].role !== 'assistant') {
    onError && onError('Le dernier message n\'est pas de l\'assistant');
    return;
  }
  chat.messages.pop();

  const { chat: updatedChat, error } = await runAssistantTurn(chat, onDelta);
  if (error) {
    onError && onError(error);
    return;
  }
  onComplete && onComplete(updatedChat);
}

export async function resetConversation(subjectKey) {
  await deleteChat(subjectKey);
}
