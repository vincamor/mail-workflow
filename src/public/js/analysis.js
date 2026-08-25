/**
 * Module d'analyse des conversations
 */

import { getEmailFileHandle } from './folders.js';
import { hideLoadingOverlay, updateLoadingOverlay } from './ui.js';
import { showGuideModal } from './toast.js';
import { getCurrentFilters } from './filterUI.js';
import { migrateJsonlIfNeeded } from './emails.js';
import {
  readGroups, writeGroups, getUserFolderHandle,
  getChildGroups, getSubjectsInGroup,
  toggleFavoriteSubject, toggleFavoriteGroup,
  isSubjectFavorite, isGroupFavorite
} from './groups.js';

// Callback pour sélectionner un sujet (injecté par app.js pour éviter l'import circulaire)
let _selectSubjectHandler = null;
export function setSelectSubjectHandler(fn) {
  _selectSubjectHandler = fn;
}

// Callbacks notifiés quand un sujet devient actif (sélectionné dans la sidebar)
const subjectSelectedCallbacks = [];

export function onSubjectSelected(callback) {
  subjectSelectedCallbacks.push(callback);
}

function notifySubjectSelected(subjectKey, subjectInfo) {
  for (const cb of subjectSelectedCallbacks) {
    try { cb(subjectKey, subjectInfo); } catch (e) { console.warn('onSubjectSelected cb error:', e); }
  }
}

// Variables globales pour l'état de l'analyse
let currentSubjects = [];
let currentOpenSubject = null;
let currentTreeContainerId = null;
const currentEmailsMap = new Map(); // Map pour stocker les emails complets par ID

// Variables pour les groupes (chargées après chaque analyse)
let currentGroupsData = null;
let groupsProvider = 'gmail';
let groupsUserId = null;

// Filtre favoris actif ou non
let currentFavoritesOnly = false;
let currentMyConversationsOnly = false;

// Affichage complet de la liste (declenche par l'indicateur "+N conversations").
// Sans ca, les sujets 11..N sont inatteignables (l'indicateur n'etait pas cliquable).
let showAllSubjects = false;
// Dernier jeu de sujets passe a displaySubjects (pour re-rendre "tout" a l'identique).
let lastDisplayedSubjects = [];

// State for progressive/incremental analysis
let currentSelectedSubject = null;  // Subject name currently displayed in tree
let pendingNewEmailsCount = 0;      // New emails for the selected subject since last tree build

export function getCurrentSubjects() {
  return currentSubjects;
}

export function getCurrentTreeContainerId() {
  return currentTreeContainerId;
}

export function getSelectedSubject() {
  return currentSelectedSubject;
}

export function getEmailById(emailId) {
  return currentEmailsMap.get(emailId);
}

// ─── Exports pour la gestion des groupes (utilisés par le menu contextuel) ───

export function getCurrentGroupsData() {
  return currentGroupsData;
}

export async function saveGroupsData() {
  if (!currentGroupsData || !groupsUserId) return;
  const ugfh = await getUserFolderHandle(groupsUserId);
  if (ugfh) await writeGroups(ugfh, groupsProvider, currentGroupsData);
}

export function refreshSubjectsDisplay() {
  displaySubjects(currentSubjects);
}

export function toggleFavoritesFilter() {
  currentFavoritesOnly = !currentFavoritesOnly;
  // Mettre à jour le bouton dans le header
  const btn = document.getElementById('favoritesFilterBtn');
  if (btn) btn.classList.toggle('active', currentFavoritesOnly);
  displaySubjects(currentSubjects);
}

export function toggleMyConversationsFilter() {
  currentMyConversationsOnly = !currentMyConversationsOnly;
  const btn = document.getElementById('myConversationsBtn');
  if (btn) btn.classList.toggle('active', currentMyConversationsOnly);
  displaySubjects(currentSubjects);
}

export function clearTreeNotification() {
  const banner = document.getElementById('treeNewEmailsBanner');
  if (banner) banner.style.display = 'none';
  pendingNewEmailsCount = 0;
}

