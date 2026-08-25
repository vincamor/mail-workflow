/**
 * Module pour afficher les détails d'un email dans une fenêtre modale
 */
import { showReplyForm } from './reply.js';
import { getEmailById } from './analysis.js';
import { loadBodyHtmlForEmail } from './emails.js';

// Données de l'email actuellement affiché — lues par les handlers des boutons Répondre
let currentEmailData = null;

// Element ayant le focus avant l'ouverture de la modal (pour le restaurer a la fermeture)
let lastFocusedElement = null;
// Handler keydown actif tant que la modal est ouverte (Escape + focus trap)
let modalKeyHandler = null;

// Créer et afficher la modal avec le contenu de l'email
export function showEmailDetail(emailData) {
  // Créer la modal si elle n'existe pas
  let modal = document.getElementById('emailDetailModal');
  if (!modal) {
    modal = createEmailDetailModal();
    document.body.appendChild(modal);
  }

  // Mémoriser le focus courant pour le restaurer à la fermeture (a11y)
  lastFocusedElement = document.activeElement;

  // Afficher la modal
  modal.style.display = 'flex';

  // Escape + piège à focus tant que la modal est ouverte
  modalKeyHandler = (e) => handleModalKeydown(e, modal);
  document.addEventListener('keydown', modalKeyHandler);

  // Récupérer l'email complet depuis la Map (déjà chargé lors de l'affichage de l'arbre)
  const fullEmail = getEmailById ? getEmailById(emailData.id) : null;

  if (fullEmail) {
    // Utiliser l'email complet de la Map
    populateEmailDetail(modal, fullEmail);
  } else {
    // Fallback sur les données du noeud (ne devrait pas arriver)
    populateEmailDetail(modal, emailData);
  }

  // Focus initial sur le bouton de fermeture (a11y — l'utilisateur clavier entre dans la modal)
  const closeBtn = modal.querySelector('#closeEmailDetail');
  if (closeBtn) closeBtn.focus();
}

/**
 * Ferme la modal détail : masque, retire le handler clavier, restaure le focus.
 */
function closeEmailDetailModal(modal) {
  modal.style.display = 'none';
  if (modalKeyHandler) {
    document.removeEventListener('keydown', modalKeyHandler);
    modalKeyHandler = null;
  }
  if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
    try { lastFocusedElement.focus(); } catch (_) { /* element retiré du DOM */ }
  }
  lastFocusedElement = null;
}

/**
 * Gère Escape (fermeture) et Tab (piège à focus) pour la modal détail email.
 */
function handleModalKeydown(e, modal) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeEmailDetailModal(modal);
    return;
  }
  if (e.key !== 'Tab') return;

  // Piège à focus : garder le focus à l'intérieur de la modal.
  const focusables = Array.from(modal.querySelectorAll(
    'button, [href], input, select, textarea, iframe, [tabindex]:not([tabindex="-1"])'
  )).filter(el => el.offsetParent !== null || el === document.activeElement);
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

