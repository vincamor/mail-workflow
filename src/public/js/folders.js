/**
 * Local folder management module (FileSystem Handle API)
 */

import { storeFolderHandle, restoreFolderHandle, openDB } from './storage.js';
import { toastError } from './toast.js';
import { resolveUserFolderHandle } from './folderResolver.js';
import { isDemoMode, getDemoEmailFileHandle } from './demo.js';

// Current folder handle
let currentFolderHandle = null;
// Handle pending reauthorisation (permission 'prompt' at load time)
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

// Function to get the JSONL file handle
export async function getEmailFileHandle(userId, provider = 'gmail') {
  // Demo mode: bundled dataset served over HTTP, read via a fake handle that
  // duck-types FileSystemFileHandle. No local folder is required.
  if (isDemoMode()) {
    return await getDemoEmailFileHandle(provider);
  }

  try {
    if (!currentFolderHandle) {
      console.error('No folder selected');
      return null;
    }

    const fileName = `${provider}_emails.jsonl`;
    // Tolerant resolution: accepts the root, the EmailWorkflow folder, or the account folder.
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
    console.log(`File ${provider}_emails.jsonl not found:`, e);
    return {
      fileHandle: null,
      fileName: `${provider}_emails.jsonl`,
      exists: false,
    };
  }
}

// Utility function to analyse emails in an optimised way
export async function analyzeEmailFile(fileHandle) {
  try {
    const file = await fileHandle.getFile();
    if (file.size === 0) return { exists: false, emailCount: 0, emailIds: new Set() };

    // Streaming read: avoids loading the whole file into a single string.
    // Only the ID of each line is extracted — the full object (bodyHtml,
    // originalPayload, bodyText…) is eligible for GC immediately after parsing.
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
          console.warn('Malformed line ignored:', line.substring(0, 50));
        }
      }
    }

    // Last line if it did not end with \n
    if (buffer.trim()) {
      try {
        const email = JSON.parse(buffer);
        const emailId = email.id || email.messageId;
        if (emailId) {
          emailIds.add(emailId);
          emailCount++;
        }
      } catch (e) {
        /* malformed line ignored */
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

// Function to get detailed statistics about the emails
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
      span: Math.ceil((newestDate - oldestDate) / (1000 * 60 * 60 * 24)), // days
    },
  };
}

// UI - Modal and folder info
export function showFolderInfo(_folderName) {
  document.getElementById('folderSection').style.display = 'block';
  // currentFolderName no longer exists in the new interface
  // The name is handled by currentFolderPath in updateFolderStatus
}

export function hideFolderInfo() {
  document.getElementById('folderSection').style.display = 'none';
}

// Initialise folder handlers
export function initFolderHandlers(userId, onFolderSelected) {
  const changeFolderBtn = document.getElementById('changeFolderBtn');

  if (!changeFolderBtn) {
    console.error('changeFolderBtn button not found');
    return;
  }

  // Change folder (new interface)
  changeFolderBtn.onclick = async () => {
    // Special case: reauthorisation of a pending handle (permission 'prompt')
    // The click provides the user activation required by requestPermission()
    if (pendingReauthHandle) {
      try {
        const perm = await pendingReauthHandle.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          const handle = pendingReauthHandle;
          pendingReauthHandle = null;
          currentFolderHandle = handle;
          console.log(`✅ Reauthorisation granted for: ${handle.name}`);
          showFolderInfo(handle.name);
          updateFolderStatus(handle);
          showStep2();
          showStep3();
          enableDownloadButton();
          if (onFolderSelected) onFolderSelected();
          return;
        }
        console.log('⚠️ Reauthorisation refused, opening the picker');
      } catch (e) {
        console.warn('⚠️ Reauthorisation error, opening the picker:', e);
      }
      pendingReauthHandle = null;
      // Fall through to the regular picker
    }

    try {
      const folderHandle = await window.showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'documents',
      });

      // Store the handle in IndexedDB
      const stored = await storeFolderHandle(userId, folderHandle);

      if (stored) {
        currentFolderHandle = folderHandle;
        console.log(`✅ Folder selected: ${folderHandle.name}`);

        // Update the visual interface
        updateFolderStatus(folderHandle);

        // Activate the following steps
        showStep2();
        showStep3();

        // Activate the download button
        enableDownloadButton();

        if (onFolderSelected) {
          onFolderSelected();
        }
      } else {
        console.error('❌ Failed to store the handle');
        toastError('Error while saving the folder');
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('❌ Folder selection error:', e);
        toastError('Error while selecting the folder');
      }
    }
  };
}

