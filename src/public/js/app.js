/**
 * Main application module
 * Orchestrates all the other modules
 */

// Import modules
import emailAnalyzer from '/services/emailAnalyzer_browser.js';
import treeVisualization, { setNodeClickHandler } from './treeRenderer.js';
import { setupFetchInterceptor, initLoginButtons } from './auth.js';
import {
  showLoadingOverlay,
  hideLoadingOverlay,
  updateLoadingOverlay,
  showConnectedInterface,
  showLoginInterface,
  initUIEvents,
} from './ui.js';
import { initPanelResizers } from './panels.js';
import { initFolderHandlers, restoreFolder } from './folders.js';
import {
  downloadEmails,
  syncEmails,
  startEmailPolling,
  updateNewEmailsBadge,
  redownloadMissingEmails,
} from './emails.js';
import {
  autoAnalyzeConversations,
  selectSubject as analysisSelectSubject,
  setSelectSubjectHandler,
  incrementalAnalyze,
  initTreeNotificationBanner,
  clearTreeNotification,
} from './analysis.js';
import { showEmailDetail } from './email-detail.js';
import { initFilterUI, setOnFiltersSaved, setOnSubjectRestored } from './filterUI.js';
import { initGroupContextMenu } from './groupContextMenu.js';
import { restoreTheme, buildThemePicker } from './themeManager.js';
import { toastSuccess } from './toast.js';
import { initAIPanel } from './aiPanel.js';
import { initChatUI } from './aiChatUI.js';
import {
  isDemoMode,
  showDemoBanner,
  applyDemoReadOnlyUI,
  DEMO_PROVIDER,
  DEMO_USER_ID,
} from './demo.js';

// Wire showEmailDetail into treeRenderer (replaces window.showEmailDetail)
setNodeClickHandler(showEmailDetail);

// Restore the saved theme before the first paint
restoreTheme();

// Global application state variables
let analysisLaunched = false;
let availableMessageIds = [];

// === INITIALISATION ON LOAD ===
document.addEventListener('DOMContentLoaded', initApp);

async function initApp() {
  // Demo mode reads an embedded dataset via fetch: it needs neither a local
  // folder nor the File System Access API, so it works on Firefox, Safari and
  // mobile. Browser detection only applies to normal mode.
  const demo = isDemoMode();

  // Unsupported browser detection (SaaS plan 1.5 — File System Access API)
  if (!demo && typeof window.showDirectoryPicker !== 'function') {
    const unsupportedEl = document.getElementById('unsupportedBrowser');
    const loginEl = document.getElementById('loginInterface');
    const appEl = document.getElementById('appInterface');
    if (unsupportedEl) unsupportedEl.style.display = 'flex';
    if (loginEl) loginEl.style.display = 'none';
    if (appEl) appEl.style.display = 'none';
    return;
  }

  console.log('🚀 Initialising the application');

  // Set up the fetch interceptor for session handling
  setupFetchInterceptor();

  // Initialise the sign-in buttons
  initLoginButtons();

  // Initialise the panel resizers
  initPanelResizers();

  // Initialise UI events (drawers, action buttons, etc.) without inline onclick
  initUIEvents();

  // Build the theme picker
  buildThemePicker();

  // Demo mode: connected, read-only interface, no OAuth and no folder.
  // The AI is disabled (/api/ai/* requires an authenticated session → 401).
  if (demo) {
    await initDemoInterface();
    return;
  }

  // Initialise the AI settings panel
  initAIPanel();

  // Initialise the AI chat UI
  initChatUI({
    getEmailsForSubject: async (subjectInfo) => {
      const emailAnalyzer = (await import('/services/emailAnalyzer_browser.js')).default;
      const { getEmailFileHandle } = await import('./folders.js');
      const urlParams = new URLSearchParams(window.location.search);
      const provider = urlParams.get('provider') || 'gmail';
      const userId = urlParams.get('email');
      const fileInfo = await getEmailFileHandle(userId, provider);
      if (!fileInfo || !fileInfo.fileHandle) return [];
      return await emailAnalyzer.getEmailsForSubjectOptimized(fileInfo.fileHandle, subjectInfo);
    },
    onUseDraft: async (text) => {
      const subjectInfo = window.__currentChatSubjectInfo;
      if (!subjectInfo) return;

      // Need to get the last email of the subject to pass to showReplyForm
      const emailAnalyzer = (await import('/services/emailAnalyzer_browser.js')).default;
      const { getEmailFileHandle } = await import('./folders.js');
      const { showReplyForm } = await import('./reply.js');
      const urlParams = new URLSearchParams(window.location.search);
      const provider = urlParams.get('provider') || 'gmail';
      const userId = urlParams.get('email');
      const fileInfo = await getEmailFileHandle(userId, provider);
      if (!fileInfo || !fileInfo.fileHandle) return;
      const emails = await emailAnalyzer.getEmailsForSubjectOptimized(
        fileInfo.fileHandle,
        subjectInfo
      );
      if (!emails || emails.length === 0) return;
      const lastEmail = [...emails].sort((a, b) => (b.date || 0) - (a.date || 0))[0];

      // Exit chat mode first so the reply form is visible in the normal email-detail modal
      const { exitChatMode } = await import('./aiChatUI.js');
      exitChatMode();

      // Open email detail modal first, then reply form
      const { showEmailDetail } = await import('./email-detail.js');
      showEmailDetail(lastEmail);
      // Small timeout so the modal is rendered before the reply form opens
      setTimeout(() => {
        showReplyForm(lastEmail, 'reply', { prefilledBody: text });
      }, 150);
    },
  });

  // Get the URL parameters
  const urlParams = new URLSearchParams(window.location.search);
  const provider = urlParams.get('provider');
  const email = urlParams.get('email');

  // Manage the interface based on sign-in state
  if (provider && email) {
    await initConnectedInterface(provider, email);
  } else {
    initLoginInterface();
  }
}

