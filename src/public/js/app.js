/**
 * Module principal de l'application
 * Orchestre tous les autres modules
 */

// Import des modules
import emailAnalyzer from "/services/emailAnalyzer_browser.js";
import treeVisualization, { setNodeClickHandler } from "./treeRenderer.js";
import { setupFetchInterceptor, initLoginButtons } from './auth.js';
import { showLoadingOverlay, hideLoadingOverlay, updateLoadingOverlay, showConnectedInterface, showLoginInterface, initUIEvents } from './ui.js';
import { initPanelResizers } from './panels.js';
import { initFolderHandlers, restoreFolder, getEmailFileHandle } from './folders.js';
import { downloadEmails, syncEmails, startEmailPolling, updateNewEmailsBadge, redownloadMissingEmails } from './emails.js';
import { autoAnalyzeConversations, selectSubject as analysisSelectSubject, getEmailById, setSelectSubjectHandler, incrementalAnalyze, initTreeNotificationBanner, clearTreeNotification } from './analysis.js';
import { showEmailDetail } from './email-detail.js';
import { initFilterUI, setOnFiltersSaved, setOnSubjectRestored } from './filterUI.js';
import { initGroupContextMenu } from './groupContextMenu.js';
import { restoreTheme, buildThemePicker } from './themeManager.js';
import { toastSuccess } from './toast.js';
import { initAIPanel } from './aiPanel.js';
import { initChatUI } from './aiChatUI.js';

// Connecter showEmailDetail au treeRenderer (remplace window.showEmailDetail)
setNodeClickHandler(showEmailDetail);

// Restaurer le thème sauvegardé avant le premier paint
restoreTheme();


// Variables globales de l'état de l'application
let lastFetchedEmails = [];
let analysisLaunched = false;
let availableMessageIds = [];

// === INITIALISATION AU CHARGEMENT ===
document.addEventListener('DOMContentLoaded', initApp);

async function initApp() {
  // Détection navigateur non supporté (plan SaaS 1.5 — File System Access API)
  if (typeof window.showDirectoryPicker !== 'function') {
    const unsupportedEl = document.getElementById('unsupportedBrowser');
    const loginEl = document.getElementById('loginInterface');
    const appEl = document.getElementById('appInterface');
    if (unsupportedEl) unsupportedEl.style.display = 'flex';
    if (loginEl) loginEl.style.display = 'none';
    if (appEl) appEl.style.display = 'none';
    return;
  }

  console.log("🚀 Initialisation de l'application");
  
  // Configurer l'intercepteur fetch pour la gestion des sessions
  setupFetchInterceptor();
  
  // Initialiser les boutons de connexion
  initLoginButtons();
  
  // Initialiser les resizers de panneaux
  initPanelResizers();
  
  // Initialiser les événements UI (tiroirs, boutons actions, etc.) sans inline onclick
  initUIEvents();

  // Construire le sélecteur de thèmes
  buildThemePicker();

  // Initialiser le panneau de configuration IA
  initAIPanel();

  // Initialiser l'UI de chat IA
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
      const emails = await emailAnalyzer.getEmailsForSubjectOptimized(fileInfo.fileHandle, subjectInfo);
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
    }
  });

  // Récupérer les paramètres URL
  const urlParams = new URLSearchParams(window.location.search);
  const provider = urlParams.get("provider");
  const email = urlParams.get("email");
  
  // Gérer l'interface selon l'état de connexion
  if (provider && email) {
    await initConnectedInterface(provider, email);
  } else {
    initLoginInterface();
  }
}

// Initialiser l'interface non connectée
function initLoginInterface() {
  const statusDiv = document.getElementById("status");
  const downloadEmailsBtn = document.getElementById("downloadEmailsBtn");
  
  statusDiv.textContent = "Non connecté.";
  showLoginInterface();
  
  if (downloadEmailsBtn) downloadEmailsBtn.style.display = "none";
}

