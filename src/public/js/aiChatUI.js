/**
 * UI du chat IA en split vertical du panneau droit.
 * - Drawers en haut (scroll vertical)
 * - Diviseur draggable (resize vertical)
 * - Chat en bas (pliable via bouton fermer)
 * - Auto-switch de sujet : changer de sujet dans la sidebar = bascule chat
 */

import { sendMessage, regenerateLastMessage, resetConversation } from './aiChat.js';
import { loadChat } from './aiChatStore.js';
import { showConfirmModal, toastError } from './toast.js';

let currentSubjectKey = null;
let currentSubjectInfo = null;
let getEmailsForSubjectFn = null;
let isSending = false;
let useDraftCallback = null;
let isOpen = false;

const DEFAULT_HEIGHT_PX = 400;
const MIN_HEIGHT_PX = 200;
const STORAGE_KEY = 'mailproject-chat-panel-height';

/**
 * Initialise le module et enregistre le getter d'emails + callback brouillon.
 */
export function initChatUI({ getEmailsForSubject, onUseDraft }) {
  getEmailsForSubjectFn = getEmailsForSubject;
  useDraftCallback = onUseDraft;
  injectPanelIfMissing();
  wireStaticHandlers();
  wireDivider();

  // Auto-switch : quand l'utilisateur change de sujet dans la sidebar,
  // basculer le chat sur le nouveau sujet si le chat est ouvert.
  import('./analysis.js').then(({ onSubjectSelected }) => {
    onSubjectSelected(async (subjectKey, subjectInfo) => {
      if (!isOpen) return;
      if (!subjectKey) return;
      if (subjectKey === currentSubjectKey) return;
      await loadSubject(subjectKey, subjectInfo);
    });
  });
}

function injectPanelIfMissing() {
  const rightPanel = document.querySelector('.right-panel');
  if (!rightPanel) return;

  // Le panneau droit devient une colonne flex bornee :
  // le scroll vertical est delegue au wrapper drawers, pas au panel entier.
  // Le padding-bottom compense le footer fixe (app-footer) qui overlay le bas.
  rightPanel.style.display = 'flex';
  rightPanel.style.flexDirection = 'column';
  rightPanel.style.minHeight = '0';
  rightPanel.style.overflow = 'hidden';
  rightPanel.style.boxSizing = 'border-box';
  rightPanel.style.paddingBottom = '36px';

  // Wrapper des drawers existants (cree une fois, englobe tous les enfants actuels)
  let drawersWrapper = document.getElementById('rightPanelDrawers');
  if (!drawersWrapper) {
    drawersWrapper = document.createElement('div');
    drawersWrapper.id = 'rightPanelDrawers';
    drawersWrapper.className = 'right-panel-drawers';
    while (rightPanel.firstChild) {
      drawersWrapper.appendChild(rightPanel.firstChild);
    }
    rightPanel.appendChild(drawersWrapper);
  }

  if (document.getElementById('aiChatPanel')) return;

  // Diviseur draggable
  const divider = document.createElement('div');
  divider.id = 'aiChatDivider';
  divider.title = 'Glisser pour redimensionner';
  rightPanel.appendChild(divider);

  // Panneau chat
  const panel = document.createElement('div');
  panel.id = 'aiChatPanel';
  panel.innerHTML = `
    <div class="ai-chat-header">
      <h3 id="aiChatTitle"><span class="icon icon-chat icon-inline" aria-hidden="true"></span>Chat</h3>
      <button id="aiChatExit" title="Fermer le chat" aria-label="Fermer le chat"><span class="icon icon-close icon-sm" aria-hidden="true"></span></button>
    </div>
    <div id="aiChatMessages" class="ai-chat-messages"></div>
    <div class="ai-chat-stats" id="aiChatStats">0 messages • 0 tokens</div>
    <div class="ai-chat-input">
      <button id="aiChatNewConv" title="Nouvelle conversation" aria-label="Nouvelle conversation"><span class="icon icon-refresh icon-sm" aria-hidden="true"></span></button>
      <textarea id="aiChatInput" placeholder="Pose une question ou demande une redaction..."></textarea>
      <button id="aiChatSend"><span class="icon icon-send icon-sm" aria-hidden="true"></span>Envoyer</button>
    </div>
  `;
  rightPanel.appendChild(panel);

  // Hauteur restauree depuis localStorage
  const saved = parseInt(localStorage.getItem(STORAGE_KEY) || '', 10);
  const initial = Number.isFinite(saved) && saved >= MIN_HEIGHT_PX ? saved : DEFAULT_HEIGHT_PX;
  panel.style.height = `${initial}px`;
}