function notifyNewEmailsForSubject(count) {
  const banner = document.getElementById('treeNewEmailsBanner');
  const text = document.getElementById('treeNewEmailsText');
  if (!banner || !text) return;

  pendingNewEmailsCount = count;
  if (count > 0) {
    text.textContent = `${count} nouveau${count > 1 ? 'x' : ''} email${count > 1 ? 's' : ''} pour ce sujet`;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

/**
 * Incremental analysis: update subjects from a growing email buffer.
 * Called by the download milestone callback.
 * @param {Object} emailAnalyzer - The emailAnalyzer module
 * @param {Array} rawEmails - All accumulated raw emails so far
 * @param {Object} options - { isFinal, totalReceived, totalRequested }
 */
export function incrementalAnalyze(emailAnalyzer, rawEmails, options = {}) {
  const { isFinal = false } = options;

  // Clean all emails
  const emailsClean = rawEmails.map(emailAnalyzer.cleanEmail);
  // Release bodyText to save memory
  emailsClean.forEach(e => { e.bodyText = ''; });

  // Extract subjects with minCount >= 3
  const userEmail = new URLSearchParams(window.location.search).get('email') || '';
  const validSubjects = emailAnalyzer.getSubjectsWithMinEmails(emailsClean, 3, userEmail);

  // Check if the selected subject got new emails
  if (currentSelectedSubject) {
    const prevSubject = currentSubjects.find(s => s.subject === currentSelectedSubject);
    const newSubject = validSubjects.find(s => s.subject === currentSelectedSubject);
    const prevCount = prevSubject ? prevSubject.emailCount : 0;
    const newCount = newSubject ? newSubject.emailCount : 0;
    if (newCount > prevCount) {
      notifyNewEmailsForSubject(newCount - prevCount + pendingNewEmailsCount);
    }
  }

  // Update global state
  currentSubjects = validSubjects;

  // Preserve UI state: scroll position
  const subjectsList = document.getElementById('subjectsList');
  const scrollTop = subjectsList ? subjectsList.scrollTop : 0;

  // Show subjects list and navigation if first meaningful update
  const loadingAnalysis = document.getElementById('loadingAnalysis');
  const searchSection = document.getElementById('searchSection');
  const subjectNavigationBar = document.getElementById('subjectNavigationBar');

  if (validSubjects.length > 0) {
    if (loadingAnalysis) loadingAnalysis.style.display = 'none';
    if (searchSection) searchSection.style.display = 'block';
    if (subjectNavigationBar) subjectNavigationBar.style.display = 'flex';
    if (subjectsList) subjectsList.style.display = 'block';
    const defaultView = document.getElementById('defaultView');
    if (defaultView) defaultView.style.display = 'none';
  }

  // Re-render subjects
  displaySubjects(currentSubjects);

  // Restore scroll position
  if (subjectsList) subjectsList.scrollTop = scrollTop;

  // Re-activate the selected subject drawer if it exists
  if (currentOpenSubject) {
    const activeDrawer = document.querySelector(`[data-subject-id="${currentOpenSubject}"]`);
    if (activeDrawer) {
      activeDrawer.classList.add('active');
      const activeHeader = activeDrawer.querySelector('.subject-drawer-header');
      if (activeHeader) activeHeader.setAttribute('aria-expanded', 'true');
      const chevron = activeDrawer.querySelector('.subject-drawer-chevron');
      if (chevron) chevron.textContent = '▼';
    }
  }

  // Setup search handler
  const searchInput = document.getElementById('subjectSearch');
  if (searchInput) {
    searchInput.removeEventListener('input', filterSubjects);
    searchInput.addEventListener('input', filterSubjects);
  }

  console.log(`📊 Analyse incrémentale${isFinal ? ' (finale)' : ''}: ${validSubjects.length} sujets (${rawEmails.length} emails)`);
}

export function initTreeNotificationBanner(onRefresh) {
  const refreshBtn = document.getElementById('treeNewEmailsRefreshBtn');
  const dismissBtn = document.getElementById('treeNewEmailsDismissBtn');

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      clearTreeNotification();
      if (onRefresh && currentSelectedSubject) {
        onRefresh(currentSelectedSubject);
      }
    });
  }

  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      clearTreeNotification();
    });
  }
}

// Fonction d'analyse automatique des conversations
export async function autoAnalyzeConversations(emailAnalyzer, treeVisualization, provider, email) {
  console.log("🔍 DEBUG autoAnalyze - Démarrage");

  try {
    const currentProvider = provider || "gmail";
    const currentEmail = email;

    if (!currentEmail) {
      console.log("❌ Aucun utilisateur connecté");
      return;
    }

    // Mettre à jour l'overlay
    updateLoadingOverlay("Analyse des conversations en cours...", 50);

    // Changer le texte de la barre de chargement pour l'analyse
    const loadingAnalysis = document.getElementById("loadingAnalysis");
    const searchSection = document.getElementById("searchSection");
    const loadingTextSpan = document.querySelector(
      "#loadingAnalysis .loading-text"
    );
    
    if (loadingTextSpan) {
      loadingTextSpan.innerHTML =
        '<span id="loadingPercentage">0%</span> - Analyse en cours...';
    }
    document.getElementById("loadingPercentage").textContent = "0%";
    document.getElementById("loadingProgress").style.width = "0%";

    // Afficher la barre de chargement
    loadingAnalysis.style.display = "block";
    searchSection.style.display = "none";

    // Récupère le handle du fichier JSONL
    const fileInfo = await getEmailFileHandle(
      currentEmail,
      currentProvider
    );

    if (!fileInfo || !fileInfo.exists) {
      loadingAnalysis.style.display = "none";
      hideLoadingOverlay();
      const fileName = fileInfo?.fileName || `${currentProvider}_emails.jsonl`;
      console.log(`⚠️ Fichier ${fileName} non trouvé.`);
      
      // Afficher un guide à l'utilisateur
      showGuideModal({
        title: 'Aucun fichier d\u2019emails trouv\u00e9',
        icon: '\uD83D\uDCC1',
        type: 'warning',
        body: `
          <p>Le fichier <code>${fileName}</code> n\u2019existe pas dans votre dossier.</p>
          <p>Pour analyser vos conversations, vous devez d\u2019abord :</p>
          <ol class="guide-steps">
            <li class="guide-step-item">
              <span class="guide-step-badge">1</span>
              <span class="guide-step-text">S\u00e9lectionner un dossier de sauvegarde</span>
            </li>
            <li class="guide-step-item">
              <span class="guide-step-badge">2</span>
              <span class="guide-step-text">T\u00e9l\u00e9charger vos emails (bouton &laquo; T\u00e9l\u00e9charger les emails &raquo;)</span>
            </li>
            <li class="guide-step-item">
              <span class="guide-step-badge">3</span>
              <span class="guide-step-text">Relancer l\u2019analyse des conversations</span>
            </li>
          </ol>
          <div class="guide-hint">\uD83D\uDCA1 Le t\u00e9l\u00e9chargement se fait par tranches de 500 emails avec filtres automatiques.</div>
        `,
        buttonText: 'Compris',
      });
      
      return false;
    }

    console.log("🔍 DEBUG userId:", currentEmail);
    console.log("🔍 DEBUG fileInfo:", fileInfo);

    // Masquer la vue par défaut
    document.getElementById("defaultView").style.display = "none";

    // Migrate old JSONL format if needed (extract bodyHtml to companion file)
    await migrateJsonlIfNeeded(currentProvider, currentEmail);

    // Charger les sujets par chunks (version optimisée)
    await loadSubjectsFromHandleChunkedOptimized(
      emailAnalyzer,
      fileInfo.fileHandle,
      500,
      currentProvider,
      currentEmail
    );

    // Masquer la barre de chargement et afficher la recherche
    loadingAnalysis.style.display = "none";
    searchSection.style.display = "block";

    // Afficher le titre "Sujet"
    document.getElementById("subjectNavigationBar").style.display =
      "flex";

    // Masquer l'overlay après l'analyse complète
    updateLoadingOverlay("Analyse terminée !", 100);
    setTimeout(() => hideLoadingOverlay(), 500);
    return true;
  } catch (e) {
    document.getElementById("loadingAnalysis").style.display = "none";
    hideLoadingOverlay();
    console.error("❌ Erreur lors de l'analyse automatique :", e.message);
    return false;
  }
}

