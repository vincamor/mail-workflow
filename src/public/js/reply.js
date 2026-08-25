/**
 * Module de réponse aux emails.
 * Gère le formulaire de composition et l'envoi depuis la modal de détail.
 * Supporte Gmail et Outlook — l'URL de l'endpoint est déterminée par le provider dans l'URL.
 */

/**
 * Affiche (ou met à jour) le formulaire de réponse dans la modal de détail.
 * Crée le DOM du formulaire s'il n'existe pas encore, le met à jour sinon.
 * @param {Object} emailData  - Données complètes de l'email auquel on répond
 * @param {'reply'|'replyAll'} replyType
 * @param {Object} options    - Options optionnelles (ex: {prefilledBody: '...'})
 */
export function showReplyForm(emailData, replyType = 'reply', options = {}) {
  const userId = new URLSearchParams(window.location.search).get('email') || '';

  const to      = buildReplyTo(emailData, userId);
  const cc      = replyType === 'replyAll' ? buildReplyAllCc(emailData, userId) : '';
  const subject = /^re\s*:/i.test(emailData.subject || '')
    ? (emailData.subject || '')
    : `Re: ${emailData.subject || ''}`;

  // Créer la section si elle n'existe pas encore dans le DOM
  let section = document.getElementById('replyFormSection');
  if (!section) {
    section = createReplySection();
    const actionsBar = document.getElementById('replyActionsBar');
    if (actionsBar) {
      actionsBar.insertAdjacentElement('afterend', section);
    }
  }

  // Peupler les champs
  section.querySelector('#replyTo').value      = to;
  section.querySelector('#replyCc').value      = cc;
  section.querySelector('#replySubject').value = subject;
  section.querySelector('#replyBody').value    = options.prefilledBody || '';
  section.querySelector('#replySendFeedback').textContent = '';

  const sendBtn = section.querySelector('#replySendBtn');
  sendBtn.disabled    = false;
  setSendButtonLabel(sendBtn, 'Envoyer', 'icon-send');

  // Afficher
  section.style.display = 'block';

  // Scroll vers le bas pour que le formulaire soit visible
  const contentArea = section.closest('[style*="overflow-y"]');
  if (contentArea) contentArea.scrollTop = contentArea.scrollHeight;

  const replyBodyTextarea = section.querySelector('#replyBody');
  replyBodyTextarea.focus();
  if (options.prefilledBody) {
    replyBodyTextarea.setSelectionRange(replyBodyTextarea.value.length, replyBodyTextarea.value.length);
  }

  // Rebind des handlers à chaque ouverture pour capturer l'emailData courant
  sendBtn.onclick = () => doSendReply(emailData, section);
  section.querySelector('#replyCancelBtn').onclick = () => {
    section.style.display = 'none';
  };
}

/**
 * Met à jour le libellé du bouton d'envoi avec une icône SVG thémable + texte.
 */
function setSendButtonLabel(btn, text, iconClass) {
  btn.innerHTML = `<span class="icon ${iconClass} icon-sm" aria-hidden="true" style="margin-right: 4px;"></span>${text}`;
}

// ---------------------------------------------------------------------------
// DOM du formulaire
// ---------------------------------------------------------------------------

function createReplySection() {
  const div = document.createElement('div');
  div.id = 'replyFormSection';
  div.style.cssText = `
    margin-top: 16px;
    padding: 16px;
    background: var(--bg-secondary);
    border-radius: 8px;
    border: 1px solid var(--border-medium);
  `;
  div.innerHTML = `
    <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Répondre</div>

    <div style="margin-bottom: 8px;">
      <label style="display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 2px;">À</label>
      <input id="replyTo" type="text" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border: 1px solid var(--border-medium); border-radius: 6px; font-size: 14px; color: var(--text-primary); background: var(--bg-tertiary);" />
    </div>

    <div style="margin-bottom: 8px;">
      <label style="display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 2px;">CC</label>
      <input id="replyCc" type="text" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border: 1px solid var(--border-medium); border-radius: 6px; font-size: 14px; color: var(--text-primary); background: var(--bg-tertiary);" />
    </div>

    <div style="margin-bottom: 8px;">
      <label style="display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 2px;">Objet</label>
      <input id="replySubject" type="text" readonly
        style="width: 100%; box-sizing: border-box; padding: 6px 10px; border: 1px solid var(--border-medium); border-radius: 6px; font-size: 14px; color: var(--text-secondary); background: var(--bg-tertiary);" />
    </div>

    <div style="margin-bottom: 12px;">
      <label style="display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 2px;">Message</label>
      <textarea id="replyBody" rows="5" placeholder="Tapez votre réponse…"
        style="width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--border-medium); border-radius: 6px; font-size: 14px; color: var(--text-primary); background: var(--bg-tertiary); resize: vertical; font-family: inherit;"></textarea>
    </div>

    <div style="display: flex; gap: 8px; align-items: center;">
      <button id="replySendBtn" class="btn-reply-send"
        style="padding: 8px 20px; background: var(--aurora-gradient); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500;">
        <span class="icon icon-send icon-sm" aria-hidden="true" style="margin-right: 4px;"></span>Envoyer
      </button>
      <button id="replyCancelBtn" class="btn-reply-cancel"
        style="padding: 8px 16px; background: var(--bg-secondary); color: var(--text-secondary); border: 1px solid var(--border-medium); border-radius: 6px; cursor: pointer; font-size: 14px;">
        Annuler
      </button>
      <span id="replySendFeedback" style="font-size: 13px;"></span>
    </div>
  `;
  return div;
}

