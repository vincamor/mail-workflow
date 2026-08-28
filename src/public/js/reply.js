/**
 * Email reply module.
 * Handles the compose form and sending from the detail modal.
 * Supports Gmail and Outlook — the endpoint URL is determined by the provider in the URL.
 */

/**
 * Displays (or updates) the reply form in the detail modal.
 * Creates the form's DOM if it does not exist yet, otherwise updates it.
 * @param {Object} emailData  - Full data of the email being replied to
 * @param {'reply'|'replyAll'} replyType
 * @param {Object} options    - Optional options (e.g. {prefilledBody: '...'})
 */
export function showReplyForm(emailData, replyType = 'reply', options = {}) {
  const userId = new URLSearchParams(window.location.search).get('email') || '';

  const to = buildReplyTo(emailData, userId);
  const cc = replyType === 'replyAll' ? buildReplyAllCc(emailData, userId) : '';
  const subject = /^re\s*:/i.test(emailData.subject || '')
    ? emailData.subject || ''
    : `Re: ${emailData.subject || ''}`;

  // Create the section if it does not exist yet in the DOM
  let section = document.getElementById('replyFormSection');
  if (!section) {
    section = createReplySection();
    const actionsBar = document.getElementById('replyActionsBar');
    if (actionsBar) {
      actionsBar.insertAdjacentElement('afterend', section);
    }
  }

  // Populate the fields
  section.querySelector('#replyTo').value = to;
  section.querySelector('#replyCc').value = cc;
  section.querySelector('#replySubject').value = subject;
  section.querySelector('#replyBody').value = options.prefilledBody || '';
  section.querySelector('#replySendFeedback').textContent = '';

  const sendBtn = section.querySelector('#replySendBtn');
  sendBtn.disabled = false;
  setSendButtonLabel(sendBtn, 'Send', 'icon-send');

  // Show
  section.style.display = 'block';

  // Scroll down so the form is visible
  const contentArea = section.closest('[style*="overflow-y"]');
  if (contentArea) contentArea.scrollTop = contentArea.scrollHeight;

  const replyBodyTextarea = section.querySelector('#replyBody');
  replyBodyTextarea.focus();
  if (options.prefilledBody) {
    replyBodyTextarea.setSelectionRange(
      replyBodyTextarea.value.length,
      replyBodyTextarea.value.length
    );
  }

  // Rebind the handlers on every open to capture the current emailData
  sendBtn.onclick = () => doSendReply(emailData, section);
  section.querySelector('#replyCancelBtn').onclick = () => {
    section.style.display = 'none';
  };
}

/**
 * Updates the send button's label with a themeable SVG icon + text.
 */
function setSendButtonLabel(btn, text, iconClass) {
  btn.innerHTML = `<span class="icon ${iconClass} icon-sm" aria-hidden="true" style="margin-right: 4px;"></span>${text}`;
}