// Charger les sujets par chunks (version optimisée utilisant emailAnalyzer)
async function loadSubjectsFromHandleChunkedOptimized(
  emailAnalyzer,
  fileHandle,
  chunkSize = 500,
  provider = 'gmail',
  userId = null
) {
  const subjectsList = document.getElementById("subjectsList");
  const loadingProgress = document.getElementById("loadingProgress");
  const loadingPercentage = document.getElementById("loadingPercentage");

  subjectsList.style.display = "none";
  subjectsList.innerHTML = '<p class="no-data">Chargement...</p>';

  // Declare hors du try pour que le finally puisse toujours l'arreter, meme si
  // loadEmailsFromHandle throw (sinon l'intervalle continue de tourner en fond).
  let progressInterval = null;

  try {
    // Simuler une progression (car emailAnalyzer charge tout d'un coup)
    let progress = 0;
    progressInterval = setInterval(() => {
      progress += Math.random() * 15;
      if (progress > 90) progress = 90;
      loadingProgress.style.width = progress + "%";
      loadingPercentage.textContent = Math.round(progress) + "%";
      // Mettre à jour l'overlay également
      updateLoadingOverlay(
        "Analyse des conversations en cours...",
        progress
      );
    }, 200);

    // Utiliser emailAnalyzer pour charger les emails par chunks
    const emails = await emailAnalyzer.loadEmailsFromHandle(
      fileHandle,
      chunkSize
    );

    clearInterval(progressInterval);
    loadingProgress.style.width = "100%";
    loadingPercentage.textContent = "100%";
    updateLoadingOverlay("Finalisation de l'analyse...", 95);

    if (emails.length === 0) {
      subjectsList.innerHTML =
        '<p class="no-data">Aucun email trouvé</p>';
      subjectsList.style.display = "block";
      hideLoadingOverlay();
      return;
    }

    // Nettoyer les emails avec emailAnalyzer
    const emailsClean = emails.map(emailAnalyzer.cleanEmail);

    // Libérer le tableau brut immédiatement : emailsClean est la seule copie nécessaire.
    // Sans ça, les deux tableaux coexistent en mémoire le temps que le GC intervienne.
    emails.length = 0;

    // Libérer bodyText dans les emails nettoyés : getSubjectsWithMinEmails n'en a pas besoin
    // (il n'utilise que subject, from, date et _chunkIndex).
    // bodyText est rechargé à la demande lors de la sélection d'un sujet (getEmailsForSubjectOptimized).
    emailsClean.forEach(e => { e.bodyText = ''; });

    // Obtenir les sujets avec index des chunks
    const validSubjects = emailAnalyzer.getSubjectsWithMinEmails(
      emailsClean,
      3,
      userId
    );

    currentSubjects = validSubjects;

    // Charger les groupes en mémoire avant l'affichage
    groupsProvider = provider;
    groupsUserId = userId;
    const ugfh = await getUserFolderHandle(userId);
    currentGroupsData = ugfh ? await readGroups(ugfh, provider) : null;

    displaySubjects(currentSubjects);

    // Afficher la liste
    subjectsList.style.display = "block";

    // Ajouter l'événement de recherche (une seule fois)
    const searchInput = document.getElementById("subjectSearch");
    searchInput.removeEventListener("input", filterSubjects);
    searchInput.addEventListener("input", filterSubjects);

    console.log(
      `✅ Analyse terminée : ${validSubjects.length} sujets trouvés avec index des chunks`
    );
  } catch (error) {
    subjectsList.innerHTML = `<p class="no-data" style="color: var(--error);">❌ Erreur: ${escapeHtml(error.message)}</p>`;
    subjectsList.style.display = "block";
    hideLoadingOverlay();
  } finally {
    // Toujours arreter l'intervalle de progression, y compris sur erreur.
    if (progressInterval) clearInterval(progressInterval);
  }
}

