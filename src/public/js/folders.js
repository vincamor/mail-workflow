/**
 * Module de gestion des dossiers locaux (FileSystem Handle API)
 */

import { storeFolderHandle, restoreFolderHandle, openDB } from './storage.js';
import { toastError } from './toast.js';
import { resolveUserFolderHandle } from './folderResolver.js';
import { isDemoMode, getDemoEmailFileHandle } from './demo.js';

// Handle du dossier actuel
let currentFolderHandle = null;
// Handle en attente de reautorisation (permission 'prompt' au chargement)
let pendingReauthHandle = null;

export function getCurrentFolderHandle() {
  return currentFolderHandle;
}

export function hasPendingReauth() {
  return pendingReauthHandle !== null;
}

export function setCurrentFolderHandle(handle) {
  currentFolderHandle = handle;
}

// Fonction pour obtenir le handle du fichier JSONL
export async function getEmailFileHandle(userId, provider = 'gmail') {
  // Mode demo : dataset embarque servi en HTTP, lu via un faux handle qui
  // duck-type FileSystemFileHandle. Aucun dossier local n'est requis.
  if (isDemoMode()) {
    return await getDemoEmailFileHandle(provider);
  }

  try {
    if (!currentFolderHandle) {
      console.error('Aucun dossier sélectionné');
      return null;
    }

    const fileName = `${provider}_emails.jsonl`;
    // Résolution tolérante : accepte racine, dossier EmailWorkflow ou dossier compte.
    const userFolderHandle = await resolveUserFolderHandle(currentFolderHandle, userId, {
      create: false,
    });
    if (!userFolderHandle) {
      return { fileHandle: null, fileName, exists: false };
    }
    const fileHandle = await userFolderHandle.getFileHandle(fileName);

    return {
      fileHandle: fileHandle,
      fileName: fileName,
      exists: true,
    };
  } catch (e) {
    console.log(`Fichier ${provider}_emails.jsonl non trouvé:`, e);
    return {
      fileHandle: null,
      fileName: `${provider}_emails.jsonl`,
      exists: false,
    };
  }
}

// Fonction utilitaire pour analyser les emails de manière optimisée
export async function analyzeEmailFile(fileHandle) {
  try {
    const file = await fileHandle.getFile();
    if (file.size === 0) return { exists: false, emailCount: 0, emailIds: new Set() };

    // Lecture streaming : évite de charger tout le fichier en une seule string.
    // On extrait uniquement l'ID de chaque ligne — l'objet complet (bodyHtml,
    // originalPayload, bodyText…) est éligible au GC immédiatement après le parse.
    const emailIds = new Set();
    let emailCount = 0;
    const stream = file.stream();
    const textDecoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of stream) {
      buffer += textDecoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const email = JSON.parse(line);
          const emailId = email.id || email.messageId;
          if (emailId) {
            emailIds.add(emailId);
            emailCount++;
          }
        } catch (e) {
          console.warn('Ligne malformée ignorée:', line.substring(0, 50));
        }
      }
    }

    // Dernière ligne si elle ne se terminait pas par \n
    if (buffer.trim()) {
      try {
        const email = JSON.parse(buffer);
        const emailId = email.id || email.messageId;
        if (emailId) {
          emailIds.add(emailId);
          emailCount++;
        }
      } catch (e) {
        /* ligne malformée ignorée */
      }
    }

    return {
      exists: true,
      emailCount,
      emailIds,
    };
  } catch (e) {
    return { exists: false, emailCount: 0, emailIds: new Set() };
  }
}

// Fonction pour obtenir des statistiques détaillées sur les emails
export function getEmailStats(emails) {
  if (!emails || emails.length === 0) return null;

  const dates = emails
    .map((email) => {
      const date = email.internalDate || email.receivedDateTime || email.date;
      return date ? new Date(date) : null;
    })
    .filter((date) => date && !isNaN(date.getTime()));

  if (dates.length === 0) return null;

  const oldestDate = new Date(Math.min(...dates));
  const newestDate = new Date(Math.max(...dates));

  return {
    count: emails.length,
    dateRange: {
      oldest: oldestDate,
      newest: newestDate,
      span: Math.ceil((newestDate - oldestDate) / (1000 * 60 * 60 * 24)), // jours
    },
  };
}

