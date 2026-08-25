/**
 * Module de gestion de l'interface des filtres
 */

import { loadFilters, saveFilters, resetFilters, getDefaultFilters } from './emailFilters.js';
import { toastSuccess, toastWarning, showConfirmModal } from './toast.js';

let currentFilters = null;
let onFiltersSavedCallback = null;
let onSubjectRestoredCallback = null;
let lastFocusedBeforeModal = null;

/**
 * Initialise l'interface des filtres
 */
export async function initFilterUI() {
  currentFilters = await loadFilters();
  createFilterModal();
  
  // Ajouter le bouton dans la section dossier
  addFilterButton();
}

/**
 * Ajoute le bouton "Filtres de téléchargement" dans la section dossier
 */
function addFilterButton() {
  // Vérifier si le bouton existe déjà
  if (document.getElementById('filterButton')) return;
  
  // Trouver le container du dossier
  const folderContent = document.querySelector('#folderDrawer .folder-content');
  
  if (!folderContent) {
    console.warn('Section dossier non trouvée');
    return;
  }
  
  const filterButton = document.createElement('button');
  filterButton.id = 'filterButton';
  filterButton.className = 'filter-button';
  filterButton.innerHTML = '<span class="btn-icon icon icon-settings" aria-hidden="true"></span><span class="btn-text">Filtres de téléchargement</span>';
  filterButton.onclick = showFilterModal;
  
  // Insérer après step2Guide
  const step2Guide = document.getElementById('step2Guide');
  if (step2Guide) {
    step2Guide.insertAdjacentElement('afterend', filterButton);
  } else {
    // Fallback : ajouter à la fin
    folderContent.appendChild(filterButton);
  }
}

/**
 * Crée la modal de configuration des filtres
 */