// ─── Utilitaires d'affichage ──────────────────────────────────────────────────

/** Helpers locaux pour l'état favori (évitent de passer data en paramètre partout) */
function isSubjectFav(subjectKey) {
  return currentGroupsData ? isSubjectFavorite(currentGroupsData, subjectKey) : false;
}
function isGroupFav(groupId) {
  return currentGroupsData ? isGroupFavorite(currentGroupsData, groupId) : false;
}

/** Retourne un ID stable pour un sujet basé sur sa position dans currentSubjects */
function getStableSubjectId(subjectKey) {
  const idx = currentSubjects.findIndex(s => s.subject === subjectKey);
  return `subject-${idx >= 0 ? idx : 'u-' + subjectKey.substring(0, 12).replace(/\s+/g, '-')}`;
}

/** Échappe les caractères HTML dans une chaîne */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Génère le HTML d'un tiroir de sujet */
function renderSubjectItemHtml(subject, stableId, isGrouped = false) {
  const groupedClass = isGrouped ? ' subject-drawer--grouped' : '';
  const isFav = isSubjectFav(subject.subject);
  const starClass = isFav ? ' is-favorite' : '';
  const starTitle = isFav ? 'Retirer des favoris' : 'Ajouter aux favoris';
  const starChar = isFav ? '★' : '☆';
  return `
    <div class="subject-drawer${groupedClass}" data-subject="${escapeHtml(subject.subject)}" data-subject-id="${stableId}">
      <div class="subject-drawer-header" role="button" tabindex="0" aria-expanded="false">
        <div class="subject-drawer-content">
          <div class="subject-drawer-title">${escapeHtml(subject.subject)}</div>
          <div class="subject-drawer-meta">
            ${subject.emailCount || subject.count || 0} emails${subject.userReplied ? '<span class="badge-replied" title="Vous avez participé">↩</span>' : ''}${subject.isNewsletter ? '<span class="badge-newsletter" title="Newsletter détectée">📰</span>' : ''}${subject.userInCcOnly ? '<span class="badge-cc" title="En copie uniquement">cc</span>' : ''}
          </div>
        </div>
        <button class="star-btn${starClass}" data-star-subject="${escapeHtml(subject.subject)}" title="${starTitle}">${starChar}</button>
        <div class="subject-drawer-chevron">›</div>
      </div>
    </div>`;
}

/** Génère le HTML d'un indicateur "N sujets supplémentaires" */
function renderMoreIndicatorHtml(remainingCount) {
  const plural = remainingCount > 1 ? 's' : '';
  return `
    <div class="more-subjects-indicator" role="button" tabindex="0" data-more-subjects="1" aria-label="Afficher ${remainingCount} conversation${plural} supplémentaire${plural}">
      <div class="more-subjects-dots">•••</div>
      <div class="more-subjects-text">+${remainingCount} conversation${plural}</div>
    </div>`;
}

/** Attache le comportement d'expansion sur l'indicateur "+N conversations" */
function attachMoreIndicator(container) {
  container.querySelectorAll('[data-more-subjects]').forEach(indicator => {
    const activate = () => {
      showAllSubjects = true;
      displaySubjects(lastDisplayedSubjects);
    };
    indicator.addEventListener('click', activate);
    indicator.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
  });
}

/** Génère récursivement le HTML d'un groupe et de son contenu */
function renderGroupItemHtml(group, subjectMap, renderedKeys, isNested, showEmptyPlaceholder = true) {
  const subjectKeysInGroup = getSubjectsInGroup(currentGroupsData, group.id);

  let contentHtml = '';

  // Sous-groupes (uniquement au niveau racine, max 2 niveaux)
  if (!isNested) {
    const childGroups = getChildGroups(currentGroupsData, group.id);
    childGroups.forEach(child => {
      contentHtml += renderGroupItemHtml(child, subjectMap, renderedKeys, true, showEmptyPlaceholder);
    });
  }

  // Sujets directement dans ce groupe
  subjectKeysInGroup.forEach(key => {
    const subject = subjectMap.get(key);
    if (!subject) return;
    renderedKeys.add(key);
    contentHtml += renderSubjectItemHtml(subject, getStableSubjectId(key), true);
  });

  // Groupe vide
  if (!contentHtml) {
    if (!showEmptyPlaceholder) return ''; // En mode favoris : masquer les groupes vides
    contentHtml = '<div class="group-empty-placeholder">Aucun sujet — clic droit sur un sujet pour l\'ajouter</div>';
  }

  // Compte des sujets visibles dans ce groupe
  const visibleCount = subjectKeysInGroup.filter(k => subjectMap.has(k)).length;
  const nestClass = isNested ? ' group-item--nested' : '';
  const isFav = isGroupFav(group.id);
  const starClass = isFav ? ' is-favorite' : '';
  const starTitle = isFav ? 'Retirer des favoris' : 'Ajouter aux favoris';
  const starChar = isFav ? '★' : '☆';
  const folderColor = group.color || '#94a3b8';
  const iconHtml = `<span class="group-folder-icon" style="color:${folderColor}"><svg width="15" height="13" viewBox="0 0 20 16" fill="currentColor" aria-hidden="true"><path d="M0 2C0 .9.9 0 2 0h5l2 2h9c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2H2c-1.1 0-2-.9-2-2V2z"/></svg></span>`;

  return `
    <div class="group-item${nestClass}" data-group-id="${group.id}">
      <div class="group-header" role="button" tabindex="0" aria-expanded="false">
        ${iconHtml}
        <span class="group-name">${escapeHtml(group.name)}</span>
        ${visibleCount > 0 ? `<span class="group-badge">${visibleCount}</span>` : ''}
        <button class="star-btn${starClass}" data-star-group="${group.id}" title="${starTitle}">${starChar}</button>
        <span class="group-chevron">›</span>
      </div>
      <div class="group-content">${contentHtml}</div>
    </div>`;
}