// Créer la structure HTML de la modal
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
        <h2 id="emailDetailTitle" style="margin: 0; font-size: 20px; font-weight: 600; color: var(--text-primary);">Détails de l'email</h2>
        <button id="closeEmailDetail" aria-label="Fermer" style="
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
        <!-- De -->
        <div style="margin-bottom: 16px;">
          <div style="font-weight: 600; color: var(--text-tertiary); margin-bottom: 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">De</div>
          <div id="emailFrom" style="color: var(--text-primary); font-size: 15px;"></div>
        </div>

        <!-- À -->
        <div style="margin-bottom: 16px;">
          <div style="font-weight: 600; color: var(--text-tertiary); margin-bottom: 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">À</div>
          <div id="emailTo" style="color: var(--text-primary); font-size: 15px;"></div>
        </div>

        <!-- CC -->
        <div id="emailCcRow" style="display: none; margin-bottom: 16px;">
          <div style="font-weight: 600; color: var(--text-tertiary); margin-bottom: 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">CC</div>
          <div id="emailCc" style="color: var(--text-secondary); font-size: 14px;"></div>
        </div>

        <!-- Sujet -->
        <div style="margin-bottom: 16px;">
          <div style="font-weight: 600; color: var(--text-tertiary); margin-bottom: 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Sujet</div>
          <div id="emailSubject" style="color: var(--text-primary); font-size: 16px; font-weight: 600;"></div>
        </div>

        <!-- Date -->
        <div style="margin-bottom: 24px;">
          <div style="font-weight: 600; color: var(--text-tertiary); margin-bottom: 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Date</div>
          <div id="emailDate" style="color: var(--text-secondary); font-size: 14px;"></div>
        </div>

        <!-- Contenu -->
        <div style="margin-top: 24px; padding-top: 24px; border-top: 1px solid var(--border-light);">
          <div style="font-weight: 600; color: var(--text-tertiary); margin-bottom: 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Contenu</div>
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

        <!-- Boutons de réponse -->
        <div id="replyActionsBar" style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-light); display: flex; gap: 8px;">
          <button id="replyBtn" class="btn-reply-action" style="padding: 8px 16px; border: 1px solid var(--primary-ring); background: transparent; color: var(--primary); border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s;">↩ Répondre</button>
          <button id="replyAllBtn" class="btn-reply-action" style="padding: 8px 16px; border: 1px solid var(--primary-ring); background: transparent; color: var(--primary); border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s;">↩↩ Répondre à tous</button>
        </div>
      </div>
    </div>
  `;
  
  // Ajouter l'événement de fermeture
  const closeBtn = modal.querySelector('#closeEmailDetail');
  closeBtn.addEventListener('click', () => {
    closeEmailDetailModal(modal);
  });

  // Fermer en cliquant sur le fond
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeEmailDetailModal(modal);
    }
  });
  
  // Améliorer le style du bouton close au survol
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

  // Boutons de réponse — lisent currentEmailData au moment du clic
  modal.querySelector('#replyBtn').addEventListener('click', () => {
    if (currentEmailData) showReplyForm(currentEmailData, 'reply');
  });
  modal.querySelector('#replyAllBtn').addEventListener('click', () => {
    if (currentEmailData) showReplyForm(currentEmailData, 'replyAll');
  });

  return modal;
}

// Remplir le contenu de la modal avec les données de l'email
function populateEmailDetail(modal, emailData) {
  // Mémoriser l'email courant pour les boutons Répondre
  currentEmailData = emailData;

  // Masquer le formulaire de réponse s'il était ouvert depuis un email précédent
  const replySection = modal.querySelector('#replyFormSection');
  if (replySection) replySection.style.display = 'none';

  // Extraire les informations
  const from = emailData.from || 'Expéditeur inconnu';
  const to = emailData.to || 'Destinataire inconnu';
  const cc = emailData.cc || '';
  const subject = emailData.subject || 'Sans sujet';
  const date = formatDate(emailData.date);
  const bodyTextContent = cleanEmailBody(emailData.bodyText || emailData.snippet || 'Aucun contenu disponible');

  // Remplir les champs
  modal.querySelector('#emailFrom').textContent = from;
  modal.querySelector('#emailTo').textContent = to;
  modal.querySelector('#emailSubject').textContent = subject;
  modal.querySelector('#emailDate').textContent = date;
  const bodyEl = modal.querySelector('#emailBody');
  bodyEl.textContent = bodyTextContent;

  // Try to load rich HTML content in background
  loadRichBody(bodyEl, emailData.id);

  // CC : afficher la ligne uniquement si non vide
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
 * Charge le bodyHtml et l'affiche dans un iframe sandboxé.
 * Fallback silencieux sur le bodyText déjà affiché.
 */
async function loadRichBody(bodyEl, emailId) {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const provider = urlParams.get('provider') || 'gmail';
    const userId = urlParams.get('email');
    if (!userId) return;

    const rawHtml = await loadBodyHtmlForEmail(provider, userId, emailId);
    if (!rawHtml) return;

    // Strip les scripts et handlers inline pour eviter les warnings de sandbox
    // et prevenir tout XSS si un mail contient du JS malicieux (sandbox bloque
    // mais Chrome log des warnings — autant nettoyer en amont).
    const bodyHtml = rawHtml
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
      .replace(/javascript:/gi, '');

    // Replace text content with sandboxed iframe for rich HTML
    const iframe = document.createElement('iframe');
    // ┌──────────────────────────────────────────────────────────────────────┐
    // │ SÉCURITÉ CRITIQUE — NE JAMAIS AJOUTER 'allow-scripts' À CE SANDBOX.    │
    // │ Le contenu affiché est du HTML d'emails ARBITRAIRES et potentiellement │
    // │ malveillants. Le sandbox SANS 'allow-scripts' est la protection XSS    │
    // │ principale : il neutralise tout JavaScript embarqué (inline, <script>, │
    // │ handlers on*, javascript: URIs), même ce que le nettoyage regex        │
    // │ ci-dessus pourrait rater. Le regex de sanitization est une défense     │
    // │ EN PROFONDEUR, PAS une protection suffisante à elle seule.             │
    // │ Ajouter 'allow-scripts' (surtout combiné à 'allow-same-origin')        │
    // │ rouvrirait une faille XSS complète. À NE PAS FAIRE.                    │
    // └──────────────────────────────────────────────────────────────────────┘
    iframe.sandbox = 'allow-same-origin';
    iframe.style.cssText = 'width:100%;border:none;min-height:200px;background:white;border-radius:6px;';
    bodyEl.textContent = '';
    bodyEl.appendChild(iframe);

    // Detecte si le mail contient des citations pour afficher/non le bouton toggle
    const hasQuote = /class=["'][^"']*gmail_quote|<blockquote/i.test(bodyHtml);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.6; color: #333; margin: 12px; word-wrap: break-word; }
      img { max-width: 100%; height: auto; }
      a { color: #2563eb; }
      /* Masque les citations par defaut, re-affiche via body.show-quotes */
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
      <button class="quote-toggle" type="button">▼ Afficher la citation</button>
    </body></html>`);
    doc.close();

    // Attache le handler depuis le parent (evite le CSP inline-script-attr)
    const toggleBtn = doc.querySelector('.quote-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const body = doc.body;
        body.classList.toggle('show-quotes');
        toggleBtn.textContent = body.classList.contains('show-quotes')
          ? '▲ Masquer la citation'
          : '▼ Afficher la citation';
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
    console.warn('⚠️ Chargement HTML échoué:', e.message);
  }
}

