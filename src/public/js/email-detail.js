/**
 * Module for displaying an email's details in a modal window
 */
import { showReplyForm } from './reply.js';
import { getEmailById } from './analysis.js';
import { loadBodyHtmlForEmail } from './emails.js';

// Data of the email currently displayed — read by the Reply button handlers
let currentEmailData = null;

// Element that had focus before the modal opened (to restore it on close)
let lastFocusedElement = null;
// Keydown handler active while the modal is open (Escape + focus trap)
let modalKeyHandler = null;

// Create and display the modal with the email content
export function showEmailDetail(emailData) {
  // Create the modal if it does not exist yet
  let modal = document.getElementById('emailDetailModal');
  if (!modal) {
    modal = createEmailDetailModal();
    document.body.appendChild(modal);
  }

  // Remember the current focus to restore it on close (a11y)
  lastFocusedElement = document.activeElement;

  // Show the modal
  modal.style.display = 'flex';

  // Escape + focus trap while the modal is open
  modalKeyHandler = (e) => handleModalKeydown(e, modal);
  document.addEventListener('keydown', modalKeyHandler);

  // Retrieve the full email from the Map (already loaded when the tree was rendered)
  const fullEmail = getEmailById ? getEmailById(emailData.id) : null;

  if (fullEmail) {
    // Use the full email from the Map
    populateEmailDetail(modal, fullEmail);
  } else {
    // Fallback to the node data (should not happen)
    populateEmailDetail(modal, emailData);
  }

  // Initial focus on the close button (a11y — a keyboard user enters the modal)
  const closeBtn = modal.querySelector('#closeEmailDetail');
  if (closeBtn) closeBtn.focus();
}

/**
 * Closes the detail modal: hides it, removes the keyboard handler, restores focus.
 */
function closeEmailDetailModal(modal) {
  modal.style.display = 'none';
  if (modalKeyHandler) {
    document.removeEventListener('keydown', modalKeyHandler);
    modalKeyHandler = null;
  }
  if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
    try {
      lastFocusedElement.focus();
    } catch (_) {
      /* element removed from the DOM */
    }
  }
  lastFocusedElement = null;
}

/**
 * Handles Escape (close) and Tab (focus trap) for the email detail modal.
 */
