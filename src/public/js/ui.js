/**
 * Module de gestion de l'interface utilisateur
 * Tiroirs, overlays, affichage
 */

import { renderTree, autoFit, toggleTimelines, getCurrentContainerId } from './treeRenderer.js';
import { handleDisconnect } from './auth.js';
import { resetPanelSizes } from './panels.js';
import { toggleFavoritesFilter, toggleMyConversationsFilter } from './analysis.js';

// === GESTION DE L'OVERLAY DE CHARGEMENT ===

export function showLoadingOverlay(
  text = "Chargement en cours...",
  progress = 0
) {
  const overlay = document.getElementById("loadingOverlay");
  const textElement = document.getElementById("loadingOverlayText");
  const progressBar = document.getElementById("loadingOverlayProgress");
  const percentage = document.getElementById("loadingOverlayPercentage");

  if (overlay) {
    overlay.style.display = "flex";
    if (textElement) textElement.textContent = text;
    if (progressBar) progressBar.style.width = `${progress}%`;
    if (percentage) percentage.textContent = `${Math.round(progress)}%`;
  }
}

export function updateLoadingOverlay(text, progress) {
  const textElement = document.getElementById("loadingOverlayText");
  const progressBar = document.getElementById("loadingOverlayProgress");
  const percentage = document.getElementById("loadingOverlayPercentage");

  if (textElement && text) textElement.textContent = text;
  if (progressBar && progress !== undefined)
    progressBar.style.width = `${progress}%`;
  if (percentage && progress !== undefined)
    percentage.textContent = `${Math.round(progress)}%`;
}

export function hideLoadingOverlay() {
  const overlay = document.getElementById("loadingOverlay");
  if (overlay) {
    overlay.style.display = "none";
  }
}

// === ANIMATION TÉLÉCHARGEMENT D'EMAILS ===

/**
 * Affiche l'overlay avec animation d'emails et compteur
 * @param {number} totalEmails - Nombre total d'emails à télécharger
 */
export function showEmailDownloadAnimation(totalEmails) {
  const overlay = document.getElementById("loadingOverlay");
  const content = overlay?.querySelector(".loading-overlay-content");
  
  if (!content) return;
  
  // Créer le contenu animé
  content.innerHTML = `
    <div class="email-animation-container">
      <div class="flying-email"><span class="icon icon-email icon-xl" aria-hidden="true"></span></div>
      <div class="flying-email"><span class="icon icon-email icon-xl" aria-hidden="true"></span></div>
      <div class="flying-email"><span class="icon icon-email icon-xl" aria-hidden="true"></span></div>
    </div>
    
    <div class="email-counter">
      <div class="email-counter-number" id="emailDownloadCounter">0</div>
      <div class="email-counter-label">Emails téléchargés</div>
    </div>
    
    <div class="loading-overlay-text" id="loadingOverlayText">
      Téléchargement en cours...
    </div>
    
    <div class="loading-overlay-progress">
      <div class="loading-overlay-bar">
        <div class="loading-overlay-bar-fill" id="loadingOverlayProgress"></div>
      </div>
      <div class="loading-overlay-percentage" id="loadingOverlayPercentage">0%</div>
    </div>
  `;
  
  overlay.style.display = "flex";
}

/**
 * Met à jour le compteur d'emails téléchargés
 * @param {number} current - Nombre actuel d'emails téléchargés
 * @param {number} total - Nombre total d'emails
 * @param {string} extraInfo - Information additionnelle (ex: chunk en cours)
 */
export function updateEmailDownloadCounter(current, total, extraInfo = '') {
  const counter = document.getElementById("emailDownloadCounter");
  const textElement = document.getElementById("loadingOverlayText");
  const progressBar = document.getElementById("loadingOverlayProgress");
  const percentage = document.getElementById("loadingOverlayPercentage");
  
  if (counter) {
    // Animation du compteur
    counter.style.animation = 'none';
    setTimeout(() => {
      counter.style.animation = 'pulse 0.5s ease';
      counter.textContent = current;
    }, 10);
  }
  
  const progress = total > 0 ? (current / total) * 100 : 0;
  
  if (textElement) {
    const baseText = `Téléchargement en cours... ${current} / ${total}`;
    textElement.textContent = extraInfo ? `${baseText} - ${extraInfo}` : baseText;
  }
  
  if (progressBar) {
    progressBar.style.width = `${progress}%`;
  }
  
  if (percentage) {
    percentage.textContent = `${Math.round(progress)}%`;
  }
}