// ---------------------------------------------------------------------------
// Envoi
// ---------------------------------------------------------------------------

async function doSendReply(emailData, section) {
  const to       = section.querySelector('#replyTo').value.trim();
  const cc       = section.querySelector('#replyCc').value.trim();
  const subject  = section.querySelector('#replySubject').value.trim();
  const body     = section.querySelector('#replyBody').value.trim();
  const feedback = section.querySelector('#replySendFeedback');
  const sendBtn  = section.querySelector('#replySendBtn');

  if (!body) {
    feedback.textContent = 'Le message ne peut pas être vide.';
    feedback.style.color = 'var(--error)';
    return;
  }

  sendBtn.disabled    = true;
  sendBtn.textContent = 'Envoi…';
  feedback.textContent = '';

  // Déterminer l'endpoint selon le provider actif (lu depuis l'URL ?provider=)
  const provider = new URLSearchParams(window.location.search).get('provider') || 'gmail';
  const replyEndpoint = `/${provider}/reply`;
  console.log(`📤 Envoi réponse via ${replyEndpoint}`);

  try {
    const response = await fetch(replyEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        cc: cc || undefined,
        subject,
        body,
        id:         emailData.id,          // ID interne Outlook (AAMkADAwATM0...) — ignoré par Gmail
        threadId:   emailData.threadId,
        messageId:  emailData.messageId,
        references: emailData.references || '',
      }),
    });

    const data = await response.json();

    if (response.ok && data.success) {
      feedback.textContent = 'Réponse envoyée.';
      feedback.style.color = 'var(--success)';
      setSendButtonLabel(sendBtn, 'Envoyé', 'icon-check');
      setTimeout(() => { section.style.display = 'none'; }, 1800);
    } else {
      feedback.textContent = data.error || "Erreur lors de l'envoi.";
      feedback.style.color = 'var(--error)';
      sendBtn.disabled     = false;
      setSendButtonLabel(sendBtn, 'Envoyer', 'icon-send');
    }
  } catch {
    feedback.textContent = 'Erreur réseau. Veuillez réessayer.';
    feedback.style.color = 'var(--error)';
    sendBtn.disabled     = false;
    setSendButtonLabel(sendBtn, 'Envoyer', 'icon-send');
  }
}

// ---------------------------------------------------------------------------
// Helpers destinataires
// ---------------------------------------------------------------------------

/**
 * Détermine le To de la réponse :
 * - Si c'est un email qu'on a soi-même envoyé → on répond au destinataire original
 * - Sinon → on répond à l'expéditeur
 */
function buildReplyTo(emailData, userId) {
  const fromAddr = extractEmailAddress(emailData.from || '');
  if (fromAddr.toLowerCase() === userId.toLowerCase()) {
    return emailData.to || '';
  }
  return emailData.from || '';
}

/**
 * Construit le CC pour "Répondre à tous" :
 * réunit To + CC de l'original et retire notre propre adresse.
 */
function buildReplyAllCc(emailData, userId) {
  const all = [
    ...(emailData.to ? emailData.to.split(',') : []),
    ...(emailData.cc ? emailData.cc.split(',') : []),
  ];
  return all
    .map(r => r.trim())
    .filter(r => r && extractEmailAddress(r).toLowerCase() !== userId.toLowerCase())
    .join(', ');
}

/** Extrait l'adresse email depuis "Prénom Nom <email@domain.com>" ou "email@domain.com" */
function extractEmailAddress(str) {
  const match = str.match(/<([^>]+)>/);
  return match ? match[1].trim() : str.trim();
}