function handleModalKeydown(e, modal) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeEmailDetailModal(modal);
    return;
  }
  if (e.key !== 'Tab') return;

  // Focus trap: keep focus inside the modal.
  const focusables = Array.from(
    modal.querySelectorAll(
      'button, [href], input, select, textarea, iframe, [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (focusables.length === 0) return;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// Build the modal's HTML structure
function createEmailDetailModal() {
  const modal = document.createElement('div');
  modal.id = 'emailDetailModal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'emailDetailTitle');
  modal.style.cssText = `
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: var(--bg-overlay);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    z-index: 10000;
    align-items: center;
    justify-content: center;
    padding: 20px;
    box-sizing: border-box;
  `;

  modal.innerHTML = `
    <div style="
      background: var(--bg-secondary);
      border-radius: 16px;
      max-width: 800px;
      max-height: 90vh;
      width: 100%;
      overflow: hidden;
      box-shadow: var(--shadow-2xl), var(--aurora-glow);
      display: flex;
      flex-direction: column;
      border: 1px solid var(--glass-border);
      position: relative;
    ">
      <!-- Aurora top accent -->
      <div style="position:absolute;top:0;left:0;right:0;height:2px;background:var(--aurora-gradient-h);background-size:200% 100%;z-index:1;"></div>

      <!-- Header -->
      <div style="
        padding: 20px 24px;
        border-bottom: 1px solid var(--border-light);
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: linear-gradient(135deg, var(--primary-light) 0%, var(--secondary-light) 100%);
        color: var(--text-primary);
      ">
        <h2 id="emailDetailTitle" style="margin: 0; font-size: 20px; font-weight: 600; color: var(--text-primary);">Email details</h2>
        <button id="closeEmailDetail" aria-label="Close" style="
          background: var(--border-subtle);
          border: 1px solid var(--border-subtle);
          color: var(--text-secondary);
          font-size: 24px;
          cursor: pointer;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s;
        ">×</button>
      </div>

      <!-- Content -->
      <div style="
        padding: 24px;
        overflow-y: auto;
        flex: 1;
      ">
        <!-- From -->
        <div style="margin-bottom: 16px;">
          <div style="font-weight: 600; color: var(--text-tertiary); margin-bottom: 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">From</div>
          <div id="emailFrom" style="color: var(--text-primary); font-size: 15px;"></div>
        </div>

        <!-- To -->
        <div style="margin-bottom: 16px;">
          <div style="font-weight: 600; color: var(--text-tertiary); margin-bottom: 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">To</div>
          <div id="emailTo" style="color: var(--text-primary); font-size: 15px;"></div>
        </div>

        <!-- CC -->
        <div id="emailCcRow" style="display: none; margin-bottom: 16px;">
          <div style="font-weight: 600; color: var(--text-tertiary); margin-bottom: 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">CC</div>
          <div id="emailCc" style="color: var(--text-secondary); font-size: 14px;"></div>
        </div>

        <!-- Subject -->
        <div style="margin-bottom: 16px;">
          <div style="font-weight: 600; color: var(--text-tertiary); margin-bottom: 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Subject</div>
          <div id="emailSubject" style="color: var(--text-primary); font-size: 16px; font-weight: 600;"></div>
        </div>

        <!-- Date -->
        <div style="margin-bottom: 24px;">
          <div style="font-weight: 600; color: var(--text-tertiary); margin-bottom: 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Date</div>
          <div id="emailDate" style="color: var(--text-secondary); font-size: 14px;"></div>
        </div>

        <!-- Content -->
        <div style="margin-top: 24px; padding-top: 24px; border-top: 1px solid var(--border-light);">
          <div style="font-weight: 600; color: var(--text-tertiary); margin-bottom: 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Content</div>
          <div id="emailBody" style="
            color: var(--text-primary);
            font-size: 14px;
            line-height: 1.6;
            background: var(--bg-tertiary);
            padding: 16px;
            border-radius: 8px;
            border-left: 4px solid var(--primary);
            white-space: pre-wrap;
            word-wrap: break-word;
          "></div>
        </div>

        <!-- Reply buttons -->
        <div id="replyActionsBar" style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-light); display: flex; gap: 8px;">
          <button id="replyBtn" class="btn-reply-action" style="padding: 8px 16px; border: 1px solid var(--primary-ring); background: transparent; color: var(--primary); border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s;">↩ Reply</button>
          <button id="replyAllBtn" class="btn-reply-action" style="padding: 8px 16px; border: 1px solid var(--primary-ring); background: transparent; color: var(--primary); border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s;">↩↩ Reply all</button>
        </div>
      </div>
    </div>
  `;

  // Add the close event
  const closeBtn = modal.querySelector('#closeEmailDetail');
  closeBtn.addEventListener('click', () => {
    closeEmailDetailModal(modal);
  });

  // Close by clicking the backdrop
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeEmailDetailModal(modal);
    }
  });

  // Improve the close button's style on hover
  closeBtn.addEventListener('mouseenter', () => {
    closeBtn.style.background = 'var(--primary-light)';
    closeBtn.style.color = 'var(--primary)';
    closeBtn.style.borderColor = 'var(--primary-ring)';
  });
  closeBtn.addEventListener('mouseleave', () => {
    closeBtn.style.background = 'var(--border-subtle)';
    closeBtn.style.color = '';
    closeBtn.style.borderColor = 'var(--border-subtle)';
  });

  // Reply buttons — read currentEmailData at click time
  modal.querySelector('#replyBtn').addEventListener('click', () => {
    if (currentEmailData) showReplyForm(currentEmailData, 'reply');
  });
  modal.querySelector('#replyAllBtn').addEventListener('click', () => {
    if (currentEmailData) showReplyForm(currentEmailData, 'replyAll');
  });

  return modal;
}

// Fill the modal's content with the email data
function populateEmailDetail(modal, emailData) {
  // Remember the current email for the Reply buttons
  currentEmailData = emailData;

  // Hide the reply form if it was left open from a previous email
  const replySection = modal.querySelector('#replyFormSection');
  if (replySection) replySection.style.display = 'none';

  // Extract the information
  const from = emailData.from || 'Unknown sender';
  const to = emailData.to || 'Unknown recipient';
  const cc = emailData.cc || '';
  const subject = emailData.subject || 'No subject';
  const date = formatDate(emailData.date);
  const bodyTextContent = cleanEmailBody(
    emailData.bodyText || emailData.snippet || 'No content available'
  );

  // Fill the fields
  modal.querySelector('#emailFrom').textContent = from;
  modal.querySelector('#emailTo').textContent = to;
  modal.querySelector('#emailSubject').textContent = subject;
  modal.querySelector('#emailDate').textContent = date;
  const bodyEl = modal.querySelector('#emailBody');
  bodyEl.textContent = bodyTextContent;

  // Try to load rich HTML content in background
  loadRichBody(bodyEl, emailData.id);

  // CC: only show the row when it is not empty
  const ccRow = modal.querySelector('#emailCcRow');
  const ccEl = modal.querySelector('#emailCc');
  if (cc && cc.trim()) {
    ccEl.textContent = cc;
    ccRow.style.display = 'block';
  } else {
    ccRow.style.display = 'none';
  }
}

