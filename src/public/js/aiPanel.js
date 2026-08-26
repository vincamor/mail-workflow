/**
 * Module du panneau de configuration IA
 * Connecte le HTML au module aiConfig.js
 */

import { getAIConfig, saveAIConfig, getProviderDefaults, testAIConnection } from './aiConfig.js';
import { startAIFiltering } from './aiFilter.js';
import { renderFilterReport, renderProgress, closeReport } from './aiFilterReport.js';
import { getCurrentSubjects } from './analysis.js';

export function initAIPanel() {
  const providerSelect = document.getElementById('aiProvider');
  const baseUrlInput = document.getElementById('aiBaseUrl');
  const apiKeyInput = document.getElementById('aiApiKey');
  const modelInput = document.getElementById('aiModel');
  const testBtn = document.getElementById('aiTestBtn');
  const saveBtn = document.getElementById('aiSaveBtn');
  const toggleKeyBtn = document.getElementById('aiToggleKeyVisibility');
  const testResult = document.getElementById('aiTestResult');

  if (!providerSelect) return;

  // Restore saved config
  const config = getAIConfig();
  providerSelect.value = config.provider;
  baseUrlInput.value = config.baseUrl;
  apiKeyInput.value = config.apiKey;
  modelInput.value = config.model;

  // Sous-drawer Configuration : repli par defaut si deja configure
  const configSubdrawer = document.getElementById('aiConfigSubdrawer');
  const configSubdrawerHeader = document.getElementById('aiConfigSubdrawerHeader');
  if (configSubdrawer && configSubdrawerHeader) {
    if (!config.apiKey) {
      configSubdrawer.classList.remove('closed');
    }
    const syncSubdrawerAria = () => {
      configSubdrawerHeader.setAttribute(
        'aria-expanded',
        String(!configSubdrawer.classList.contains('closed'))
      );
    };
    const toggleSubdrawer = () => {
      configSubdrawer.classList.toggle('closed');
      syncSubdrawerAria();
    };
    syncSubdrawerAria();
    configSubdrawerHeader.addEventListener('click', toggleSubdrawer);
    configSubdrawerHeader.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleSubdrawer();
      }
    });
  }

  // Provider change updates defaults
  providerSelect.addEventListener('change', () => {
    const defaults = getProviderDefaults(providerSelect.value);
    baseUrlInput.value = defaults.baseUrl;
    baseUrlInput.placeholder = defaults.baseUrl || 'https://...';
    modelInput.value = defaults.model;
    modelInput.placeholder = defaults.placeholder;
    testResult.style.display = 'none';
  });

  // Toggle API key visibility
  toggleKeyBtn.addEventListener('click', () => {
    apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
  });

  // Save
  saveBtn.addEventListener('click', () => {
    const newConfig = {
      provider: providerSelect.value,
      baseUrl: baseUrlInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      model: modelInput.value.trim(),
    };
    saveAIConfig(newConfig);
    testResult.textContent = 'Configuration sauvegardee';
    testResult.className = 'ai-test-result ai-test-success';
    testResult.style.display = 'block';
    setTimeout(() => {
      testResult.style.display = 'none';
    }, 3000);
  });

  // Test connection
  testBtn.addEventListener('click', async () => {
    const currentConfig = {
      provider: providerSelect.value,
      baseUrl: baseUrlInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      model: modelInput.value.trim(),
    };

    testBtn.disabled = true;
    testBtn.textContent = 'Test en cours...';
    testResult.style.display = 'none';

    const result = await testAIConnection(currentConfig);

    testResult.textContent = result.message;
    testResult.className = result.ok
      ? 'ai-test-result ai-test-success'
      : 'ai-test-result ai-test-error';
    testResult.style.display = 'block';

    testBtn.disabled = false;
    testBtn.textContent = 'Tester la connexion';
  });

  // Bouton "Faire le Menage"
  const filterBtn = document.getElementById('aiFilterBtn');
  if (filterBtn) {
    const syncFilterBtnState = () => {
      const key = apiKeyInput.value.trim();
      filterBtn.disabled = !key;
      filterBtn.title = key ? '' : "Configurez d'abord votre provider IA";
    };

    // Etat initial base sur la config sauvegardee
    syncFilterBtnState();

    // Mettre a jour l'etat du bouton quand la cle change (saisie, collage, changement de provider)
    apiKeyInput.addEventListener('input', syncFilterBtnState);
    saveBtn.addEventListener('click', syncFilterBtnState);
    providerSelect.addEventListener('change', syncFilterBtnState);

    filterBtn.addEventListener('click', async () => {
      const subjects = getCurrentSubjects();
      if (!subjects || subjects.length === 0) {
        testResult.textContent = "Aucun sujet a analyser. Telechargez d'abord vos emails.";
        testResult.className = 'ai-test-result ai-test-error';
        testResult.style.display = 'block';
        return;
      }

      filterBtn.disabled = true;
      filterBtn.textContent = 'Analyse en cours...';

      try {
        const emailAnalyzer = (await import('/services/emailAnalyzer_browser.js')).default;
        const { getEmailFileHandle } = await import('./folders.js');

        // Recuperer le provider et userId depuis l'URL
        const urlParams = new URLSearchParams(window.location.search);
        const provider = urlParams.get('provider') || 'gmail';
        const userId = urlParams.get('email');
        const fileInfo = await getEmailFileHandle(userId, provider);

        const getEmailsForSubject = async (subjectInfo) => {
          if (!fileInfo || !fileInfo.fileHandle) return [];
          try {
            return await emailAnalyzer.getEmailsForSubjectOptimized(
              fileInfo.fileHandle,
              subjectInfo
            );
          } catch (e) {
            console.warn('Erreur chargement mails pour "' + subjectInfo.subject + '":', e);
            return [];
          }
        };

        const results = await startAIFiltering(subjects, getEmailsForSubject, (progress) => {
          renderProgress(progress);
        });

        renderFilterReport(results);
      } catch (err) {
        closeReport();
        testResult.textContent = 'Erreur filtrage IA: ' + err.message;
        testResult.className = 'ai-test-result ai-test-error';
        testResult.style.display = 'block';
      } finally {
        filterBtn.disabled = false;
        filterBtn.textContent = '\u{1F9F9} Faire le Menage';
      }
    });
  }

  // Bouton "Discuter du sujet"
  const chatBtn = document.getElementById('aiChatBtn');
  let hasSelectedSubject = false;

  const syncChatBtnState = () => {
    const key = apiKeyInput.value.trim();
    const enabled = !!key && hasSelectedSubject;
    if (chatBtn) {
      chatBtn.disabled = !enabled;
      chatBtn.title = enabled
        ? 'Ouvrir le chat IA'
        : !key
          ? "Configurez d'abord le provider IA"
          : "Selectionnez un sujet d'abord";
    }
  };

  apiKeyInput.addEventListener('input', syncChatBtnState);
  saveBtn.addEventListener('click', syncChatBtnState);

  import('./analysis.js').then(({ onSubjectSelected }) => {
    onSubjectSelected((subjectKey, subjectInfo) => {
      hasSelectedSubject = !!subjectKey;
      window.__currentChatSubjectInfo = subjectInfo;
      window.__currentChatSubjectKey = subjectKey;
      syncChatBtnState();
    });
  });

  if (chatBtn) {
    chatBtn.addEventListener('click', async () => {
      if (chatBtn.disabled) return;
      const { enterChatMode } = await import('./aiChatUI.js');
      enterChatMode(window.__currentChatSubjectKey, window.__currentChatSubjectInfo);
    });
  }

  syncChatBtnState();
}