/**
 * Affiche l'animation de succès à la fin du téléchargement
 * @param {number} totalDownloaded - Nombre total d'emails téléchargés
 */
export function showDownloadSuccessAnimation(totalDownloaded) {
  const overlay = document.getElementById("loadingOverlay");
  const content = overlay?.querySelector(".loading-overlay-content");
  
  if (!content) return;
  
  content.innerHTML = `
    <div class="success-animation">
      <div class="success-icon"><span class="icon icon-check icon-xl" aria-hidden="true"></span></div>
      <div class="loading-overlay-text">
        Téléchargement terminé !
      </div>
      <div class="email-counter">
        <div class="email-counter-number">${totalDownloaded}</div>
        <div class="email-counter-label">Emails sauvegardés</div>
      </div>
    </div>
  `;
}

/**
 * Restaure l'overlay de chargement standard
 */
export function restoreStandardLoadingOverlay() {
  const overlay = document.getElementById("loadingOverlay");
  const content = overlay?.querySelector(".loading-overlay-content");
  
  if (!content) return;
  
  content.innerHTML = `
    <div class="loading-spinner"></div>
    <div class="loading-overlay-text" id="loadingOverlayText">
      Chargement en cours...
    </div>
    <div class="loading-overlay-progress">
      <div class="loading-overlay-bar">
        <div class="loading-overlay-bar-fill" id="loadingOverlayProgress"></div>
      </div>
      <div class="loading-overlay-percentage" id="loadingOverlayPercentage">0%</div>
    </div>
  `;
}

// === GESTION DES TIROIRS ACCORDÉON ===

export function toggleDrawer(drawerId) {
  const drawer = document.getElementById(drawerId);
  const header = drawer.previousElementSibling;
  const toggleIcon = header.querySelector(".drawer-toggle");

  const willOpen = drawer.classList.contains("closed");

  if (willOpen) {
    drawer.classList.remove("closed");
    toggleIcon.classList.add("open");
  } else {
    drawer.classList.add("closed");
    toggleIcon.classList.remove("open");
  }

  if (header && header.hasAttribute("aria-expanded")) {
    header.setAttribute("aria-expanded", String(willOpen));
  }
}

export function toggleUserDropdown() {
  const dropdown = document.getElementById("userDropdown");
  const chevron = document.getElementById("userChevron");
  const container = document.querySelector(".user-avatar-container");

  const willOpen = !dropdown.classList.contains("show");

  dropdown.classList.toggle("show");
  chevron.classList.toggle("open");

  if (container && container.hasAttribute("aria-expanded")) {
    container.setAttribute("aria-expanded", String(willOpen));
  }
}

/**
 * Rend un élément (div/span utilisé comme bouton) activable au clavier :
 * Entrée et Espace déclenchent le même handler que le clic.
 * Ne modifie pas les attributs ARIA (posés statiquement dans index.html) —
 * se contente de câbler le comportement clavier attendu pour role="button".
 */
function bindActivate(el, handler) {
  if (!el) return;
  el.addEventListener("click", handler);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      handler();
    }
  });
}

// === GESTION DE L'INTERFACE CONNECTÉE ===