/**
 * Updates the visual status of the folder
 */
export function updateFolderStatus(folderHandle) {
  console.log('🔄 updateFolderStatus called with:', folderHandle);

  const folderStatus = document.getElementById('folderStatus');
  const folderPath = document.getElementById('currentFolderPath');
  const changeFolderBtn = document.getElementById('changeFolderBtn');

  console.log('📍 DOM elements:', {
    folderStatus: !!folderStatus,
    folderPath: !!folderPath,
    changeFolderBtn: !!changeFolderBtn,
  });

  if (!folderStatus || !folderPath) {
    console.error('❌ folderStatus or folderPath elements not found');
    return;
  }

  // Change the visual status
  folderStatus.classList.remove('folder-status-empty');
  folderStatus.classList.add('folder-status-selected');

  // Update the content
  const titleElement = folderStatus.querySelector('.folder-status-title');
  if (titleElement) {
    titleElement.textContent = '✅ Folder selected';
  } else {
    console.error('❌ folder-status-title element not found');
  }

  // Update the path
  const folderName = folderHandle.name || 'Folder';
  folderPath.textContent = folderName;
  console.log(`✅ Folder displayed: ${folderName}`);

  // Change the button text
  if (changeFolderBtn) {
    const btnText = changeFolderBtn.querySelector('.btn-text');
    if (btnText) {
      btnText.textContent = 'Change folder';
    }
  }
}

/**
 * Displays the "folder remembered but permission needs reconfirming" state.
 * The user must click the folder button to trigger
 * requestPermission() with a valid user activation.
 */
export function updateFolderStatusNeedsReauth(folderHandle) {
  const folderStatus = document.getElementById('folderStatus');
  const folderPath = document.getElementById('currentFolderPath');
  const changeFolderBtn = document.getElementById('changeFolderBtn');

  if (!folderStatus || !folderPath) return;

  folderStatus.classList.remove('folder-status-selected');
  folderStatus.classList.add('folder-status-empty');

  const titleElement = folderStatus.querySelector('.folder-status-title');
  if (titleElement) titleElement.textContent = '⏳ Access needs reauthorising';

  folderPath.textContent = folderHandle.name || 'Folder';

  if (changeFolderBtn) {
    const btnText = changeFolderBtn.querySelector('.btn-text');
    if (btnText) btnText.textContent = 'Reauthorise access';
  }
}

/**
 * Displays step 2 (Filters)
 */
export function showStep2() {
  const step2 = document.getElementById('step2Guide');
  if (step2) {
    step2.style.display = 'block';
  }
}

/**
 * Displays step 3 (Download)
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
 * Activates the download button
 */
export function enableDownloadButton() {
  const downloadBtn = document.getElementById('downloadEmailsBtn');
  if (downloadBtn) {
    downloadBtn.disabled = false;
  }
}

// Restore the folder on load
export async function restoreFolder(userId) {
  try {
    // Debug: List all stored handles
    console.log('🔍 DEBUG: Checking IndexedDB contents...');
    const db = await openDB();
    const transaction = db.transaction(['folderHandles'], 'readonly');
    const store = transaction.objectStore('folderHandles');

    const allHandlesRequest = store.getAll();
    allHandlesRequest.onsuccess = () => {
      console.log('🔍 DEBUG: All stored handles:', allHandlesRequest.result);
    };

    // Try to restore the handle from IndexedDB
    const restored = await restoreFolderHandle(userId);

    if (!restored) {
      console.log(
        `🔍 No handle found for ${userId}, the user can choose a folder in the interface`
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
      console.log(`✅ Handle restored for: ${userId}`);
      return true;
    }

    // Permission 'prompt' — handle kept pending a user click
    pendingReauthHandle = restored.handle;
    showFolderInfo(restored.handle.name);
    updateFolderStatusNeedsReauth(restored.handle);
    console.log(`⏳ Handle pending reauthorisation for: ${userId}`);
    return false;
  } catch (error) {
    console.error('❌ Handle restoration error:', error);
    // No longer show the modal on error
    return false;
  }
}