// Initialiser l'interface connectée
async function initConnectedInterface(provider, email) {
  const statusDiv = document.getElementById("status");
  
  statusDiv.textContent = `Connecté à ${provider} en tant que ${email}`;
  
  // Afficher l'interface connectée
  showConnectedInterface(provider, email);
  
  // Afficher l'overlay de chargement dès le début
  showLoadingOverlay("Lecture des emails en cours...", 0);
  
  // Afficher la barre de chargement pour la lecture des emails
  const loadingAnalysis = document.getElementById("loadingAnalysis");
  loadingAnalysis.style.display = "block";
  document.getElementById("loadingPercentage").textContent = "0%";
  document.getElementById("loadingProgress").style.width = "0%";
  const loadingTextSpan = document.querySelector(
    "#loadingAnalysis .loading-text"
  );
  if (loadingTextSpan) {
    loadingTextSpan.innerHTML =
      '<span id="loadingPercentage">0%</span> - Lecture des mails...';
  }
  
  // Récupérer les IDs et les 20 premiers emails pour affichage
  // (l'analyse est déclenchée ci-dessous, après la sync, pas depuis fetchEmails)
  await fetchEmails(provider, email);
  
  // Initialiser les handlers de dossiers
  const userId = email;
  initFolderHandlers(userId, async () => {
    // Callback appelé quand un nouveau dossier est sélectionné manuellement.
    // Une sélection manuelle est une demande explicite de (re)charger ce dossier :
    // on relance TOUJOURS l'analyse, même si une tentative automatique a déjà eu
    // lieu au chargement (ex. handle sans permission, ou mauvais niveau de dossier
    // choisi au premier essai → cette tentative a échoué). Sans ça, le drapeau
    // analysisLaunched resté à true bloquait toute nouvelle analyse.
    if (provider && email) {
      analysisLaunched = true;
      console.log("🔄 Nouveau dossier sélectionné - Relancement de l'analyse...");
      setTimeout(() => autoAnalyzeConversations(emailAnalyzer, treeVisualization, provider, email), 500);
    }
  });
  
  // Initialiser le gestionnaire de téléchargement et de mise à jour
  initDownloadHandler(provider, email);
  
  // Initialiser l'interface des filtres
  await initFilterUI();

  // When a subject is restored from the blacklist, re-download its emails
  setOnSubjectRestored(async (restoredSubject) => {
    console.log(`🔄 Sujet rétabli: "${restoredSubject}" — re-téléchargement en fond...`);
    const hasDownloaded = await redownloadMissingEmails(provider, email);
    if (hasDownloaded) {
      // Refresh analysis to show the restored subject
      analysisLaunched = false;
      await autoAnalyzeConversations(emailAnalyzer, treeVisualization, provider, email);
      analysisLaunched = true;
    }
  });

  // Restaurer le dossier au chargement
  await restoreFolder(userId);

  // Démarrer le polling léger (badge "nouveaux emails" toutes les 5 min)
  // Le polling lance un premier check immédiat, sans rien télécharger.
  startEmailPolling(provider, userId);

  // Initialiser le menu contextuel des groupes
  initGroupContextMenu();

  // Initialize tree notification banner (refresh re-selects the current subject)
  initTreeNotificationBanner(async (subject) => {
    await analysisSelectSubject(emailAnalyzer, treeVisualization, subject, provider, email);
  });

  // Lancer l'analyse du JSONL existant
  if (!analysisLaunched) {
    analysisLaunched = true;
    setTimeout(() => autoAnalyzeConversations(emailAnalyzer, treeVisualization, provider, email), 500);
  }
}

// Récupérer les emails depuis le serveur
async function fetchEmails(provider, email) {
  const emailsDiv = document.getElementById("emails");
  const downloadEmailsBtn = document.getElementById("downloadEmailsBtn");
  
  let fetchUrl = "";
  if (provider === "gmail") fetchUrl = "/gmail/emails";
  else if (provider === "outlook") fetchUrl = "/outlook/emails";
  else return;
  
  try {
    // Récupérer les filtres actuels depuis filterUI
    const { getCurrentFilters } = await import('./filterUI.js');
    const filters = getCurrentFilters();
    
    console.log('📋 Filtres envoyés pour la récupération des emails:', filters);

    // Envoyer les filtres en query string (format original)
    const filtersParam = filters ? encodeURIComponent(JSON.stringify(filters)) : '';
    let fetchUrlWithFilters = filtersParam ? `${fetchUrl}?filters=${filtersParam}` : fetchUrl;

    // Ajouter le filtre de date personnalisée si actif
    if (filters && filters.useCustomAfterDate && filters.customAfterDate) {
      const afterDateMs = new Date(filters.customAfterDate).getTime();
      const separator = fetchUrlWithFilters.includes('?') ? '&' : '?';
      fetchUrlWithFilters += `${separator}afterDate=${afterDateMs}`;
      console.log(`📅 Filtre date actif: après ${filters.customAfterDate}`);
    }
    
    const response = await fetch(fetchUrlWithFilters);
    const data = await response.json();
    
    if (data.displayEmails && Array.isArray(data.displayEmails)) {
      // Nouveau format avec séparation affichage/téléchargement
      lastFetchedEmails = data.displayEmails;
      availableMessageIds = data.messageIds || [];
      
      // Mettre à jour le compteur dans le panneau gauche
      if (data.totalAvailable > 0) {
        document.getElementById("emailCount").textContent =
          data.totalAvailable;
        
        // Mettre à jour le badge du bouton de téléchargement
        const emailCountBadge = document.getElementById("emailCountBadge");
        if (emailCountBadge) {
          emailCountBadge.textContent = data.totalAvailable;
        }
        
        // Simuler la progression de lecture
        simulateReadProgress();
        
        downloadEmailsBtn.style.display = "block";
        // L'analyse sera déclenchée depuis initConnectedInterface, après la sync
      } else {
        document.getElementById("emailCount").textContent = "0";
        hideLoadingOverlay();
        downloadEmailsBtn.style.display = "none";
      }
    } else if (Array.isArray(data)) {
      // Ancien format (fallback)
      lastFetchedEmails = data;
      availableMessageIds = data.map((e) => ({
        id: e.id,
        type: e.type,
      }));
      
      if (data.length > 0) {
        document.getElementById("emailCount").textContent = data.length;
        simulateReadProgress();
        downloadEmailsBtn.style.display = "inline-block";
        // L'analyse sera déclenchée depuis initConnectedInterface, après la sync
      } else {
        document.getElementById("emailCount").textContent = "0";
        hideLoadingOverlay();
        downloadEmailsBtn.style.display = "none";
      }
    } else {
      hideLoadingOverlay();
      emailsDiv.textContent =
        data.error || "Erreur lors de la récupération des emails";
      downloadEmailsBtn.style.display = "none";
    }
    
    // Masquer le div emails dans le panneau central
    emailsDiv.innerHTML = "";
  } catch (error) {
    hideLoadingOverlay();
    emailsDiv.innerHTML = "";
    document.getElementById("emailCount").textContent = "0";
    downloadEmailsBtn.style.display = "none";
  }
}