function wireStaticHandlers() {
  const exitBtn = document.getElementById('aiChatExit');
  const sendBtn = document.getElementById('aiChatSend');
  const newConvBtn = document.getElementById('aiChatNewConv');
  const input = document.getElementById('aiChatInput');

  if (exitBtn) exitBtn.addEventListener('click', closeChatPanel);
  if (sendBtn) sendBtn.addEventListener('click', handleSend);
  if (newConvBtn) newConvBtn.addEventListener('click', handleNewConv);
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });
  }
}

function wireDivider() {
  const divider = document.getElementById('aiChatDivider');
  const panel = document.getElementById('aiChatPanel');
  const rightPanel = document.querySelector('.right-panel');
  if (!divider || !panel || !rightPanel) return;

  let dragging = false;

  divider.addEventListener('mousedown', (e) => {
    dragging = true;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = rightPanel.getBoundingClientRect();
    // hauteur du panel chat = distance entre la souris et le bas du right panel
    const newHeight = Math.round(rect.bottom - e.clientY);
    const maxHeight = Math.max(MIN_HEIGHT_PX, Math.floor(rect.height * 0.8));
    const clamped = Math.max(MIN_HEIGHT_PX, Math.min(maxHeight, newHeight));
    panel.style.height = `${clamped}px`;
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const h = parseInt(panel.style.height, 10);
    if (Number.isFinite(h)) localStorage.setItem(STORAGE_KEY, String(h));
  });
}

/**
 * Ouvre le panneau chat (split vertical) et charge le sujet.
 * Remplace l'ancien enterChatMode.
 */
export async function openChatPanel(subjectKey, subjectInfo) {
  if (!subjectKey) return;
  isOpen = true;
  const panel = document.getElementById('aiChatPanel');
  const divider = document.getElementById('aiChatDivider');
  if (panel) panel.classList.add('active');
  if (divider) divider.classList.add('active');
  await loadSubject(subjectKey, subjectInfo);
}

/**
 * Ferme le panneau chat — les drawers reprennent toute la hauteur.
 */
export function closeChatPanel() {
  isOpen = false;
  const panel = document.getElementById('aiChatPanel');
  const divider = document.getElementById('aiChatDivider');
  if (panel) panel.classList.remove('active');
  if (divider) divider.classList.remove('active');
  currentSubjectKey = null;
  currentSubjectInfo = null;
}

// Alias pour compat avec aiPanel.js existant
export const enterChatMode = openChatPanel;
export const exitChatMode = closeChatPanel;

async function loadSubject(subjectKey, subjectInfo) {
  currentSubjectKey = subjectKey;
  currentSubjectInfo = subjectInfo;

  const title = document.getElementById('aiChatTitle');
  if (title) {
    title.innerHTML = '';
    const icon = document.createElement('span');
    icon.className = 'icon icon-chat icon-inline';
    icon.setAttribute('aria-hidden', 'true');
    title.appendChild(icon);
    title.appendChild(document.createTextNode(`Chat — "${subjectKey}"`));
  }

  const chat = await loadChat(subjectKey);
  renderMessages(chat ? chat.messages : []);
  renderStats(chat);
}

function renderMessages(messages) {
  const container = document.getElementById('aiChatMessages');
  if (!container) return;
  container.innerHTML = '';

  messages.forEach((msg, idx) => {
    const bubble = document.createElement('div');
    bubble.className = 'ai-chat-message';
    if (msg.isContextMessage) {
      bubble.classList.add('ai-chat-message-context');
      const mailCount = msg.content.split('## Mail ').length - 1;
      const icon = document.createElement('span');
      icon.className = 'icon icon-attachment icon-inline';
      icon.setAttribute('aria-hidden', 'true');
      bubble.appendChild(icon);
      bubble.appendChild(
        document.createTextNode(`Contexte du thread injecte (${mailCount} mails)`)
      );
    } else if (msg.role === 'user') {
      bubble.classList.add('ai-chat-message-user');
      bubble.textContent = msg.content;
    } else {
      bubble.classList.add('ai-chat-message-assistant');
      bubble.textContent = msg.content;

      const isLast = idx === messages.length - 1;
      const actions = document.createElement('div');
      actions.className = 'ai-chat-message-actions';
      const draftBtn = document.createElement('button');
      draftBtn.innerHTML =
        '<span class="icon icon-edit icon-sm" aria-hidden="true"></span>Utiliser comme brouillon';
      draftBtn.addEventListener('click', () => {
        if (useDraftCallback) useDraftCallback(msg.content);
      });
      actions.appendChild(draftBtn);
      if (isLast) {
        const regenBtn = document.createElement('button');
        regenBtn.innerHTML =
          '<span class="icon icon-refresh icon-sm" aria-hidden="true"></span>Regenerer';
        regenBtn.addEventListener('click', handleRegenerate);
        actions.appendChild(regenBtn);
      }
      bubble.appendChild(actions);
    }
    container.appendChild(bubble);
  });
  container.scrollTop = container.scrollHeight;
}