/** Attache les listeners sur tous les .subject-drawer d'un container */
function attachSubjectListeners(container) {
  container.querySelectorAll('.subject-drawer').forEach(drawer => {
    const header = drawer.querySelector('.subject-drawer-header');
    if (!header) return;

    // Étoile favori — stopPropagation pour ne pas ouvrir le tiroir
    const starBtn = header.querySelector('.star-btn[data-star-subject]');
    if (starBtn) {
      starBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const key = starBtn.getAttribute('data-star-subject');
        if (!currentGroupsData || !key) return;
        const isFav = toggleFavoriteSubject(currentGroupsData, key);
        starBtn.classList.toggle('is-favorite', isFav);
        starBtn.title = isFav ? 'Retirer des favoris' : 'Ajouter aux favoris';
        await saveGroupsData();
        // Rafraîchir uniquement si le filtre favoris est actif
        if (currentFavoritesOnly) refreshSubjectsDisplay();
      });
    }

    header.addEventListener('click', () => {
      toggleSubjectDrawer(drawer, drawer.getAttribute('data-subject'), drawer.getAttribute('data-subject-id'));
    });

    // Clavier : Enter/Espace active le tiroir (sauf si le focus est sur l'etoile).
    header.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('.star-btn')) return;
      e.preventDefault();
      toggleSubjectDrawer(drawer, drawer.getAttribute('data-subject'), drawer.getAttribute('data-subject-id'));
    });
  });
}

/** Attache les listeners de toggle sur tous les .group-header d'un container */
function attachGroupListeners(container) {
  container.querySelectorAll('.group-item').forEach(groupItem => {
    const header = groupItem.querySelector(':scope > .group-header');
    if (!header) return;

    // Étoile favori du groupe
    const starBtn = header.querySelector('.star-btn[data-star-group]');
    if (starBtn) {
      starBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const groupId = starBtn.getAttribute('data-star-group');
        if (!currentGroupsData || !groupId) return;
        const isFav = toggleFavoriteGroup(currentGroupsData, groupId);
        starBtn.classList.toggle('is-favorite', isFav);
        starBtn.title = isFav ? 'Retirer des favoris' : 'Ajouter aux favoris';
        await saveGroupsData();
        if (currentFavoritesOnly) refreshSubjectsDisplay();
      });
    }

    const toggleGroup = () => {
      const open = groupItem.classList.toggle('open');
      header.setAttribute('aria-expanded', open ? 'true' : 'false');
    };

    header.addEventListener('click', toggleGroup);

    header.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('.star-btn')) return;
      e.preventDefault();
      toggleGroup();
    });
  });
}

// ─── Fonctions de rendu de la liste ───────────────────────────────────────────

/** Rendu plat (mode recherche ou aucun groupe) — max 10 sujets */
function renderFlatSubjectsList(subjectsList, subjects) {
  const limit = showAllSubjects ? subjects.length : 10;
  const limited = subjects.slice(0, limit);
  const hasMore = subjects.length > limit;

  let html = limited.map(subject =>
    renderSubjectItemHtml(subject, getStableSubjectId(subject.subject))
  ).join('');

  if (hasMore) {
    html += renderMoreIndicatorHtml(subjects.length - limit);
  }

  subjectsList.innerHTML = html;
  attachSubjectListeners(subjectsList);
  attachMoreIndicator(subjectsList);
}

/** Rendu groupé (mode normal avec groupes) */
function renderGroupedSubjectsList(subjectsList, subjects, hideEmptyGroups = false) {
  const subjectMap = new Map(subjects.map(s => [s.subject, s]));
  const renderedKeys = new Set();

  const rootGroups = getChildGroups(currentGroupsData, null);
  let html = rootGroups.map(group =>
    renderGroupItemHtml(group, subjectMap, renderedKeys, false, !hideEmptyGroups)
  ).join('');

  // Sujets non groupés
  const ungrouped = subjects.filter(s => !renderedKeys.has(s.subject));
  if (ungrouped.length > 0 && rootGroups.length > 0) {
    html += `<div class="ungrouped-separator"><span>Non groupés</span></div>`;
  }

  const ungroupedLimit = showAllSubjects ? ungrouped.length : 10;
  const limitedUngrouped = ungrouped.slice(0, ungroupedLimit);
  html += limitedUngrouped.map(subject =>
    renderSubjectItemHtml(subject, getStableSubjectId(subject.subject))
  ).join('');

  if (ungrouped.length > ungroupedLimit) {
    html += renderMoreIndicatorHtml(ungrouped.length - ungroupedLimit);
  }

  subjectsList.innerHTML = html;
  attachSubjectListeners(subjectsList);
  attachGroupListeners(subjectsList);
  attachMoreIndicator(subjectsList);
}