// ---------------------------------------------------------------------------
// Form DOM
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
    <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Reply</div>

    <div style="margin-bottom: 8px;">
      <label style="display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 2px;">To</label>
      <input id="replyTo" type="text" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border: 1px solid var(--border-medium); border-radius: 6px; font-size: 14px; color: var(--text-primary); background: var(--bg-tertiary);" />
    </div>

    <div style="margin-bottom: 8px;">
      <label style="display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 2px;">CC</label>
      <input id="replyCc" type="text" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border: 1px solid var(--border-medium); border-radius: 6px; font-size: 14px; color: var(--text-primary); background: var(--bg-tertiary);" />
    </div>

    <div style="margin-bottom: 8px;">
      <label style="display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 2px;">Subject</label>
      <input id="replySubject" type="text" readonly
        style="width: 100%; box-sizing: border-box; padding: 6px 10px; border: 1px solid var(--border-medium); border-radius: 6px; font-size: 14px; color: var(--text-secondary); background: var(--bg-tertiary);" />
    </div>

    <div style="margin-bottom: 12px;">
      <label style="display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 2px;">Message</label>
      <textarea id="replyBody" rows="5" placeholder="Type your reply…"
        style="width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--border-medium); border-radius: 6px; font-size: 14px; color: var(--text-primary); background: var(--bg-tertiary); resize: vertical; font-family: inherit;"></textarea>
    </div>

    <div style="display: flex; gap: 8px; align-items: center;">
      <button id="replySendBtn" class="btn-reply-send"
        style="padding: 8px 20px; background: var(--aurora-gradient); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500;">
        <span class="icon icon-send icon-sm" aria-hidden="true" style="margin-right: 4px;"></span>Send
      </button>
      <button id="replyCancelBtn" class="btn-reply-cancel"
        style="padding: 8px 16px; background: var(--bg-secondary); color: var(--text-secondary); border: 1px solid var(--border-medium); border-radius: 6px; cursor: pointer; font-size: 14px;">
        Cancel
      </button>
      <span id="replySendFeedback" style="font-size: 13px;"></span>
    </div>
  `;
  return div;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function doSendReply(emailData, section) {
  const to = section.querySelector('#replyTo').value.trim();
  const cc = section.querySelector('#replyCc').value.trim();
  const subject = section.querySelector('#replySubject').value.trim();
  const body = section.querySelector('#replyBody').value.trim();
  const feedback = section.querySelector('#replySendFeedback');
  const sendBtn = section.querySelector('#replySendBtn');

  if (!body) {
    feedback.textContent = 'The message cannot be empty.';
    feedback.style.color = 'var(--error)';
    return;
  }

  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';
  feedback.textContent = '';

  // Determine the endpoint based on the active provider (read from the URL ?provider=)
  const provider = new URLSearchParams(window.location.search).get('provider') || 'gmail';
  const replyEndpoint = `/${provider}/reply`;
  console.log(`📤 Sending reply via ${replyEndpoint}`);

  try {
    const response = await fetch(replyEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        cc: cc || undefined,
        subject,
        body,
        id: emailData.id, // Internal Outlook ID (AAMkADAwATM0...) — ignored by Gmail
        threadId: emailData.threadId,
        messageId: emailData.messageId,
        references: emailData.references || '',
      }),
    });

    const data = await response.json();

    if (response.ok && data.success) {
      feedback.textContent = 'Reply sent.';
      feedback.style.color = 'var(--success)';
      setSendButtonLabel(sendBtn, 'Sent', 'icon-check');
      setTimeout(() => {
        section.style.display = 'none';
      }, 1800);
    } else {
      feedback.textContent = data.error || 'Error while sending.';
      feedback.style.color = 'var(--error)';
      sendBtn.disabled = false;
      setSendButtonLabel(sendBtn, 'Send', 'icon-send');
    }
  } catch {
    feedback.textContent = 'Network error. Please try again.';
    feedback.style.color = 'var(--error)';
    sendBtn.disabled = false;
    setSendButtonLabel(sendBtn, 'Send', 'icon-send');
  }
}

// ---------------------------------------------------------------------------
// Recipient helpers
// ---------------------------------------------------------------------------

/**
 * Determines the reply's To field:
 * - If this is an email we sent ourselves → reply to the original recipient
 * - Otherwise → reply to the sender
 */
function buildReplyTo(emailData, userId) {
  const fromAddr = extractEmailAddress(emailData.from || '');
  if (fromAddr.toLowerCase() === userId.toLowerCase()) {
    return emailData.to || '';
  }
  return emailData.from || '';
}

/**
 * Builds the CC field for "Reply all":
 * combines the original To + CC and removes our own address.
 */
function buildReplyAllCc(emailData, userId) {
  const all = [
    ...(emailData.to ? emailData.to.split(',') : []),
    ...(emailData.cc ? emailData.cc.split(',') : []),
  ];
  return all
    .map((r) => r.trim())
    .filter((r) => r && extractEmailAddress(r).toLowerCase() !== userId.toLowerCase())
    .join(', ');
}

/** Extracts the email address from "First Last <email@domain.com>" or "email@domain.com" */
function extractEmailAddress(str) {
  const match = str.match(/<([^>]+)>/);
  return match ? match[1].trim() : str.trim();
}