export function showConnectedInterface(provider, email) {
  // Basculer vers l'interface 3 panneaux
  document.getElementById("loginInterface").style.display = "none";
  document.getElementById("appInterface").style.display = "block";

  // Afficher la section dossier dans le panneau droit
  document.getElementById("folderSection").style.display = "block";

  // Afficher les sections du panneau droit
  document.getElementById("statisticsSection").style.display = "block";
  document.getElementById("actionsSection").style.display = "block";
  document.getElementById("aiSection").style.display = "block";

  // Afficher et mettre à jour la section utilisateur
  const userSection = document.getElementById("userSection");
  userSection.style.display = "block";

  // Créer les initiales de l'email (2 premières lettres)
  const initials = email.substring(0, 2).toUpperCase();
  document.getElementById("userAvatarBubble").textContent = initials;

  // Mettre à jour les informations affichées
  document.getElementById("avatarEmail").textContent = email;
  document.getElementById("avatarProvider").textContent = `via ${
    provider.charAt(0).toUpperCase() + provider.slice(1)
  }`;

  // Afficher le compteur d'emails (sera mis à jour par la récupération des emails)
  document.getElementById("emailCountInfo").style.display = "block";
  document.getElementById("emailCount").textContent = "...";

  // Masquer la vue par défaut
  document.getElementById("defaultView").style.display = "none";
}

export function showLoginInterface() {
  document.getElementById("loginInterface").style.display = "block";
  document.getElementById("appInterface").style.display = "none";

  // Message de statut sur la page de connexion
  document.getElementById("loginStatus").innerHTML =
    '<div class="login-info"><span class="icon icon-link icon-inline" aria-hidden="true"></span>Connectez-vous pour accéder à l\'analyse de vos emails</div>';
}

// === FONCTIONS CONTRÔLE ARBRE (appelées depuis le HTML ou par JS) ===

export function reloadCurrentTree() {
  const containerId = getCurrentContainerId();
  if (containerId) renderTree(containerId);
}

export function autoFitCurrentTree() {
  autoFit();
}

export function toggleCurrentTreeTimelines() {
  const containerId = getCurrentContainerId();
  if (containerId) toggleTimelines(containerId);
}

// === INITIALISATION DES ÉVÉNEMENTS UI (compatible CSP stricte) ===

export function initUIEvents() {
  // Tiroir dossier
  const folderHeader = document.querySelector('#folderSection .drawer-header');
  bindActivate(folderHeader, () => toggleDrawer('folderDrawer'));

  // Tiroir statistiques
  const statsHeader = document.querySelector(
    '#statisticsSection .drawer-header'
  );
  bindActivate(statsHeader, () => toggleDrawer('statisticsDrawer'));

  // Tiroir actions
  const actionsHeader = document.querySelector(
    '#actionsSection .drawer-header'
  );
  bindActivate(actionsHeader, () => toggleDrawer('actionsDrawer'));

  // Tiroir Assistant IA
  const aiHeader = document.querySelector('#aiSection .drawer-header');
  bindActivate(aiHeader, () => toggleDrawer('aiDrawer'));

  // Filtre favoris
  const favoritesBtn = document.getElementById('favoritesFilterBtn');
  if (favoritesBtn) {
    favoritesBtn.addEventListener('click', () => toggleFavoritesFilter());
  }

  // Filtre "Mes conversations"
  const myConvBtn = document.getElementById('myConversationsBtn');
  if (myConvBtn) myConvBtn.addEventListener('click', toggleMyConversationsFilter);

  // Contrôles de la vue de l'arbre (barre d'outils flottante sur le canvas)
  const autoFitTreeBtn = document.getElementById('autoFitTreeBtn');
  if (autoFitTreeBtn) {
    autoFitTreeBtn.addEventListener('click', () => autoFitCurrentTree());
  }

  const toggleTimelinesBtn = document.getElementById('toggleTimelinesBtn');
  if (toggleTimelinesBtn) {
    toggleTimelinesBtn.addEventListener('click', () => toggleCurrentTreeTimelines());
  }

  const resetPanelsBtn = document.getElementById('resetPanelsBtn');
  if (resetPanelsBtn) {
    resetPanelsBtn.addEventListener('click', () => resetPanelSizes());
  }

  // Section utilisateur
  const userAvatar = document.querySelector('.user-avatar-container');
  bindActivate(userAvatar, () => toggleUserDropdown());

  const disconnectBtn = document.getElementById('disconnectBtn');
  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', () => handleDisconnect());
  }
}