// UI - Modal et info dossier
export function showFolderInfo(_folderName) {
  document.getElementById('folderSection').style.display = 'block';
  // currentFolderName n'existe plus dans la nouvelle interface
  // Le nom est géré par currentFolderPath dans updateFolderStatus
}

export function hideFolderInfo() {
  document.getElementById('folderSection').style.display = 'none';
}

// Initialiser les handlers de dossiers
export function initFolderHandlers(userId, onFolderSelected) {
  const changeFolderBtn = document.getElementById('changeFolderBtn');

  if (!changeFolderBtn) {
    console.error('Bouton changeFolderBtn non trouvé');
    return;
  }

  // Changer de dossier (nouvelle interface)
  changeFolderBtn.onclick = async () => {
    // Cas special : reautorisation d'un handle en attente (permission 'prompt')
    // Le clic fournit l'activation utilisateur requise par requestPermission()
    if (pendingReauthHandle) {
      try {
        const perm = await pendingReauthHandle.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          const handle = pendingReauthHandle;
          pendingReauthHandle = null;
          currentFolderHandle = handle;
          console.log(`✅ Reautorisation accordee pour: ${handle.name}`);
          showFolderInfo(handle.name);
          updateFolderStatus(handle);
          showStep2();
          showStep3();
          enableDownloadButton();
          if (onFolderSelected) onFolderSelected();
          return;
        }
        console.log('⚠️ Reautorisation refusee, ouverture du picker');
      } catch (e) {
        console.warn('⚠️ Erreur reautorisation, ouverture du picker:', e);
      }
      pendingReauthHandle = null;
      // Fall through vers le picker classique
    }

    try {
      const folderHandle = await window.showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'documents',
      });

      // Stocker le handle dans IndexedDB
      const stored = await storeFolderHandle(userId, folderHandle);

      if (stored) {
        currentFolderHandle = folderHandle;
        console.log(`✅ Dossier sélectionné: ${folderHandle.name}`);

        // Mettre à jour l'interface visuelle
        updateFolderStatus(folderHandle);

        // Activer les étapes suivantes
        showStep2();
        showStep3();

        // Activer le bouton de téléchargement
        enableDownloadButton();

        if (onFolderSelected) {
          onFolderSelected();
        }
      } else {
        console.error('❌ Échec du stockage du handle');
        toastError('Erreur lors de la sauvegarde du dossier');
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('❌ Erreur sélection dossier:', e);
        toastError('Erreur lors de la s\u00e9lection du dossier');
      }
    }
  };
}

/**
 * Met à jour le statut visuel du dossier
 */
export function updateFolderStatus(folderHandle) {
  console.log('🔄 updateFolderStatus appelé avec:', folderHandle);

  const folderStatus = document.getElementById('folderStatus');
  const folderPath = document.getElementById('currentFolderPath');
  const changeFolderBtn = document.getElementById('changeFolderBtn');

  console.log('📍 Éléments DOM:', {
    folderStatus: !!folderStatus,
    folderPath: !!folderPath,
    changeFolderBtn: !!changeFolderBtn,
  });

  if (!folderStatus || !folderPath) {
    console.error('❌ Éléments folderStatus ou folderPath non trouvés');
    return;
  }

  // Changer le statut visuel
  folderStatus.classList.remove('folder-status-empty');
  folderStatus.classList.add('folder-status-selected');

  // Mettre à jour le contenu
  const titleElement = folderStatus.querySelector('.folder-status-title');
  if (titleElement) {
    titleElement.textContent = '✅ Dossier sélectionné';
  } else {
    console.error('❌ Élément folder-status-title non trouvé');
  }

  // Mettre à jour le chemin
  const folderName = folderHandle.name || 'Dossier';
  folderPath.textContent = folderName;
  console.log(`✅ Dossier affiché: ${folderName}`);

  // Changer le texte du bouton
  if (changeFolderBtn) {
    const btnText = changeFolderBtn.querySelector('.btn-text');
    if (btnText) {
      btnText.textContent = 'Changer de dossier';
    }
  }
}