/**
 * Rendu recherche avec groupes.
 * - Groupes dont le NOM matche → affichés ouverts avec TOUS leurs sujets
 * - Groupes contenant des sujets qui matchent → affichés ouverts avec seulement les sujets matchants
 * - Sujets matchants non groupés → affichés dessous
 */
function renderSearchGroupedSubjectsList(subjectsList, subjects, searchTerm) {
  const lowerSearch = searchTerm.toLowerCase();

  // Map des sujets matchant la recherche (filtrés par filterSubjects)
  const matchingMap = new Map(subjects.map(s => [s.subject, s]));
  // Map de TOUS les sujets (pour les groupes dont le nom matche)
  const allMap = new Map(currentSubjects.map(s => [s.subject, s]));

  const renderedKeys = new Set();
  const rootGroups = getChildGroups(currentGroupsData, null);
  let html = '';

  rootGroups.forEach(group => {
    const nameMatches = group.name.toLowerCase().includes(lowerSearch);
    const mapToUse = nameMatches ? allMap : matchingMap;

    // En mode recherche, ne montrer un groupe que si son nom matche
    // OU s'il contient au moins un sujet/sous-groupe matchant
    if (!nameMatches) {
      const directKeys = getSubjectsInGroup(currentGroupsData, group.id);
      const childGroups = getChildGroups(currentGroupsData, group.id);
      const hasMatchingContent =
        directKeys.some(k => matchingMap.has(k)) ||
        childGroups.some(child =>
          getSubjectsInGroup(currentGroupsData, child.id).some(k => matchingMap.has(k))
        );
      if (!hasMatchingContent) return;
    }

    html += renderGroupItemHtml(group, mapToUse, renderedKeys, false);
  });

  // Sujets matchants non encore affichés dans un groupe
  const ungrouped = subjects.filter(s => !renderedKeys.has(s.subject));
  if (ungrouped.length > 0 && html.length > 0) {
    html += `<div class="ungrouped-separator"><span>Non groupés</span></div>`;
  }
  html += ungrouped.map(s =>
    renderSubjectItemHtml(s, getStableSubjectId(s.subject))
  ).join('');

  if (!html) {
    subjectsList.innerHTML = '<p class="no-data">Aucun résultat</p>';
    return;
  }

  subjectsList.innerHTML = html;
  attachSubjectListeners(subjectsList);
  attachGroupListeners(subjectsList);
  attachMoreIndicator(subjectsList);
  // Auto-ouvrir tous les groupes en mode recherche pour que les résultats soient visibles
  subjectsList.querySelectorAll('.group-item').forEach(gi => {
    gi.classList.add('open');
    const header = gi.querySelector(':scope > .group-header');
    if (header) header.setAttribute('aria-expanded', 'true');
  });
}

// ─── Fonction principale d'affichage ─────────────────────────────────────────

// Afficher les sujets dans la liste (avec gestion des groupes et du filtre favoris)
function displaySubjects(subjects) {
  const subjectsList = document.getElementById("subjectsList");

  // Memoriser le jeu affiche pour permettre a l'indicateur "+N" de re-rendre tout.
  lastDisplayedSubjects = subjects;

  // Apply favorites filter
  let baseSubjects = (currentFavoritesOnly && currentGroupsData)
    ? subjects.filter(s => isSubjectFavorite(currentGroupsData, s.subject))
    : subjects;

  // Apply excluded subjects filter
  const filters = getCurrentFilters();
  if (filters && filters.blacklistedSubjects && filters.blacklistedSubjects.length > 0) {
    const excluded = new Set(filters.blacklistedSubjects);
    baseSubjects = baseSubjects.filter(s => !excluded.has(s.subject));
  }

  // Apply "my conversations" filter
  if (currentMyConversationsOnly) {
    baseSubjects = baseSubjects.filter(s => s.userReplied || s.userInTo);
  }

  if (baseSubjects.length === 0) {
    subjectsList.innerHTML = currentFavoritesOnly
      ? '<p class="no-data">Aucun sujet favori</p>'
      : '<p class="no-data">Aucun sujet trouvé</p>';
    return;
  }

  const searchTerm = document.getElementById('subjectSearch')?.value?.trim() || '';
  const isSearching = searchTerm.length > 0;
  const hasGroups = currentGroupsData && currentGroupsData.groups.length > 0;

  if (!hasGroups) {
    renderFlatSubjectsList(subjectsList, baseSubjects);
  } else if (isSearching) {
    renderSearchGroupedSubjectsList(subjectsList, baseSubjects, searchTerm);
  } else {
    // En mode favoris, masquer les groupes sans favoris (pas de placeholder vide)
    renderGroupedSubjectsList(subjectsList, baseSubjects, currentFavoritesOnly);
  }
}