// Simuler la progression de lecture
function simulateReadProgress() {
  let readProgress = 0;
  const readInterval = setInterval(() => {
    readProgress += Math.random() * 20;
    if (readProgress > 100) readProgress = 100;
    document.getElementById("loadingProgress").style.width =
      readProgress + "%";
    document.getElementById("loadingPercentage").textContent =
      Math.round(readProgress) + "%";
    // Mettre à jour l'overlay (phase 1: 0-50%)
    updateLoadingOverlay(
      "Lecture des emails en cours...",
      readProgress * 0.5
    );
    if (readProgress >= 100) {
      clearInterval(readInterval);
    }
  }, 100);
  
  setTimeout(() => {
    clearInterval(readInterval);
    document.getElementById("loadingProgress").style.width =
      "100%";
    document.getElementById("loadingPercentage").textContent =
      "100%";
    updateLoadingOverlay(
      "Emails chargés, préparation de l'analyse...",
      50
    );
  }, 1000);
}

// Initialiser le gestionnaire de téléchargement et de mise à jour
function initDownloadHandler(provider, email) {
  const downloadEmailsBtn = document.getElementById("downloadEmailsBtn");
  const updateEmailsBtn = document.getElementById("updateEmailsBtn");

  // Quand les filtres sont sauvegardés, re-récupérer les IDs avec les nouveaux filtres
  setOnFiltersSaved(() => {
    console.log('🔄 Filtres modifiés — re-récupération des IDs...');
    fetchEmails(provider, email);
  });

  // Téléchargement complet
  downloadEmailsBtn.onclick = async () => {
    clearTreeNotification();

    await downloadEmails(availableMessageIds, provider, email, {
      onMilestone: (emails, milestoneOptions) => {
        incrementalAnalyze(emailAnalyzer, emails, milestoneOptions);
      },
      milestoneInterval: 1000
    });

    // Final analysis from JSONL file (canonical source) after download completes
    console.log("📊 Téléchargement terminé — analyse finale dans 2.5s");
    setTimeout(async () => {
      analysisLaunched = false;
      await autoAnalyzeConversations(emailAnalyzer, treeVisualization, provider, email);
      analysisLaunched = true;
    }, 2500);
  };

  // Mise à jour incrémentale forcée (bouton manuel)
  if (updateEmailsBtn) {
    updateEmailsBtn.style.display = "block";
    updateEmailsBtn.onclick = async () => {
      updateEmailsBtn.disabled = true;
      updateEmailsBtn.querySelector('.btn-text').textContent = 'Mise à jour...';
      try {
        const hasSynced = await syncEmails(provider, email);
        if (hasSynced) {
          // Remettre le badge à 0 : on vient de tout synchroniser
          updateNewEmailsBadge(0);
          // Relancer l'analyse pour afficher les nouveaux emails
          analysisLaunched = false;
          await autoAnalyzeConversations(emailAnalyzer, treeVisualization, provider, email);
          analysisLaunched = true;
        } else {
          toastSuccess('Vos emails sont d\u00e9j\u00e0 \u00e0 jour.');
        }
      } finally {
        updateEmailsBtn.disabled = false;
        updateEmailsBtn.querySelector('.btn-text').textContent = 'Mettre à jour';
      }
    };
  }
}

// Injecter le handler de sélection de sujet dans analysis.js (évite le couplage via window.*)
setSelectSubjectHandler(async (subject) => {
  const urlParams = new URLSearchParams(window.location.search);
  const provider = urlParams.get("provider") || "gmail";
  const email = urlParams.get("email");

  await analysisSelectSubject(emailAnalyzer, treeVisualization, subject, provider, email);
});

console.log("✅ Module app.js chargé");