// Initialise the signed-out interface
function initLoginInterface() {
  const statusDiv = document.getElementById('status');
  const downloadEmailsBtn = document.getElementById('downloadEmailsBtn');

  statusDiv.textContent = 'Not signed in.';
  showLoginInterface();

  if (downloadEmailsBtn) downloadEmailsBtn.style.display = 'none';
}

/**
 * Demo mode: we reuse the connected flow as-is, skipping anything that writes
 * to or talks to the server (fetchEmails, restoreFolder, polling, download,
 * filters, groups, AI). No file, no IndexedDB entry, no handle.
 */
async function initDemoInterface() {
  const provider = DEMO_PROVIDER;
  const email = DEMO_USER_ID;

  // Modules read the identity from the URL (provider / email). We set it
  // without navigating so they work unmodified.
  const url = new URL(window.location.href);
  url.searchParams.set('provider', provider);
  url.searchParams.set('email', email);
  window.history.replaceState(null, '', url.toString());

  showDemoBanner();

  const statusDiv = document.getElementById('status');
  if (statusDiv) statusDiv.textContent = `Demo mode — ${email}`;

  showConnectedInterface(provider, email);
  applyDemoReadOnlyUI();

  showLoadingOverlay('Loading the sample dataset...', 0);

  // Refreshing the tree from the notification banner re-selects the subject.
  initTreeNotificationBanner(async (subject) => {
    await analysisSelectSubject(emailAnalyzer, treeVisualization, subject, provider, email);
  });

  analysisLaunched = true;
  const ok = await autoAnalyzeConversations(emailAnalyzer, treeVisualization, provider, email);
  if (!ok) hideLoadingOverlay();
}