function renderStats(chat) {
  const el = document.getElementById('aiChatStats');
  if (!el) return;
  if (!chat) {
    el.textContent = '0 messages • 0 tokens';
    return;
  }
  const tokensInK = (chat.tokensIn / 1000).toFixed(1);
  const tokensOutK = (chat.tokensOut / 1000).toFixed(1);
  el.textContent = `${chat.msgCount} messages • ~${tokensInK}k in / ${tokensOutK}k out`;
}

async function handleSend() {
  if (isSending || !currentSubjectKey) return;
  const input = document.getElementById('aiChatInput');
  const text = input.value.trim();
  if (!text) return;

  isSending = true;
  setInputsDisabled(true);
  input.value = '';

  appendBubble({ role: 'user', content: text });
  const assistantBubble = appendBubble({ role: 'assistant', content: '', streaming: true });

  await sendMessage(currentSubjectKey, text, {
    subjectInfo: currentSubjectInfo,
    getEmailsForSubject: getEmailsForSubjectFn,
    onDelta: (partial) => {
      assistantBubble.textNode.textContent = partial;
      scrollToBottom();
    },
    onComplete: (chat) => {
      assistantBubble.bubble.classList.remove('ai-chat-streaming-cursor');
      renderMessages(chat.messages);
      renderStats(chat);
      isSending = false;
      setInputsDisabled(false);
    },
    onError: (err) => {
      assistantBubble.bubble.classList.remove('ai-chat-streaming-cursor');
      assistantBubble.textNode.textContent = `Erreur : ${err}`;
      toastError(`Chat IA : ${err}`);
      isSending = false;
      setInputsDisabled(false);
    },
  });
}

async function handleRegenerate() {
  if (isSending || !currentSubjectKey) return;
  isSending = true;
  setInputsDisabled(true);

  const chat = await loadChat(currentSubjectKey);
  if (!chat) {
    isSending = false;
    setInputsDisabled(false);
    return;
  }

  const messagesCopy = chat.messages.slice(0, -1);
  renderMessages(messagesCopy);
  const assistantBubble = appendBubble({ role: 'assistant', content: '', streaming: true });

  await regenerateLastMessage(currentSubjectKey, {
    onDelta: (partial) => {
      assistantBubble.textNode.textContent = partial;
      scrollToBottom();
    },
    onComplete: (updatedChat) => {
      assistantBubble.bubble.classList.remove('ai-chat-streaming-cursor');
      renderMessages(updatedChat.messages);
      renderStats(updatedChat);
      isSending = false;
      setInputsDisabled(false);
    },
    onError: (err) => {
      assistantBubble.bubble.classList.remove('ai-chat-streaming-cursor');
      toastError(`Regeneration : ${err}`);
      isSending = false;
      setInputsDisabled(false);
    },
  });
}

async function handleNewConv() {
  if (isSending || !currentSubjectKey) return;
  const ok = await showConfirmModal({
    title: 'Nouvelle conversation',
    message: "Effacer l'historique du chat pour ce sujet ?",
    type: 'warning',
    confirmText: 'Effacer',
  });
  if (!ok) return;
  await resetConversation(currentSubjectKey);
  renderMessages([]);
  renderStats(null);
}

function appendBubble({ role, content, streaming = false }) {
  const container = document.getElementById('aiChatMessages');
  const bubble = document.createElement('div');
  bubble.className = `ai-chat-message ai-chat-message-${role}`;
  if (streaming) bubble.classList.add('ai-chat-streaming-cursor');
  const textNode = document.createTextNode(content);
  bubble.appendChild(textNode);
  container.appendChild(bubble);
  scrollToBottom();
  return { bubble, textNode };
}

function scrollToBottom() {
  const container = document.getElementById('aiChatMessages');
  if (container) container.scrollTop = container.scrollHeight;
}

function setInputsDisabled(disabled) {
  const input = document.getElementById('aiChatInput');
  const send = document.getElementById('aiChatSend');
  const newConv = document.getElementById('aiChatNewConv');
  if (input) input.disabled = disabled;
  if (send) send.disabled = disabled;
  if (newConv) newConv.disabled = disabled;
}