// Formater la date de manière lisible
function formatDate(dateString) {
  if (!dateString) return 'Date inconnue';
  
  try {
    const date = new Date(dateString);
    const options = {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    };
    return date.toLocaleDateString('fr-FR', options);
  } catch (e) {
    return dateString;
  }
}

// Nettoyer le corps de l'email (enlever HTML, entités, etc.)
function cleanEmailBody(body) {
  if (!body) return 'Aucun contenu';
  
  // Enlever les balises HTML
  let cleaned = body.replace(/<[^>]*>/g, '');
  
  // Décoder les entités HTML communes
  cleaned = cleaned
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  
  // Enlever les espaces multiples
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  // Extraire uniquement la partie originale (sans l'historique)
  cleaned = extractOriginalMessage(cleaned);
  
  return cleaned;
}

/**
 * Extrait uniquement le message original sans l'historique des échanges
 * @param {string} text - Texte complet de l'email
 * @returns {string} - Message original uniquement
 */
function extractOriginalMessage(text) {
  if (!text) return text;
  
  const originalText = text;
  
  // Patterns de détection des citations/historiques
  const quotePatterns = [
    // Gmail anglais: "On Mon, Aug 25, 2025 at 12:30 PM, name@email.com wrote:"
    /On\s+\w+,?\s+\w+\.?\s+\d{1,2},?\s+\d{4}\s+at\s+\d{1,2}:\d{2}\s*(AM|PM)?,?\s+.*?wrote:/i,
    
    // Gmail français: "Le lun. 25 août 2025 à 12:30, name@email.com a écrit :"
    /Le\s+\w+\.?\s+\d{1,2}\s+\w+\.?\s+\d{4}\s+à\s+\d{1,2}:\d{2}.*?a écrit\s*:/i,
    
    // Pattern simple date + wrote: "On Mon 25 Aug 2025 at 00:38, ... wrote:"
    /On\s+\w+\s+\d{1,2}\s+\w+\s+\d{4}\s+at\s+\d{1,2}:\d{2}.*?wrote:/i,
    
    // Pattern sans virgule: "On Mon 25 Aug 2025 at 00:38"
    /On\s+\w+\s+\d{1,2}\s+\w+\s+\d{4}\s+at\s+\d{1,2}:\d{2}/i,
    
    // Pattern court: "On Sat, 22 Mar 2025 at 18:26"
    /On\s+\w+,\s+\d{1,2}\s+\w+\s+\d{4}\s+at\s+\d{1,2}:\d{2}/i,
    
    // Outlook: "From: ... Sent: ... To: ..."
    /From:\s*.+?Sent:\s*.+?To:/is,
    
    // Original Message delimiter
    /[-_]{3,}\s*Original Message\s*[-_]{3,}/i,
    
    // Email standard: "--- On ... wrote:"
    /---+\s*On\s+.*?wrote:/i,
    
    // Format avec date ISO: "2025-08-25 12:30"
    /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}.*?wrote:/i
  ];
  
  let earliestIndex = text.length;
  let foundPattern = false;
  
  // Chercher le premier pattern de citation
  for (const pattern of quotePatterns) {
    const match = text.match(pattern);
    if (match && match.index < earliestIndex) {
      earliestIndex = match.index;
      foundPattern = true;
    }
  }
  
  // Si on a trouvé un pattern, couper le texte avant celui-ci
  if (foundPattern && earliestIndex > 0) {
    text = text.substring(0, earliestIndex).trim();
  } else if (foundPattern && earliestIndex === 0) {
    // Le mail commence directement par une citation (pas de contenu original)
    return '[Message vide - Contenu non textuel (image ou pièce jointe uniquement)]';
  }
  
  // Nettoyer les lignes commençant par ">" (citations)
  const lines = text.split('\n');
  const cleanedLines = [];
  let foundQuoteLine = false;
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    // Détecter les lignes de citation (commencent par > ou >>)
    if (trimmedLine.startsWith('>')) {
      foundQuoteLine = true;
      break; // Tout ce qui suit est une citation
    }
    cleanedLines.push(line);
  }
  
  if (foundQuoteLine) {
    text = cleanedLines.join('\n').trim();
  }
  
  // Vérifier si le texte final est vide ou très court (< 5 caractères)
  if (!text || text.length < 5) {
    // Vérifier si le texte original contenait des citations
    if (originalText.includes('>') || foundPattern) {
      return '[Message vide - Contenu non textuel (image ou pièce jointe uniquement)]';
    }
  }
  
  return text || '[Aucun contenu textuel]';
}