// Initialise the connected interface
async function initConnectedInterface(provider, email) {
  const statusDiv = document.getElementById('status');

  statusDiv.textContent = `Signed in to ${provider} as ${email}`;

  // Show the connected interface
  showConnectedInterface(provider, email);

  // Show the loading overlay right from the start
  showLoadingOverlay('Reading emails...', 0);

  // Show the loading bar for reading emails
  const loadingAnalysis = document.getElementById('loadingAnalysis');
  loadingAnalysis.style.display = 'block';
  document.getElementById('loadingPercentage').textContent = '0%';
  document.getElementById('loadingProgress').style.width = '0%';
  const loadingTextSpan = document.querySelector('#loadingAnalysis .loading-text');
  if (loadingTextSpan) {
    loadingTextSpan.innerHTML = '<span id="loadingPercentage">0%</span> - Reading emails...';
  }

  // Get the IDs and the first 20 emails to display
  // (the analysis is triggered below, after the sync, not from fetchEmails)
  await fetchEmails(provider, email);

  // Initialise the folder handlers
  const userId = email;
  initFolderHandlers(userId, async () => {
    // Callback fired when a new folder is manually selected.
    // A manual selection is an explicit request to (re)load this folder:
    // we ALWAYS relaunch the analysis, even if an automatic attempt already
    // happened on load (e.g. a handle with no permission, or the wrong folder
    // level chosen on the first try → that attempt failed). Without this, the
    // analysisLaunched flag staying true would block any new analysis.
    if (provider && email) {
      analysisLaunched = true;
      console.log('🔄 New folder selected - Relaunching the analysis...');
      setTimeout(
        () => autoAnalyzeConversations(emailAnalyzer, treeVisualization, provider, email),
        500
      );
    }
  });

  // Initialise the download and update handler
  initDownloadHandler(provider, email);

  // Initialise the filters interface
  await initFilterUI();

  // When a subject is restored from the blocklist, re-download its emails
  setOnSubjectRestored(async (restoredSubject) => {
    console.log(`🔄 Subject restored: "${restoredSubject}" — re-downloading in the background...`);
    const hasDownloaded = await redownloadMissingEmails(provider, email);
    if (hasDownloaded) {
      // Refresh analysis to show the restored subject
      analysisLaunched = false;
      await autoAnalyzeConversations(emailAnalyzer, treeVisualization, provider, email);
      analysisLaunched = true;
    }
  });

  // Restore the folder on load
  await restoreFolder(userId);

  // Start light polling (a "new emails" badge every 5 min)
  // Polling runs an immediate first check, without downloading anything.
  startEmailPolling(provider, userId);

  // Initialise the groups context menu
  initGroupContextMenu();

  // Initialize tree notification banner (refresh re-selects the current subject)
  initTreeNotificationBanner(async (subject) => {
    await analysisSelectSubject(emailAnalyzer, treeVisualization, subject, provider, email);
  });

  // Run the analysis on the existing JSONL file
  if (!analysisLaunched) {
    analysisLaunched = true;
    setTimeout(
      () => autoAnalyzeConversations(emailAnalyzer, treeVisualization, provider, email),
      500
    );
  }
}

// Retrieve emails from the server
async function fetchEmails(provider) {
  const emailsDiv = document.getElementById('emails');
  const downloadEmailsBtn = document.getElementById('downloadEmailsBtn');

  let fetchUrl = '';
  if (provider === 'gmail') fetchUrl = '/gmail/emails';
  else if (provider === 'outlook') fetchUrl = '/outlook/emails';
  else return;

  try {
    // Get the current filters from filterUI
    const { getCurrentFilters } = await import('./filterUI.js');
    const filters = getCurrentFilters();

    console.log('📋 Filters sent to retrieve emails:', filters);

    // Send the filters as a query string (original format)
    const filtersParam = filters ? encodeURIComponent(JSON.stringify(filters)) : '';
    let fetchUrlWithFilters = filtersParam ? `${fetchUrl}?filters=${filtersParam}` : fetchUrl;

    // Add the custom date filter if active
    if (filters && filters.useCustomAfterDate && filters.customAfterDate) {
      const afterDateMs = new Date(filters.customAfterDate).getTime();
      const separator = fetchUrlWithFilters.includes('?') ? '&' : '?';
      fetchUrlWithFilters += `${separator}afterDate=${afterDateMs}`;
      console.log(`📅 Date filter active: after ${filters.customAfterDate}`);
    }

    const response = await fetch(fetchUrlWithFilters);
    const data = await response.json();

    if (data.displayEmails && Array.isArray(data.displayEmails)) {
      // New format, separating display from download
      availableMessageIds = data.messageIds || [];

      // Update the counter in the left-hand panel
      if (data.totalAvailable > 0) {
        document.getElementById('emailCount').textContent = data.totalAvailable;

        // Update the download button's badge
        const emailCountBadge = document.getElementById('emailCountBadge');
        if (emailCountBadge) {
          emailCountBadge.textContent = data.totalAvailable;
        }

        // Simulate the reading progress
        simulateReadProgress();

        downloadEmailsBtn.style.display = 'block';
        // The analysis is triggered from initConnectedInterface, after the sync
      } else {
        document.getElementById('emailCount').textContent = '0';
        hideLoadingOverlay();
        downloadEmailsBtn.style.display = 'none';
      }
    } else if (Array.isArray(data)) {
      // Old format (fallback)
      availableMessageIds = data.map((e) => ({
        id: e.id,
        type: e.type,
      }));

      if (data.length > 0) {
        document.getElementById('emailCount').textContent = data.length;
        simulateReadProgress();
        downloadEmailsBtn.style.display = 'inline-block';
        // The analysis is triggered from initConnectedInterface, after the sync
      } else {
        document.getElementById('emailCount').textContent = '0';
        hideLoadingOverlay();
        downloadEmailsBtn.style.display = 'none';
      }
    } else {
      hideLoadingOverlay();
      emailsDiv.textContent = data.error || 'Error retrieving emails';
      downloadEmailsBtn.style.display = 'none';
    }

    // Hide the emails div in the central panel
    emailsDiv.innerHTML = '';
  } catch (error) {
    hideLoadingOverlay();
    emailsDiv.innerHTML = '';
    document.getElementById('emailCount').textContent = '0';
    downloadEmailsBtn.style.display = 'none';
  }
}

