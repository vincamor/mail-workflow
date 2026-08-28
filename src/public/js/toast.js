/**
 * Notification module — replaces native alert() calls
 * Stacked toasts (success, warning, error, info) + guide modal
 * 100% CSS variables — works with every theme
 */

// ── Container (created once) ─────────────────────────────────
let container = null;

function getContainer() {
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

// ── Inline SVG icons (no dependency) ───────────────────────────
const ICONS = {
  success: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`,
  error: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  warning: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  info: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
};

// ── Toast (stacked notification) ────────────────────────────────────

/**
 * Shows a toast in the bottom right.
 * @param {string} message  — text to display
 * @param {'success'|'error'|'warning'|'info'} type
 * @param {number} duration — ms before auto-dismiss (0 = no auto-dismiss)
 */
export function showToast(message, type = 'info', duration = 4000) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  el.innerHTML = `
    <span class="toast-icon">${ICONS[type] || ICONS.info}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
    <button class="toast-close" aria-label="Close">&times;</button>
  `;

  // Dismiss on click
  el.querySelector('.toast-close').onclick = () => dismissToast(el);

  getContainer().appendChild(el);

  // Auto-dismiss
  if (duration > 0) {
    setTimeout(() => dismissToast(el), duration);
  }

  return el;
}

function dismissToast(el) {
  if (!el || !el.parentNode) return;
  el.classList.add('toast-exit');
  el.addEventListener('animationend', () => el.remove(), { once: true });
}

// ── Semantic shortcuts ──────────────────────────────────────────

export function toastSuccess(message, duration = 3500) {
  return showToast(message, 'success', duration);
}

export function toastError(message, duration = 6000) {
  return showToast(message, 'error', duration);
}

export function toastWarning(message, duration = 5000) {
  return showToast(message, 'warning', duration);
}

export function toastInfo(message, duration = 4000) {
  return showToast(message, 'info', duration);
}

// ── Guide Modal (replaces the onboarding alert) ──────────────────────

/**
 * Shows a "guide" modal with title, HTML body, and OK button.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body       — HTML allowed
 * @param {string} opts.icon       — emoji or HTML for the header icon
 * @param {'info'|'warning'|'error'|'success'} opts.type
 * @param {string} opts.buttonText — button text (default "OK")
 * @returns {Promise<void>}        — resolves when the user closes it
 */
export function showGuideModal({ title, body, icon = '', type = 'info', buttonText = 'OK' } = {}) {
  return new Promise((resolve) => {
    // Overlay
    const overlay = document.createElement('div');
    overlay.className = 'guide-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    // Content
    overlay.innerHTML = `
      <div class="guide-modal guide-modal-${type}">
        <div class="guide-modal-accent"></div>
        ${icon ? `<div class="guide-modal-icon">${icon}</div>` : ''}
        <h2 class="guide-modal-title">${escapeHtml(title)}</h2>
        <div class="guide-modal-body">${body}</div>
        <button class="guide-modal-btn guide-modal-btn-${type}">${escapeHtml(buttonText)}</button>
      </div>
    `;

    const close = () => {
      overlay.classList.add('guide-modal-exit');
      overlay.addEventListener(
        'animationend',
        () => {
          overlay.remove();
          resolve();
        },
        { once: true }
      );
    };

    // Close on button
    overlay.querySelector('.guide-modal-btn').onclick = close;

    // Close on overlay click (outside the modal)
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });

    // Close on Escape
    const onKey = (e) => {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        close();
      }
    };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);

    // Focus the button
    overlay.querySelector('.guide-modal-btn').focus();
  });
}

// ── Confirm Modal (replaces confirm()) ──────────────────────────────

/**
 * Shows a confirmation modal with Confirm / Cancel buttons.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.message     — plain text (escaped) or HTML if html=true
 * @param {boolean} opts.html       — if true, message is injected as-is
 * @param {'info'|'warning'|'error'} opts.type
 * @param {string} opts.confirmText — confirm button text (default "Confirm")
 * @param {string} opts.cancelText  — cancel button text (default "Cancel")
 * @returns {Promise<boolean>}      — true if confirmed, false otherwise
 */
export function showConfirmModal({
  title = 'Confirmation',
  message = '',
  html = false,
  type = 'info',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'guide-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const bodyContent = html ? message : `<p>${escapeHtml(message)}</p>`;

    overlay.innerHTML = `
      <div class="guide-modal guide-modal-${type}">
        <div class="guide-modal-accent"></div>
        <h2 class="guide-modal-title">${escapeHtml(title)}</h2>
        <div class="guide-modal-body">${bodyContent}</div>
        <div class="confirm-modal-actions">
          <button class="confirm-modal-cancel">${escapeHtml(cancelText)}</button>
          <button class="guide-modal-btn guide-modal-btn-${type} confirm-modal-ok">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;

    let resolved = false;
    const close = (result) => {
      if (resolved) return;
      resolved = true;
      overlay.classList.add('guide-modal-exit');
      overlay.addEventListener(
        'animationend',
        () => {
          overlay.remove();
          resolve(result);
        },
        { once: true }
      );
    };

    overlay.querySelector('.confirm-modal-ok').onclick = () => close(true);
    overlay.querySelector('.confirm-modal-cancel').onclick = () => close(false);

    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(false);
    });

    const onKey = (e) => {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        close(false);
      }
    };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    overlay.querySelector('.confirm-modal-ok').focus();
  });
}

// ── Utility ──────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