/**
 * Loads the bodyHtml and displays it in a sandboxed iframe.
 * Falls back silently to the bodyText already displayed.
 */
async function loadRichBody(bodyEl, emailId) {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const provider = urlParams.get('provider') || 'gmail';
    const userId = urlParams.get('email');
    if (!userId) return;

    const rawHtml = await loadBodyHtmlForEmail(provider, userId, emailId);
    if (!rawHtml) return;

    // Strip scripts and inline handlers to avoid sandbox warnings and to
    // prevent any XSS if an email contains malicious JS (the sandbox blocks
    // it, but Chrome still logs warnings — better to clean it up upfront).
    const bodyHtml = rawHtml
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
      .replace(/javascript:/gi, '');

    // Replace text content with sandboxed iframe for rich HTML
    const iframe = document.createElement('iframe');
    // ┌───────────────────────────────────────────────────────────────────────┐
    // │ SECURITY CRITICAL — NEVER ADD 'allow-scripts' TO THIS SANDBOX.        │
    // │ The content displayed here is HTML from ARBITRARY, potentially        │
    // │ malicious emails. The sandbox WITHOUT 'allow-scripts' is the          │
    // │ primary XSS protection: it neutralises all embedded JavaScript        │
    // │ (inline, <script>, on* handlers, javascript: URIs), even what the     │
    // │ regex cleanup above might miss. The sanitization regex is defence     │
    // │ IN DEPTH, NOT sufficient protection on its own.                       │
    // │ Adding 'allow-scripts' (especially combined with 'allow-same-origin') │
    // │ would reopen a full XSS hole. DO NOT DO THIS.                         │
    // └───────────────────────────────────────────────────────────────────────┘
    iframe.sandbox = 'allow-same-origin';
    iframe.style.cssText =
      'width:100%;border:none;min-height:200px;background:white;border-radius:6px;';
    bodyEl.textContent = '';
    bodyEl.appendChild(iframe);

    // Detect whether the email contains quoted text to show/hide the toggle button
    const hasQuote = /class=["'][^"']*gmail_quote|<blockquote/i.test(bodyHtml);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.6; color: #333; margin: 12px; word-wrap: break-word; }
      img { max-width: 100%; height: auto; }
      a { color: #2563eb; }
      /* Hides quoted text by default, shown again via body.show-quotes */
      blockquote, .gmail_quote, div.gmail_quote {
        display: none;
      }
      body.show-quotes blockquote,
      body.show-quotes .gmail_quote,
      body.show-quotes div.gmail_quote {
        display: block;
        border-left: 3px solid #ddd;
        margin: 8px 0;
        padding-left: 12px;
        color: #666;
      }
      .quote-toggle {
        display: ${hasQuote ? 'inline-block' : 'none'};
        margin-top: 12px;
        padding: 5px 12px;
        background: #f3f4f6;
        border: 1px solid #d1d5db;
        border-radius: 4px;
        color: #4b5563;
        font-size: 12px;
        font-family: inherit;
        cursor: pointer;
      }
      .quote-toggle:hover {
        background: #e5e7eb;
      }
    </style></head><body>${bodyHtml}
      <button class="quote-toggle" type="button">▼ Show quoted text</button>
    </body></html>`);
    doc.close();

    // Attach the handler from the parent (avoids the CSP inline-script-attr issue)
    const toggleBtn = doc.querySelector('.quote-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const body = doc.body;
        body.classList.toggle('show-quotes');
        toggleBtn.textContent = body.classList.contains('show-quotes')
          ? '▲ Hide quoted text'
          : '▼ Show quoted text';
        setTimeout(() => {
          const contentHeight = doc.documentElement.scrollHeight;
          iframe.style.height = Math.min(contentHeight + 20, 600) + 'px';
        }, 0);
      });
    }

    // Auto-resize iframe to content height
    const resizeIframe = () => {
      const contentHeight = doc.documentElement.scrollHeight;
      iframe.style.height = Math.min(contentHeight + 20, 600) + 'px';
    };
    iframe.onload = resizeIframe;
    setTimeout(resizeIframe, 100);
    setTimeout(resizeIframe, 500);
  } catch (e) {
    console.warn('⚠️ HTML loading failed:', e.message);
  }
}

// Format the date in a readable way
function formatDate(dateString) {
  if (!dateString) return 'Unknown date';

  try {
    const date = new Date(dateString);
    const options = {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    };
    return date.toLocaleDateString('en-GB', options);
  } catch (e) {
    return dateString;
  }
}

// Clean up the email body (strip HTML, entities, etc.)
function cleanEmailBody(body) {
  if (!body) return 'No content';

  // Remove HTML tags
  let cleaned = body.replace(/<[^>]*>/g, '');

  // Decode common HTML entities
  cleaned = cleaned
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");

  // Collapse multiple whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Extract only the original part (without the history)
  cleaned = extractOriginalMessage(cleaned);

  return cleaned;
}

/**
 * Extracts only the original message, without the exchange history
 * @param {string} text - Full text of the email
 * @returns {string} - Original message only
 */
function extractOriginalMessage(text) {
  if (!text) return text;

  const originalText = text;

  // Patterns for detecting quoted text/history
  const quotePatterns = [
    // Gmail English: "On Mon, Aug 25, 2025 at 12:30 PM, name@email.com wrote:"
    /On\s+\w+,?\s+\w+\.?\s+\d{1,2},?\s+\d{4}\s+at\s+\d{1,2}:\d{2}\s*(AM|PM)?,?\s+.*?wrote:/i,

    // Gmail French: "Le lun. 25 août 2025 à 12:30, name@email.com a écrit :"
    /Le\s+\w+\.?\s+\d{1,2}\s+\w+\.?\s+\d{4}\s+à\s+\d{1,2}:\d{2}.*?a écrit\s*:/i,

    // Simple date + wrote pattern: "On Mon 25 Aug 2025 at 00:38, ... wrote:"
    /On\s+\w+\s+\d{1,2}\s+\w+\s+\d{4}\s+at\s+\d{1,2}:\d{2}.*?wrote:/i,

    // Pattern without comma: "On Mon 25 Aug 2025 at 00:38"
    /On\s+\w+\s+\d{1,2}\s+\w+\s+\d{4}\s+at\s+\d{1,2}:\d{2}/i,

    // Short pattern: "On Sat, 22 Mar 2025 at 18:26"
    /On\s+\w+,\s+\d{1,2}\s+\w+\s+\d{4}\s+at\s+\d{1,2}:\d{2}/i,

    // Outlook: "From: ... Sent: ... To: ..."
    /From:\s*.+?Sent:\s*.+?To:/is,

    // Original Message delimiter
    /[-_]{3,}\s*Original Message\s*[-_]{3,}/i,

    // Standard email: "--- On ... wrote:"
    /---+\s*On\s+.*?wrote:/i,

    // ISO date format: "2025-08-25 12:30"
    /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}.*?wrote:/i,
  ];

  let earliestIndex = text.length;
  let foundPattern = false;

  // Look for the first quote pattern
  for (const pattern of quotePatterns) {
    const match = text.match(pattern);
    if (match && match.index < earliestIndex) {
      earliestIndex = match.index;
      foundPattern = true;
    }
  }

  // If a pattern was found, cut the text before it
  if (foundPattern && earliestIndex > 0) {
    text = text.substring(0, earliestIndex).trim();
  } else if (foundPattern && earliestIndex === 0) {
    // The email starts directly with quoted text (no original content)
    return '[Empty message - Non-text content (image or attachment only)]';
  }

  // Clean up lines starting with ">" (quoted text)
  const lines = text.split('\n');
  const cleanedLines = [];
  let foundQuoteLine = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    // Detect quoted lines (starting with > or >>)
    if (trimmedLine.startsWith('>')) {
      foundQuoteLine = true;
      break; // Everything after this is quoted text
    }
    cleanedLines.push(line);
  }

  if (foundQuoteLine) {
    text = cleanedLines.join('\n').trim();
  }

  // Check whether the final text is empty or very short (< 5 characters)
  if (!text || text.length < 5) {
    // Check whether the original text contained quoted text
    if (originalText.includes('>') || foundPattern) {
      return '[Empty message - Non-text content (image or attachment only)]';
    }
  }

  return text || '[No text content]';
}