/**
 * Affiche l'etat "dossier memorise mais permission a reconfirmer".
 * L'utilisateur doit cliquer sur le bouton de dossier pour declencher
 * requestPermission() avec une activation utilisateur valide.
 */
export function updateFolderStatusNeedsReauth(folderHandle) {
  const folderStatus = document.getElementById('folderStatus');
  const folderPath = document.getElementById('currentFolderPath');
  const changeFolderBtn = document.getElementById('changeFolderBtn');

  if (!folderStatus || !folderPath) return;

  folderStatus.classList.remove('folder-status-selected');
  folderStatus.classList.add('folder-status-empty');

  const titleElement = folderStatus.querySelector('.folder-status-title');
  if (titleElement) titleElement.textContent = '⏳ Acces a reautoriser';

  folderPath.textContent = folderHandle.name || 'Dossier';

  if (changeFolderBtn) {
    const btnText = changeFolderBtn.querySelector('.btn-text');
    if (btnText) btnText.textContent = "Reautoriser l'acces";
  }
}

/**
 * Affiche l'étape 2 (Filtres)
 */
export function showStep2() {
  const step2 = document.getElementById('step2Guide');
  if (step2) {
    step2.style.display = 'block';
  }
}

/**
 * Affiche l'étape 3 (Téléchargement)
 */
export function showStep3() {
  const step3 = document.getElementById('step3Guide');
  const downloadInfo = document.getElementById('downloadInfo');

  if (step3) {
    step3.style.display = 'block';
  }

  if (downloadInfo) {
    downloadInfo.style.display = 'flex';
  }
}

/**
 * Active le bouton de téléchargement
 */
export function enableDownloadButton() {
  const downloadBtn = document.getElementById('downloadEmailsBtn');
  if (downloadBtn) {
    downloadBtn.disabled = false;
  }
}

// Restaurer le dossier au chargement
export async function restoreFolder(userId) {
  try {
    // Debug: Lister tous les handles stockés
    console.log("🔍 DEBUG: Vérification du contenu de l'IndexedDB...");
    const db = await openDB();
    const transaction = db.transaction(['folderHandles'], 'readonly');
    const store = transaction.objectStore('folderHandles');

    const allHandlesRequest = store.getAll();
    allHandlesRequest.onsuccess = () => {
      console.log('🔍 DEBUG: Tous les handles stockés:', allHandlesRequest.result);
    };

    // Essayer de restaurer le handle depuis IndexedDB
    const restored = await restoreFolderHandle(userId);

    if (!restored) {
      console.log(
        `🔍 Aucun handle trouvé pour ${userId}, l'utilisateur peut choisir un dossier dans l'interface`
      );
      return false;
    }

    if (restored.granted) {
      currentFolderHandle = restored.handle;
      showFolderInfo(restored.handle.name);
      updateFolderStatus(restored.handle);
      showStep2();
      showStep3();
      enableDownloadButton();
      console.log(`✅ Handle restauré pour: ${userId}`);
      return true;
    }

    // Permission 'prompt' — handle conserve en attente d'un clic utilisateur
    pendingReauthHandle = restored.handle;
    showFolderInfo(restored.handle.name);
    updateFolderStatusNeedsReauth(restored.handle);
    console.log(`⏳ Handle en attente de reautorisation pour: ${userId}`);
    return false;
  } catch (error) {
    console.error('❌ Erreur restauration handle:', error);
    // Ne plus afficher la modal en cas d'erreur
    return false;
  }
}