// Simulate the reading progress
function simulateReadProgress() {
  let readProgress = 0;
  const readInterval = setInterval(() => {
    readProgress += Math.random() * 20;
    if (readProgress > 100) readProgress = 100;
    document.getElementById('loadingProgress').style.width = readProgress + '%';
    document.getElementById('loadingPercentage').textContent = Math.round(readProgress) + '%';
    // Update the overlay (phase 1: 0-50%)
    updateLoadingOverlay('Reading emails...', readProgress * 0.5);
    if (readProgress >= 100) {
      clearInterval(readInterval);
    }
  }, 100);

  setTimeout(() => {
    clearInterval(readInterval);
    document.getElementById('loadingProgress').style.width = '100%';
    document.getElementById('loadingPercentage').textContent = '100%';
    updateLoadingOverlay('Emails loaded, preparing the analysis...', 50);
  }, 1000);
}

// Initialise the download and update handler
function initDownloadHandler(provider, email) {
  const downloadEmailsBtn = document.getElementById('downloadEmailsBtn');
  const updateEmailsBtn = document.getElementById('updateEmailsBtn');

  // When filters are saved, retrieve the IDs again with the new filters
  setOnFiltersSaved(() => {
    console.log('🔄 Filters changed — retrieving IDs again...');
    fetchEmails(provider, email);
  });

  // Full download
  downloadEmailsBtn.onclick = async () => {
    clearTreeNotification();

    await downloadEmails(availableMessageIds, provider, email, {
      onMilestone: (emails, milestoneOptions) => {
        incrementalAnalyze(emailAnalyzer, emails, milestoneOptions);
      },
      milestoneInterval: 1000,
    });

    // Final analysis from JSONL file (canonical source) after download completes
    console.log('📊 Download complete — final analysis in 2.5s');
    setTimeout(async () => {
      analysisLaunched = false;
      await autoAnalyzeConversations(emailAnalyzer, treeVisualization, provider, email);
      analysisLaunched = true;
    }, 2500);
  };

  // Forced incremental update (manual button)
  if (updateEmailsBtn) {
    updateEmailsBtn.style.display = 'block';
    updateEmailsBtn.onclick = async () => {
      updateEmailsBtn.disabled = true;
      updateEmailsBtn.querySelector('.btn-text').textContent = 'Updating...';
      try {
        const hasSynced = await syncEmails(provider, email);
        if (hasSynced) {
          // Reset the badge to 0: we just synced everything
          updateNewEmailsBadge(0);
          // Relaunch the analysis to show the new emails
          analysisLaunched = false;
          await autoAnalyzeConversations(emailAnalyzer, treeVisualization, provider, email);
          analysisLaunched = true;
        } else {
          toastSuccess('Your emails are already up to date.');
        }
      } finally {
        updateEmailsBtn.disabled = false;
        updateEmailsBtn.querySelector('.btn-text').textContent = 'Update';
      }
    };
  }
}

// Inject the subject selection handler into analysis.js (avoids window.* coupling)
setSelectSubjectHandler(async (subject) => {
  const urlParams = new URLSearchParams(window.location.search);
  const provider = urlParams.get('provider') || 'gmail';
  const email = urlParams.get('email');

  await analysisSelectSubject(emailAnalyzer, treeVisualization, subject, provider, email);
});

console.log('✅ app.js module loaded');