function createFilterModal() {
  // Vérifier si la modal existe déjà
  if (document.getElementById('filterModal')) return;
  
  const modal = document.createElement('div');
  modal.id = 'filterModal';
  modal.className = 'filter-modal';
  modal.style.display = 'none';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'filterModalTitle');

  modal.innerHTML = `
    <div class="filter-modal-content">
      <!-- Header -->
      <div class="filter-modal-header">
        <h2 id="filterModalTitle"><span class="icon icon-settings icon-inline" aria-hidden="true"></span>Filtres de téléchargement</h2>
        <button id="closeFilterModal" class="filter-modal-close" aria-label="Fermer la fenêtre des filtres">×</button>
      </div>

      <!-- Body -->
      <div class="filter-modal-body">
        <p class="filter-description">
          Configurez les filtres pour exclure certains emails lors du téléchargement.
          Les filtres optimisés sont appliqués directement dans Gmail API pour ne jamais télécharger les emails indésirables.
        </p>

        <!-- Filtres AVANT téléchargement (Optimisés) -->
        <div class="filter-section filter-optimized">
          <h3><span class="icon icon-bolt icon-inline" aria-hidden="true"></span>Filtres optimisés (appliqués AVANT téléchargement)</h3>
          <p class="filter-hint" style="color: var(--success); font-weight: 500;">
            <span class="icon icon-check-circle icon-inline" aria-hidden="true"></span>Ces emails ne seront jamais téléchargés de Gmail = Téléchargement 30%+ plus rapide + Économie de quota API
          </p>

          <label class="filter-checkbox filter-optimized-item">
            <input type="checkbox" id="filterNotifications" checked>
            <span>
              <strong>Exclure les notifications automatiques (noreply, no-reply)</strong>
            </span>
            <small style="display: block; margin-top: 4px;">
              <strong>Expéditeurs bloqués :</strong> noreply, no-reply, notification, automated, do-not-reply, donotreply<br>
              <em style="color: var(--success);"><span class="icon icon-check icon-inline" aria-hidden="true"></span>Recommandé : Ces emails ne nécessitent généralement pas de réponse</em>
            </small>
          </label>

          <label class="filter-checkbox filter-optimized-item">
            <input type="checkbox" id="filterPromotional" checked>
            <span>
              <strong>Exclure les emails promotionnels et newsletters</strong>
            </span>
            <small style="display: block; margin-top: 4px;">
              <strong>Mots-clés dans le sujet :</strong> unsubscribe, promo, promotional, offer, sale, discount<br>
              <em style="color: var(--success);"><span class="icon icon-check icon-inline" aria-hidden="true"></span>Recommandé : Réduit significativement le volume d'emails</em>
            </small>
          </label>

          <label class="filter-checkbox filter-optimized-item">
            <input type="checkbox" id="filterAutoExcludeRepetitive" checked>
            <span>
              <strong>Détection automatique des expéditeurs répétitifs</strong>
            </span>
            <small style="display: block; margin-top: 4px;">
              Après 5 emails d'un même expéditeur avec des sujets similaires, les suivants sont filtrés automatiquement.
              Les expéditeurs détectés sont ajoutés à la liste noire pour les prochains téléchargements.<br>
              <em style="color: var(--success);"><span class="icon icon-check icon-inline" aria-hidden="true"></span>Recommandé : Élimine les listes de diffusion et emails automatisés</em>
            </small>
          </label>

          <div style="background: var(--bg-tertiary); padding: 12px; border-radius: 8px; margin-top: 12px; border-left: 4px solid var(--warning);">
            <small style="color: var(--text-secondary); font-weight: 500;">
              <span class="icon icon-lightbulb icon-inline" aria-hidden="true"></span><strong>Info :</strong> Vous pouvez aussi ajouter des expéditeurs spécifiques dans la "Liste noire" ci-dessous
            </small>
          </div>
        </div>

        <!-- Filtre par date -->
        <div class="filter-section">
          <h3><span class="icon icon-calendar icon-inline" aria-hidden="true"></span>Période de téléchargement</h3>
          <p class="filter-hint">Limiter le téléchargement aux emails reçus après une date donnée</p>

          <label class="filter-checkbox">
            <input type="checkbox" id="filterUseCustomAfterDate">
            <span>Télécharger uniquement les emails après une date</span>
          </label>

          <div class="filter-input-group" id="customAfterDateGroup" style="display: none; margin-left: 28px;">
            <label>Ne télécharger que les emails reçus après :</label>
            <input type="date" id="filterCustomAfterDate" style="width: 180px; padding: var(--space-1-5) var(--space-3); border: 1px solid var(--border-light); border-radius: var(--radius-md); font-size: var(--text-sm); background: var(--bg-secondary); color: var(--text-primary);">
          </div>
        </div>

        <!-- Filtres APRÈS téléchargement -->
        <div class="filter-section">
          <h3><span class="icon icon-wrench icon-inline" aria-hidden="true"></span>Filtres standards (appliqués après téléchargement)</h3>
          <p class="filter-hint" style="color: var(--warning);">
            <span class="icon icon-alert-triangle icon-inline" aria-hidden="true"></span>Ces emails seront téléchargés puis filtrés côté serveur
          </p>
          
          <label class="filter-checkbox">
            <input type="checkbox" id="filterNoSubject">
            <span>Exclure les emails sans sujet</span>
            <small>Non supporté par Gmail API - Filtré après téléchargement</small>
          </label>
          
          <label class="filter-checkbox">
            <input type="checkbox" id="filterShortConversations">
            <span>Exclure les conversations courtes</span>
          </label>
          
          <div class="filter-input-group" id="minConversationLengthGroup" style="display: none; margin-left: 28px;">
            <label>Minimum d'emails par conversation :</label>
            <input type="number" id="minConversationLength" min="2" max="10" value="3">
          </div>
        </div>
        
        <!-- Liste noire d'expéditeurs -->
        <div class="filter-section">
          <h3><span class="icon icon-ban icon-inline" aria-hidden="true"></span>Liste noire d'expéditeurs</h3>
          <p class="filter-hint">Ajoutez les adresses email à bloquer</p>
          
          <div class="filter-list" id="blacklistedSendersList"></div>
          
          <div class="filter-add-group">
            <input type="email" id="newBlacklistedSender" placeholder="exemple@email.com">
            <button id="addBlacklistedSender" class="filter-add-btn">+ Ajouter</button>
          </div>
        </div>
        
        <!-- Mots-clés interdits -->
        <div class="filter-section">
          <h3><span class="icon icon-search icon-inline" aria-hidden="true"></span>Mots-clés à exclure (dans le sujet)</h3>
          <p class="filter-hint">Ajoutez les mots-clés à bloquer</p>
          
          <div class="filter-list" id="blacklistedKeywordsList"></div>
          
          <div class="filter-add-group">
            <input type="text" id="newBlacklistedKeyword" placeholder="Mot-clé">
            <button id="addBlacklistedKeyword" class="filter-add-btn">+ Ajouter</button>
          </div>
        </div>
        
        <!-- Sujets exclus -->
        <div class="filter-section">
          <h3><span class="icon icon-ban icon-inline" aria-hidden="true"></span>Sujets exclus</h3>
          <p class="filter-hint">Sujets masqu\u00e9s de la liste (ajout\u00e9s via clic droit \u2192 Exclure)</p>

          <div class="filter-list" id="blacklistedSubjectsList"></div>
        </div>

        <!-- Statistiques -->
        <div class="filter-section filter-stats" id="filterStats" style="display: none;">
          <h3><span class="icon icon-chart icon-inline" aria-hidden="true"></span>Statistiques</h3>
          <div id="filterStatsContent"></div>
        </div>
      </div>
      
      <!-- Footer -->
      <div class="filter-modal-footer">
        <button id="resetFilters" class="filter-btn filter-btn-secondary"><span class="icon icon-refresh icon-inline" aria-hidden="true"></span>Réinitialiser</button>
        <button id="saveFilters" class="filter-btn filter-btn-primary"><span class="icon icon-save icon-inline" aria-hidden="true"></span>Enregistrer</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Événements
  setupFilterModalEvents();
}

/**
 * Configure les événements de la modal
 */
function setupFilterModalEvents() {
  // Fermeture
  document.getElementById('closeFilterModal').onclick = hideFilterModal;
  document.getElementById('filterModal').onclick = (e) => {
    if (e.target.id === 'filterModal') hideFilterModal();
  };
  
  // Checkbox date personnalisée
  document.getElementById('filterUseCustomAfterDate').onchange = (e) => {
    const group = document.getElementById('customAfterDateGroup');
    group.style.display = e.target.checked ? 'block' : 'none';
  };

  // Checkbox conversations courtes
  document.getElementById('filterShortConversations').onchange = (e) => {
    const group = document.getElementById('minConversationLengthGroup');
    group.style.display = e.target.checked ? 'block' : 'none';
  };
  
  // Ajout expéditeur
  document.getElementById('addBlacklistedSender').onclick = addBlacklistedSender;
  document.getElementById('newBlacklistedSender').onkeypress = (e) => {
    if (e.key === 'Enter') addBlacklistedSender();
  };
  
  // Ajout mot-clé
  document.getElementById('addBlacklistedKeyword').onclick = addBlacklistedKeyword;
  document.getElementById('newBlacklistedKeyword').onkeypress = (e) => {
    if (e.key === 'Enter') addBlacklistedKeyword();
  };
  
  // Boutons
  document.getElementById('resetFilters').onclick = async () => {
    const ok = await showConfirmModal({
      title: 'R\u00e9initialiser les filtres',
      message: 'Voulez-vous vraiment r\u00e9initialiser tous les filtres\u00a0?',
      type: 'warning',
      confirmText: 'R\u00e9initialiser',
    });
    if (ok) {
      currentFilters = await resetFilters();
      populateFilterModal();
      toastSuccess('Filtres r\u00e9initialis\u00e9s');
    }
  };

  document.getElementById('saveFilters').onclick = saveCurrentFilters;

  // Escape + focus trap (le clavier ne doit jamais quitter la modale tant qu'elle est ouverte)
  document.getElementById('filterModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      hideFilterModal();
      return;
    }
    if (e.key === 'Tab') trapFocus(e);
  });
}

/**
 * Emp\u00eache Tab/Shift+Tab de faire sortir le focus de la modale ouverte.
 */
function trapFocus(e) {
  const modal = document.getElementById('filterModal');
  const focusable = modal.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Affiche la modal des filtres
 */
export function showFilterModal() {
  lastFocusedBeforeModal = document.activeElement;
  populateFilterModal();
  const modal = document.getElementById('filterModal');
  modal.style.display = 'flex';
  // Focus le premier \u00e9l\u00e9ment interactif (le bouton de fermeture) pour amorcer le trap
  const closeBtn = document.getElementById('closeFilterModal');
  if (closeBtn) closeBtn.focus();
}

/**
 * Masque la modal des filtres
 */
function hideFilterModal() {
  document.getElementById('filterModal').style.display = 'none';
  // Restaurer le focus sur l'\u00e9l\u00e9ment qui avait ouvert la modale
  if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === 'function') {
    lastFocusedBeforeModal.focus();
  }
  lastFocusedBeforeModal = null;
}

/**
 * Remplit la modal avec les filtres actuels
 */
function populateFilterModal() {
  // Checkboxes
  document.getElementById('filterNoSubject').checked = currentFilters.excludeNoSubject;
  document.getElementById('filterNotifications').checked = currentFilters.excludeNotifications;
  document.getElementById('filterPromotional').checked = currentFilters.excludePromotional;
  document.getElementById('filterAutoExcludeRepetitive').checked = currentFilters.autoExcludeRepetitive !== false;
  document.getElementById('filterShortConversations').checked = currentFilters.excludeShortConversations;
  document.getElementById('minConversationLength').value = currentFilters.minConversationLength;
  
  // Date personnalisée
  document.getElementById('filterUseCustomAfterDate').checked = currentFilters.useCustomAfterDate || false;
  document.getElementById('filterCustomAfterDate').value = currentFilters.customAfterDate || '';
  document.getElementById('customAfterDateGroup').style.display = currentFilters.useCustomAfterDate ? 'block' : 'none';

  // Afficher/masquer le champ conversations courtes
  const group = document.getElementById('minConversationLengthGroup');
  group.style.display = currentFilters.excludeShortConversations ? 'block' : 'none';
  
  // Liste noire expéditeurs
  renderBlacklistedSenders();
  
  // Liste mots-clés
  renderBlacklistedKeywords();

  // Liste sujets exclus
  renderBlacklistedSubjects();
}

/**
 * Affiche la liste des expéditeurs bloqués
 */
function renderBlacklistedSenders() {
  const list = document.getElementById('blacklistedSendersList');
  list.innerHTML = '';
  
  if (!currentFilters.blacklistedSenders || currentFilters.blacklistedSenders.length === 0) {
    list.innerHTML = '<p class="filter-empty">Aucun expéditeur bloqué</p>';
    return;
  }
  
  currentFilters.blacklistedSenders.forEach((sender, index) => {
    const item = document.createElement('div');
    item.className = 'filter-list-item';
    const span = document.createElement('span');
    span.textContent = sender;
    const btn = document.createElement('button');
    btn.className = 'filter-remove-btn';
    btn.textContent = '×';
    btn.addEventListener('click', () => removeBlacklistedSender(index));
    item.append(span, btn);
    list.appendChild(item);
  });
}

/**
 * Affiche la liste des mots-clés interdits
 */
function renderBlacklistedKeywords() {
  const list = document.getElementById('blacklistedKeywordsList');
  list.innerHTML = '';
  
  if (!currentFilters.blacklistedKeywords || currentFilters.blacklistedKeywords.length === 0) {
    list.innerHTML = '<p class="filter-empty">Aucun mot-clé bloqué</p>';
    return;
  }
  
  currentFilters.blacklistedKeywords.forEach((keyword, index) => {
    const item = document.createElement('div');
    item.className = 'filter-list-item';
    const span = document.createElement('span');
    span.textContent = keyword;
    const btn = document.createElement('button');
    btn.className = 'filter-remove-btn';
    btn.textContent = '×';
    btn.addEventListener('click', () => removeBlacklistedKeyword(index));
    item.append(span, btn);
    list.appendChild(item);
  });
}

/**
 * Affiche la liste des sujets exclus
 */
function renderBlacklistedSubjects() {
  const list = document.getElementById('blacklistedSubjectsList');
  if (!list) return;
  list.innerHTML = '';

  if (!currentFilters.blacklistedSubjects || currentFilters.blacklistedSubjects.length === 0) {
    list.innerHTML = '<p class="filter-empty">Aucun sujet exclu</p>';
    return;
  }

  currentFilters.blacklistedSubjects.forEach((subject, index) => {
    const item = document.createElement('div');
    item.className = 'filter-list-item';
    const span = document.createElement('span');
    span.textContent = subject;
    span.style.fontSize = '0.85rem';
    const btn = document.createElement('button');
    btn.className = 'filter-remove-btn';
    btn.textContent = '×';
    btn.title = 'Rétablir ce sujet';
    btn.addEventListener('click', () => removeBlacklistedSubject(index));
    item.append(span, btn);
    list.appendChild(item);
  });
}

/**
 * Supprime un sujet de la liste d'exclusion et déclenche le re-téléchargement.
 */
async function removeBlacklistedSubject(index) {
  const subject = currentFilters.blacklistedSubjects[index];
  currentFilters.blacklistedSubjects.splice(index, 1);
  renderBlacklistedSubjects();

  // Save immediately (don't wait for "Enregistrer" button)
  await saveFilters(currentFilters);

  toastSuccess(`Sujet rétabli : « ${subject} » — re-téléchargement en cours...`);

  // Trigger re-download in background
  if (onSubjectRestoredCallback && subject) {
    onSubjectRestoredCallback(subject);
  }
}

/**
 * Ajoute un expéditeur à la liste noire
 */
function addBlacklistedSender() {
  const input = document.getElementById('newBlacklistedSender');
  const email = input.value.trim();
  
  if (!email) return;
  
  if (!currentFilters.blacklistedSenders) {
    currentFilters.blacklistedSenders = [];
  }
  
  if (!currentFilters.blacklistedSenders.includes(email)) {
    currentFilters.blacklistedSenders.push(email);
    renderBlacklistedSenders();
    input.value = '';
  } else {
    toastWarning('Cet exp\u00e9diteur est d\u00e9j\u00e0 dans la liste');
  }
}

/**
 * Supprime un expéditeur de la liste noire
 */
function removeBlacklistedSender(index) {
  currentFilters.blacklistedSenders.splice(index, 1);
  renderBlacklistedSenders();
}

/**
 * Ajoute un mot-clé à la liste
 */
function addBlacklistedKeyword() {
  const input = document.getElementById('newBlacklistedKeyword');
  const keyword = input.value.trim();
  
  if (!keyword) return;
  
  if (!currentFilters.blacklistedKeywords) {
    currentFilters.blacklistedKeywords = [];
  }
  
  if (!currentFilters.blacklistedKeywords.includes(keyword)) {
    currentFilters.blacklistedKeywords.push(keyword);
    renderBlacklistedKeywords();
    input.value = '';
  } else {
    toastWarning('Ce mot-cl\u00e9 est d\u00e9j\u00e0 dans la liste');
  }
}

/**
 * Supprime un mot-clé de la liste
 */
function removeBlacklistedKeyword(index) {
  currentFilters.blacklistedKeywords.splice(index, 1);
  renderBlacklistedKeywords();
}

/**
 * Sauvegarde les filtres actuels
 */
async function saveCurrentFilters() {
  // Récupérer les valeurs depuis le formulaire
  currentFilters.excludeNoSubject = document.getElementById('filterNoSubject').checked;
  currentFilters.excludeNotifications = document.getElementById('filterNotifications').checked;
  currentFilters.excludePromotional = document.getElementById('filterPromotional').checked;
  currentFilters.autoExcludeRepetitive = document.getElementById('filterAutoExcludeRepetitive').checked;
  currentFilters.excludeShortConversations = document.getElementById('filterShortConversations').checked;
  currentFilters.minConversationLength = parseInt(document.getElementById('minConversationLength').value);
  currentFilters.useCustomAfterDate = document.getElementById('filterUseCustomAfterDate').checked;
  currentFilters.customAfterDate = document.getElementById('filterCustomAfterDate').value || null;
  
  await saveFilters(currentFilters);
  toastSuccess('Filtres sauvegard\u00e9s avec succ\u00e8s !');
  hideFilterModal();
  if (onFiltersSavedCallback) onFiltersSavedCallback();
}

/**
 * Enregistre un callback appelé après chaque sauvegarde de filtres.
 * Permet à app.js de re-récupérer les IDs avec les nouveaux filtres.
 */
export function setOnFiltersSaved(callback) {
  onFiltersSavedCallback = callback;
}

/**
 * Enregistre un callback appelé quand un sujet est rétabli (retiré de la blacklist).
 * Le callback reçoit le nom du sujet rétabli.
 */
export function setOnSubjectRestored(callback) {
  onSubjectRestoredCallback = callback;
}

/**
 * Met à jour les filtres en mémoire (sans ouvrir la modal).
 * Utilisé pour synchroniser après un ajout programmatique (ex: auto-exclusion).
 */
export function updateCurrentFilters(filters) {
  if (filters) {
    currentFilters = filters;
  }
}

/**
 * Obtient les filtres actuels (avec les keywords par défaut si manquants)
 */
export function getCurrentFilters() {
  if (!currentFilters) {
    return null;
  }
  
  // Assurer que les arrays de keywords sont présents
  const filters = { ...currentFilters };
  
  // Ajouter les keywords par défaut s'ils manquent
  const defaultFilters = getDefaultFilters();
  if (!filters.notificationKeywords || filters.notificationKeywords.length === 0) {
    filters.notificationKeywords = defaultFilters.notificationKeywords;
  }
  if (!filters.promotionalKeywords || filters.promotionalKeywords.length === 0) {
    filters.promotionalKeywords = defaultFilters.promotionalKeywords;
  }
  
  return filters;
}

/**
 * Affiche les statistiques de filtrage
 */
export function showFilterStats(stats) {
  const statsDiv = document.getElementById('filterStats');
  const content = document.getElementById('filterStatsContent');
  
  if (!stats || stats.total === 0) {
    statsDiv.style.display = 'none';
    return;
  }
  
  let html = `
    <div class="stats-grid">
      <div class="stat-item">
        <div class="stat-value">${stats.total}</div>
        <div class="stat-label">Total</div>
      </div>
      <div class="stat-item stat-success">
        <div class="stat-value">${stats.kept}</div>
        <div class="stat-label">Conservés</div>
      </div>
      <div class="stat-item stat-danger">
        <div class="stat-value">${stats.excluded}</div>
        <div class="stat-label">Exclus</div>
      </div>
    </div>
  `;
  
  if (stats.reasons && Object.keys(stats.reasons).length > 0) {
    html += '<div class="stats-reasons"><h4>Raisons d\'exclusion :</h4><ul>';
    for (const [reason, count] of Object.entries(stats.reasons)) {
      html += `<li>${reason}: <strong>${count}</strong></li>`;
    }
    html += '</ul></div>';
  }
  
  content.innerHTML = html;
  statsDiv.style.display = 'block';
}

