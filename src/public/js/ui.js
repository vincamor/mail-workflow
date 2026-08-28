/**
 * User interface management module
 * Drawers, overlays, display
 */

import { renderTree, autoFit, toggleTimelines, getCurrentContainerId } from './treeRenderer.js';
import { handleDisconnect } from './auth.js';
import { resetPanelSizes } from './panels.js';
import { toggleFavoritesFilter, toggleMyConversationsFilter } from './analysis.js';

// === LOADING OVERLAY MANAGEMENT ===

export function showLoadingOverlay(text = 'Loading...', progress = 0) {
  const overlay = document.getElementById('loadingOverlay');
  const textElement = document.getElementById('loadingOverlayText');
  const progressBar = document.getElementById('loadingOverlayProgress');
  const percentage = document.getElementById('loadingOverlayPercentage');

  if (overlay) {
    overlay.style.display = 'flex';
    if (textElement) textElement.textContent = text;
    if (progressBar) progressBar.style.width = `${progress}%`;
    if (percentage) percentage.textContent = `${Math.round(progress)}%`;
  }
}

export function updateLoadingOverlay(text, progress) {
  const textElement = document.getElementById('loadingOverlayText');
  const progressBar = document.getElementById('loadingOverlayProgress');
  const percentage = document.getElementById('loadingOverlayPercentage');

  if (textElement && text) textElement.textContent = text;
  if (progressBar && progress !== undefined) progressBar.style.width = `${progress}%`;
  if (percentage && progress !== undefined) percentage.textContent = `${Math.round(progress)}%`;
}

export function hideLoadingOverlay() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

// === EMAIL DOWNLOAD ANIMATION ===

/**
 * Shows the overlay with email animation and counter
 * @param {number} totalEmails - Total number of emails to download
 */
export function showEmailDownloadAnimation(_totalEmails) {
  const overlay = document.getElementById('loadingOverlay');
  const content = overlay?.querySelector('.loading-overlay-content');

  if (!content) return;

  // Create the animated content
  content.innerHTML = `
    <div class="email-animation-container">
      <div class="flying-email"><span class="icon icon-email icon-xl" aria-hidden="true"></span></div>
      <div class="flying-email"><span class="icon icon-email icon-xl" aria-hidden="true"></span></div>
      <div class="flying-email"><span class="icon icon-email icon-xl" aria-hidden="true"></span></div>
    </div>
    
    <div class="email-counter">
      <div class="email-counter-number" id="emailDownloadCounter">0</div>
      <div class="email-counter-label">Emails downloaded</div>
    </div>

    <div class="loading-overlay-text" id="loadingOverlayText">
      Downloading...
    </div>
    
    <div class="loading-overlay-progress">
      <div class="loading-overlay-bar">
        <div class="loading-overlay-bar-fill" id="loadingOverlayProgress"></div>
      </div>
      <div class="loading-overlay-percentage" id="loadingOverlayPercentage">0%</div>
    </div>
  `;

  overlay.style.display = 'flex';
}

/**
 * Updates the downloaded email counter
 * @param {number} current - Current number of emails downloaded
 * @param {number} total - Total number of emails
 * @param {string} extraInfo - Additional information (e.g. current chunk)
 */
export function updateEmailDownloadCounter(current, total, extraInfo = '') {
  const counter = document.getElementById('emailDownloadCounter');
  const textElement = document.getElementById('loadingOverlayText');
  const progressBar = document.getElementById('loadingOverlayProgress');
  const percentage = document.getElementById('loadingOverlayPercentage');

  if (counter) {
    // Counter animation
    counter.style.animation = 'none';
    setTimeout(() => {
      counter.style.animation = 'pulse 0.5s ease';
      counter.textContent = current;
    }, 10);
  }

  const progress = total > 0 ? (current / total) * 100 : 0;

  if (textElement) {
    const baseText = `Downloading... ${current} / ${total}`;
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
 * Shows the success animation at the end of the download
 * @param {number} totalDownloaded - Total number of emails downloaded
 */
export function showDownloadSuccessAnimation(totalDownloaded) {
  const overlay = document.getElementById('loadingOverlay');
  const content = overlay?.querySelector('.loading-overlay-content');

  if (!content) return;

  content.innerHTML = `
    <div class="success-animation">
      <div class="success-icon"><span class="icon icon-check icon-xl" aria-hidden="true"></span></div>
      <div class="loading-overlay-text">
        Download complete!
      </div>
      <div class="email-counter">
        <div class="email-counter-number">${totalDownloaded}</div>
        <div class="email-counter-label">Emails saved</div>
      </div>
    </div>
  `;
}

/**
 * Restores the standard loading overlay
 */
export function restoreStandardLoadingOverlay() {
  const overlay = document.getElementById('loadingOverlay');
  const content = overlay?.querySelector('.loading-overlay-content');

  if (!content) return;

  content.innerHTML = `
    <div class="loading-spinner"></div>
    <div class="loading-overlay-text" id="loadingOverlayText">
      Loading...
    </div>
    <div class="loading-overlay-progress">
      <div class="loading-overlay-bar">
        <div class="loading-overlay-bar-fill" id="loadingOverlayProgress"></div>
      </div>
      <div class="loading-overlay-percentage" id="loadingOverlayPercentage">0%</div>
    </div>
  `;
}

// === ACCORDION DRAWER MANAGEMENT ===

export function toggleDrawer(drawerId) {
  const drawer = document.getElementById(drawerId);
  const header = drawer.previousElementSibling;
  const toggleIcon = header.querySelector('.drawer-toggle');

  const willOpen = drawer.classList.contains('closed');

  if (willOpen) {
    drawer.classList.remove('closed');
    toggleIcon.classList.add('open');
  } else {
    drawer.classList.add('closed');
    toggleIcon.classList.remove('open');
  }

  if (header && header.hasAttribute('aria-expanded')) {
    header.setAttribute('aria-expanded', String(willOpen));
  }
}

export function toggleUserDropdown() {
  const dropdown = document.getElementById('userDropdown');
  const chevron = document.getElementById('userChevron');
  const container = document.querySelector('.user-avatar-container');

  const willOpen = !dropdown.classList.contains('show');

  dropdown.classList.toggle('show');
  chevron.classList.toggle('open');

  if (container && container.hasAttribute('aria-expanded')) {
    container.setAttribute('aria-expanded', String(willOpen));
  }
}

/**
 * Makes an element (div/span used as a button) keyboard-activatable:
 * Enter and Space trigger the same handler as a click.
 * Does not modify ARIA attributes (set statically in index.html) —
 * just wires up the expected keyboard behaviour for role="button".
 */
function bindActivate(el, handler) {
  if (!el) return;
  el.addEventListener('click', handler);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      handler();
    }
  });
}

