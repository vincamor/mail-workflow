/**
 * Module de notifications — remplace les alert() natifs
 * Toasts empilés (success, warning, error, info) + modale guide
 * 100 % CSS variables — compatible avec tous les thèmes
 */

// ── Container (créé une seule fois) ─────────────────────────────────
let container = null;

function getContainer() {
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

// ── Icônes SVG inline (pas de dépendance) ───────────────────────────
const ICONS = {
  success: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`,
  error: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  warning: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  info: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
};

// ── Toast (notification empilée) ────────────────────────────────────

/**
 * Affiche un toast en bas à droite.
 * @param {string} message  — texte à afficher
 * @param {'success'|'error'|'warning'|'info'} type
 * @param {number} duration — ms avant auto-dismiss (0 = pas d'auto)
 */
export function showToast(message, type = 'info', duration = 4000) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  el.innerHTML = `
    <span class="toast-icon">${ICONS[type] || ICONS.info}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
    <button class="toast-close" aria-label="Fermer">&times;</button>
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

// ── Raccourcis sémantiques ──────────────────────────────────────────

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

// ── Guide Modal (remplace l'alert onboarding) ──────────────────────

/**
 * Affiche une modale "guide" avec titre, corps HTML, et bouton OK.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body       — HTML autorisé
 * @param {string} opts.icon       — emoji ou HTML pour l'icône du header
 * @param {'info'|'warning'|'error'|'success'} opts.type
 * @param {string} opts.buttonText — texte du bouton (défaut "OK")
 * @returns {Promise<void>}        — se résout quand l'utilisateur ferme
 */
export function showGuideModal({ title, body, icon = '', type = 'info', buttonText = 'OK' } = {}) {
  return new Promise((resolve) => {
    // Overlay
    const overlay = document.createElement('div');
    overlay.className = 'guide-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    // Contenu
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

    // Fermer sur bouton
    overlay.querySelector('.guide-modal-btn').onclick = close;

    // Fermer sur clic overlay (hors modale)
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });

    // Fermer sur Escape
    const onKey = (e) => {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        close();
      }
    };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);

    // Focus le bouton
    overlay.querySelector('.guide-modal-btn').focus();
  });
}

// ── Confirm Modal (remplace confirm()) ──────────────────────────────

/**
 * Affiche une modale de confirmation avec boutons Confirmer / Annuler.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.message     — texte simple (échappé) ou HTML si html=true
 * @param {boolean} opts.html       — si true, message est injecté tel quel
 * @param {'info'|'warning'|'error'} opts.type
 * @param {string} opts.confirmText — texte du bouton confirmer (défaut "Confirmer")
 * @param {string} opts.cancelText  — texte du bouton annuler (défaut "Annuler")
 * @returns {Promise<boolean>}      — true si confirmé, false sinon
 */
export function showConfirmModal({
  title = 'Confirmation',
  message = '',
  html = false,
  type = 'info',
  confirmText = 'Confirmer',
  cancelText = 'Annuler',
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

// ── Utilitaire ──────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
