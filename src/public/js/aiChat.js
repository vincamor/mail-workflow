/**
 * Per-subject AI chat orchestrator.
 * - buildInitialContext: formats a subject's emails for AI injection
 * - sendMessage: sends a user message, streams the response, persists it
 * - regenerateLastMessage: deletes + regenerates the last assistant message
 * - resetConversation: clears a subject's history
 */

import { loadChat, saveChat, deleteChat } from './aiChatStore.js';
import { getAIConfig } from './aiConfig.js';

const MAX_EMAILS_IN_CONTEXT = 20;
const MAX_BODY_CHARS = 3000;

const SYSTEM_PROMPT = `You are an expert email assistant. You help a user understand and handle
their email conversations.

You have 3 roles:
1. FACTUAL Q&A: answer questions about the subject provided, using ONLY
   the information present in the emails. If the information is not there,
   say so plainly: "Based on the context provided, I cannot answer that question."
2. WRITING: when the user asks for a reply, write it in a professional
   tone (unless told otherwise), suited to the recipient and to the
   context of the subject.
3. UNDERSTANDING: help make sense of the history — summaries, timeline,
   decisions taken, open points.

CRITICAL RULES:
- NEVER invent dates, names, commitments or figures that are not
  explicitly in the emails. Hallucination is forbidden.
- Quote the emails when relevant (e.g. "According to the 12 April email from Jean...").
- Stay concise unless you are asked for detail.
- Answer in the user's language.`;

/**
 * Removes the quoted text (history of the previous replies) from an email body.
 * Matches by substring (no ^ anchor) to stay robust against bodies collapsed
 * onto a single line (e.g. HTML converted without preserving the \n).
 */
export function stripQuotedText(body) {
  if (!body) return '';

  // Patterns matched anywhere in the text — we cut at the first occurrence.
  const QUOTE_MARKERS = [
    /Le\s+\S+\s+\d{1,2}\s+\S+\s+\d{4}\s+[àa]\s+\d{1,2}:\d{2}[^]*?a\s+[ée]crit\s*:/i, // Gmail FR
    /On\s+\w+,?\s+\w+\.?\s+\d{1,2},?\s+\d{4}\s+at\s+\d{1,2}:\d{2}[^]*?wrote:/i, // Gmail EN date "On Thu, Sep 19, 2024 at..."
    /On\s+\w+\s+\d{1,2}\s+\w+\s+\d{4}\s+at\s+\d{1,2}:\d{2}[^]*?wrote:/i, // Gmail EN variant
    /[-_]{3,}\s*(Original|Forwarded|Begin\s+forwarded)\s+message/i, // Outlook dividers
    /_{5,}/, // Underscore separator
    /From:\s*.+?Sent:\s*.+?To:/is, // Outlook header block
    /^De\s*:\s*.+<.+@/im, // Outlook FR "De : ..."
    /^Envoy[ée]\s*:\s*/im, // Outlook FR "Envoye : ..."
    /^Sent\s*:\s*/im, // Outlook EN "Sent: ..."
  ];

  // Look for the earliest occurrence of quoted text
  let earliestIndex = body.length;
  for (const re of QUOTE_MARKERS) {
    const m = body.match(re);
    if (m && m.index !== undefined && m.index < earliestIndex) {
      earliestIndex = m.index;
    }
  }

  const result = body.slice(0, earliestIndex);

  // Also drop the lines starting with > (classic quoting) that appear before a marker
  const lines = result.split('\n');
  const out = [];
  for (const line of lines) {
    if (line.trim().startsWith('>')) break;
    out.push(line);
  }

  return out.join('\n').trim();
}

/**
 * Builds the initial context message injected into the first request.
 */
export function buildInitialContext(subjectKey, emails, totalCount) {
  const sorted = [...emails].sort((a, b) => (b.date || 0) - (a.date || 0));
  const selected = sorted.slice(0, MAX_EMAILS_IN_CONTEXT);

  let out = `# Subject: ${subjectKey}\n`;
  out += `# ${selected.length} emails sent (out of ${totalCount} in total)\n`;
  out += `# Quoted text (previous replies) stripped — each email only contains its own content\n\n`;

  selected.forEach((email, i) => {
    const date = email.date ? new Date(email.date).toISOString().split('T')[0] : 'unknown';
    const from = email.from || 'unknown';
    const stripped = stripQuotedText(email.bodyText || '');
    const body = stripped.slice(0, MAX_BODY_CHARS);
    const suffix = stripped.length > MAX_BODY_CHARS ? '...' : '';
    out += `## Email ${i + 1} — ${date} — From: ${from}\n${body || '(empty content after removing the quoted text)'}${suffix}\n\n`;
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
          output_tokens: obj.usage.completion_tokens || 0,
        },
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
          output_tokens: 0,
        },
      };
    }
    if (obj.type === 'message_delta' && obj.usage) {
      return {
        usage: {
          input_tokens: 0,
          output_tokens: obj.usage.output_tokens || 0,
        },
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Consumes an SSE stream from /api/ai/chat.
 * Returns { assistantContent, usage, error }.
 * - assistantContent: the accumulated final content
 * - usage: { input_tokens, output_tokens }, or null when the provider gives none
 * - error: an error message if something failed, otherwise null
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
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      assistantContent: '',
      usage: null,
      error: `Cannot reach the server: ${e.message}`,
    };
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
      return { assistantContent, usage, error: `Stream interrupted: ${e.message}` };
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
 * Runs one assistant turn on an existing chat: streams, pushes the message, persists.
 * Shared by sendMessage and regenerateLastMessage.
 * @returns {Promise<{ chat, error }>}
 */
async function runAssistantTurn(chat, onDelta) {
  const config = getAIConfig();
  const body = {
    ...config,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    stream: true,
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
    return { chat, error: `Save error: ${e.message}` };
  }
  return { chat, error: null };
}

/**
 * Sends a user message and streams the assistant response.
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
      updatedAt: Date.now(),
    };
  }

  if (chat.messages.length === 0) {
    let emails = [];
    try {
      emails = await getEmailsForSubject(subjectInfo);
    } catch (e) {
      onError && onError(`Error loading the emails: ${e.message}`);
      return;
    }
    const ctxContent = buildInitialContext(subjectKey, emails, emails.length);
    chat.messages.push({
      role: 'user',
      content: ctxContent,
      ts: Date.now(),
      isContextMessage: true,
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
 * Deletes the last assistant message and restarts a stream on the same history.
 */
export async function regenerateLastMessage(subjectKey, opts) {
  const { onDelta, onComplete, onError } = opts;
  const chat = await loadChat(subjectKey);
  if (!chat || chat.messages.length === 0) {
    onError && onError('No conversation to regenerate');
    return;
  }
  if (chat.messages[chat.messages.length - 1].role !== 'assistant') {
    onError && onError('The last message is not from the assistant');
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