// Toggle un tiroir de sujet
function toggleSubjectDrawer(drawer, subject, subjectId) {
  const chevron = drawer.querySelector(".subject-drawer-chevron");

  const header = drawer.querySelector(".subject-drawer-header");

  // Si ce sujet est déjà ouvert, le fermer
  if (currentOpenSubject === subjectId) {
    drawer.classList.remove("active");
    if (header) header.setAttribute("aria-expanded", "false");
    chevron.textContent = "›";
    currentOpenSubject = null;
    currentSelectedSubject = null;
    pendingNewEmailsCount = 0;
    clearTreeNotification();
    return;
  }

  // Fermer le sujet précédemment ouvert
  if (currentOpenSubject) {
    const previousDrawer = document.querySelector(
      `[data-subject-id="${currentOpenSubject}"]`
    );
    if (previousDrawer) {
      previousDrawer.classList.remove("active");
      const prevHeader = previousDrawer.querySelector(".subject-drawer-header");
      if (prevHeader) prevHeader.setAttribute("aria-expanded", "false");
      previousDrawer.querySelector(
        ".subject-drawer-chevron"
      ).textContent = "›";
    }
  }

  // Ouvrir le nouveau sujet
  drawer.classList.add("active");
  if (header) header.setAttribute("aria-expanded", "true");
  chevron.textContent = "▼";
  currentOpenSubject = subjectId;
  currentSelectedSubject = subject;
  pendingNewEmailsCount = 0;
  clearTreeNotification();

  // Notifier les abonnés (ex: bouton chat IA).
  // `subject` ici est une string (data-subject attribute) — on cherche
  // l'objet sujet complet dans currentSubjects pour le passer en subjectInfo.
  const subjectInfo = currentSubjects.find(s => s.subject === subject);
  notifySubjectSelected(subject, subjectInfo || { subject });

  // Charger l'arbre (callback injecté par app.js)
  if (_selectSubjectHandler) {
    _selectSubjectHandler(subject);
  }
}

// Filtrer les sujets selon la recherche
function filterSubjects() {
  // Nouvelle recherche → on repart de la liste tronquee (l'expansion "+N" est
  // reinitialisee a chaque changement de terme).
  showAllSubjects = false;

  const searchTerm = document
    .getElementById("subjectSearch")
    .value.toLowerCase();

  if (!searchTerm) {
    displaySubjects(currentSubjects);
    hideSearchingIndicator();
    return;
  }

  // Level 1: instant search in metadata (subject, participants, recipients, snippets)
  const filteredSubjects = currentSubjects.filter(
    (subject) =>
      subject.subject.toLowerCase().includes(searchTerm) ||
      subject.participants.some((p) =>
        p.toLowerCase().includes(searchTerm)
      ) ||
      (subject.recipients && subject.recipients.some((r) =>
        r.includes(searchTerm)
      )) ||
      (subject.allParticipants && subject.allParticipants.some((p) =>
        p.includes(searchTerm)
      )) ||
      (subject.snippets && subject.snippets.includes(searchTerm))
  );

  displaySubjects(filteredSubjects);

  // Level 2: always launch deep body search in parallel
  triggerDeepSearch(searchTerm, filteredSubjects);
}

// ─── Recherche profonde (niveau 2 — body text) ─────────────────────────────

let _deepSearchAbort = null;
let _deepSearchTimeout = null;

/**
 * Lance une recherche dans le body text du JSONL en streaming.
 * Débounce de 500ms pour éviter de lancer à chaque frappe.
 */
function triggerDeepSearch(searchTerm, level1Results) {
  // Cancel previous deep search
  if (_deepSearchAbort) _deepSearchAbort.abort = true;
  if (_deepSearchTimeout) clearTimeout(_deepSearchTimeout);

  _deepSearchTimeout = setTimeout(() => {
    performDeepSearch(searchTerm, level1Results);
  }, 500);
}

async function performDeepSearch(searchTerm, level1Results) {
  const abort = { abort: false };
  _deepSearchAbort = abort;

  showSearchingIndicator();

  try {
    const urlParams = new URLSearchParams(window.location.search);
    const provider = urlParams.get('provider') || 'gmail';
    const userEmail = urlParams.get('email');
    if (!userEmail) return;

    const fileInfo = await getEmailFileHandle(userEmail, provider);
    if (!fileInfo || !fileInfo.exists) return;

    const file = await fileInfo.fileHandle.getFile();
    const stream = file.stream();
    const textDecoder = new TextDecoder();
    let buffer = '';

    // Track which subjects matched via body content
    const bodyMatchedSubjects = new Set();
    const level1SubjectNames = new Set(level1Results.map(s => s.subject));
    const lowerSearch = searchTerm.toLowerCase();

    for await (const chunk of stream) {
      if (abort.abort) return;

      buffer += textDecoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        // Quick string check before parsing
        if (!line.toLowerCase().includes(lowerSearch)) continue;
        try {
          const parsed = JSON.parse(line);
          const bodyText = (parsed.bodyText || '').toLowerCase();
          if (bodyText.includes(lowerSearch)) {
            const subj = (parsed.subject || '')
              .replace(/^(Re:|Fwd:|FW:|RE:|FWD:)\s*/i, '')
              .trim();
            if (subj && !level1SubjectNames.has(subj)) {
              bodyMatchedSubjects.add(subj);
            }
          }
        } catch (e) { /* skip malformed lines */ }
      }
    }

    // Process remaining buffer
    if (buffer.trim() && buffer.toLowerCase().includes(lowerSearch)) {
      try {
        const parsed = JSON.parse(buffer);
        const bodyText = (parsed.bodyText || '').toLowerCase();
        if (bodyText.includes(lowerSearch)) {
          const subj = (parsed.subject || '')
            .replace(/^(Re:|Fwd:|FW:|RE:|FWD:)\s*/i, '')
            .trim();
          if (subj && !level1SubjectNames.has(subj)) {
            bodyMatchedSubjects.add(subj);
          }
        }
      } catch (e) { /* skip malformed lines */ }
    }

    if (abort.abort) return;

    // Merge level 2 results with level 1
    if (bodyMatchedSubjects.size > 0) {
      const deepMatches = currentSubjects.filter(s => bodyMatchedSubjects.has(s.subject));
      const merged = [...level1Results, ...deepMatches];
      displaySubjects(merged);
    }
  } catch (e) {
    console.warn('Recherche profonde échouée:', e.message);
  } finally {
    if (!abort.abort) hideSearchingIndicator();
  }
}