// === SIGNED-IN INTERFACE MANAGEMENT ===

export function showConnectedInterface(provider, email) {
  // Switch to the 3-panel interface
  document.getElementById('loginInterface').style.display = 'none';
  document.getElementById('appInterface').style.display = 'block';

  // Show the folder section in the right panel
  document.getElementById('folderSection').style.display = 'block';

  // Show the right panel sections
  document.getElementById('statisticsSection').style.display = 'block';
  document.getElementById('actionsSection').style.display = 'block';
  document.getElementById('aiSection').style.display = 'block';

  // Show and update the user section
  const userSection = document.getElementById('userSection');
  userSection.style.display = 'block';

  // Build initials from the email (first 2 letters)
  const initials = email.substring(0, 2).toUpperCase();
  document.getElementById('userAvatarBubble').textContent = initials;

  // Update the displayed information
  document.getElementById('avatarEmail').textContent = email;
  document.getElementById('avatarProvider').textContent = `via ${
    provider.charAt(0).toUpperCase() + provider.slice(1)
  }`;

  // Show the email counter (will be updated once emails are fetched)
  document.getElementById('emailCountInfo').style.display = 'block';
  document.getElementById('emailCount').textContent = '...';

  // Hide the default view
  document.getElementById('defaultView').style.display = 'none';
}

export function showLoginInterface() {
  document.getElementById('loginInterface').style.display = 'block';
  document.getElementById('appInterface').style.display = 'none';

  // Status message on the sign-in page
  document.getElementById('loginStatus').innerHTML =
    '<div class="login-info"><span class="icon icon-link icon-inline" aria-hidden="true"></span>Sign in to access your email analysis</div>';
}

// === TREE CONTROL FUNCTIONS (called from HTML or JS) ===

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

// === UI EVENT INITIALISATION (strict-CSP compatible) ===

export function initUIEvents() {
  // Folder drawer
  const folderHeader = document.querySelector('#folderSection .drawer-header');
  bindActivate(folderHeader, () => toggleDrawer('folderDrawer'));

  // Statistics drawer
  const statsHeader = document.querySelector('#statisticsSection .drawer-header');
  bindActivate(statsHeader, () => toggleDrawer('statisticsDrawer'));

  // Actions drawer
  const actionsHeader = document.querySelector('#actionsSection .drawer-header');
  bindActivate(actionsHeader, () => toggleDrawer('actionsDrawer'));

  // AI assistant drawer
  const aiHeader = document.querySelector('#aiSection .drawer-header');
  bindActivate(aiHeader, () => toggleDrawer('aiDrawer'));

  // Favourites filter
  const favoritesBtn = document.getElementById('favoritesFilterBtn');
  if (favoritesBtn) {
    favoritesBtn.addEventListener('click', () => toggleFavoritesFilter());
  }

  // "My conversations" filter
  const myConvBtn = document.getElementById('myConversationsBtn');
  if (myConvBtn) myConvBtn.addEventListener('click', toggleMyConversationsFilter);

  // Tree view controls (floating toolbar on the canvas)
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

  // User section
  const userAvatar = document.querySelector('.user-avatar-container');
  bindActivate(userAvatar, () => toggleUserDropdown());

  const disconnectBtn = document.getElementById('disconnectBtn');
  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', () => handleDisconnect());
  }
}