function showSearchingIndicator() {
  const searchInput = document.getElementById('subjectSearch');
  if (searchInput) searchInput.classList.add('searching');

  // Add loading indicator below subjects list
  const subjectsList = document.getElementById('subjectsList');
  if (subjectsList && !document.getElementById('deepSearchLoader')) {
    const loader = document.createElement('div');
    loader.id = 'deepSearchLoader';
    loader.className = 'deep-search-loader';
    loader.innerHTML = '<div class="deep-search-spinner"></div><span>Recherche dans le contenu des emails...</span>';
    subjectsList.appendChild(loader);
  }
}

function hideSearchingIndicator() {
  const searchInput = document.getElementById('subjectSearch');
  if (searchInput) searchInput.classList.remove('searching');

  const loader = document.getElementById('deepSearchLoader');
  if (loader) loader.remove();
}

// Sélectionner un sujet et créer l'arbre
export async function selectSubject(emailAnalyzer, treeVisualization, subject, provider, email) {
  const treeContainer = document.getElementById("treeContainer");
  treeContainer.innerHTML = "<p>⏳ Génération de l'arbre...</p>";
  document.getElementById("treeVisualization").style.display = "block";
  document.getElementById("defaultView").style.display = "none";

  try {
    const currentProvider = provider || "gmail";
    const currentEmail = email;

    const fileInfo = await getEmailFileHandle(
      currentEmail,
      currentProvider
    );

    if (!fileInfo || !fileInfo.exists) {
      treeContainer.innerHTML = `
        <div style="padding: 2rem; text-align: center; color: var(--text-secondary);">
          <div style="font-size: 3rem; margin-bottom: 1rem;">📁</div>
          <h3 style="color: var(--error); margin-bottom: 1rem;">Fichier d'emails non trouvé</h3>
          <p style="margin-bottom: 1rem;">
            Le fichier "${fileInfo?.fileName || `${currentProvider}_emails.jsonl`}" n'existe pas.
          </p>
          <p style="margin-bottom: 1.5rem;">
            Veuillez d'abord télécharger vos emails depuis le panneau de gauche.
          </p>
          <div style="background: var(--bg-secondary); padding: 1rem; border-radius: 8px; font-size: 0.9rem; text-align: left; max-width: 400px; margin: 0 auto;">
            <strong>📝 Étapes à suivre :</strong><br/>
            1️⃣ Choisir un dossier de sauvegarde<br/>
            2️⃣ Cliquer sur "Télécharger les emails"<br/>
            3️⃣ Attendre la fin du téléchargement<br/>
            4️⃣ Relancer l'analyse des conversations
          </div>
        </div>
      `;
      return;
    }

    // Trouver les infos du sujet dans la liste actuelle
    const subjectInfo = currentSubjects.find(
      (s) => s.subject === subject
    );

    if (!subjectInfo) {
      treeContainer.innerHTML = `<p style="color: var(--error);">❌ Sujet non trouvé dans la liste</p>`;
      return;
    }

    // Récupérer les emails du sujet en utilisant l'index des chunks (optimisé)
    console.log("🔍 DEBUG subjectInfo:", subjectInfo);
    const subjectEmails =
      await emailAnalyzer.getEmailsForSubjectOptimized(
        fileInfo.fileHandle,
        subjectInfo
      );

    console.log("🔍 DEBUG subjectEmails trouvés:", subjectEmails.length);

    if (subjectEmails.length === 0) {
      treeContainer.innerHTML = `<p style="color: var(--error);">❌ Aucun email trouvé pour ce sujet</p>`;
      return;
    }

    // Nettoyer les emails et créer l'arbre avec emailAnalyzer
    const emailsClean = subjectEmails.map(emailAnalyzer.cleanEmail);
    
    // Stocker les emails complets dans la Map pour accès rapide
    currentEmailsMap.clear(); // Vider la Map précédente
    emailsClean.forEach(email => {
      if (email.id) {
        currentEmailsMap.set(email.id, email);
      }
    });
    
    const tree = emailAnalyzer.createTemporalGroupTree(
      emailsClean,
      subject
    );

    // Utiliser le nouveau module de visualisation
    const treeHTML = treeVisualization.createCompleteVisualization(tree, {
      maxDepth: 4,
      showDetails: true,
    });

    treeContainer.innerHTML = treeHTML;

    // Extraire le containerId du HTML généré pour le stocker
    const containerMatch = treeHTML.match(/id="(tree-container-[^"]+)"/);
    if (containerMatch) {
      currentTreeContainerId = containerMatch[1];
    }

    // Mettre à jour les statistiques dans le tiroir
    document.getElementById("totalEmails").textContent =
      tree.nodes.length;
    document.getElementById("totalConversations").textContent =
      tree.links.length;

    // Afficher les sections Statistiques et Actions
    document.getElementById("statisticsSection").style.display = "block";
    document.getElementById("actionsSection").style.display = "block";
  } catch (error) {
    treeContainer.innerHTML = `<p style="color: var(--error);">❌ Erreur de génération: ${escapeHtml(error.message)}</p>`;
  }
}

