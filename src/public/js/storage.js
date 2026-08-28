/**
 * IndexedDB storage management module
 * Manages folder handles for persistence
 */

// Open/create the IndexedDB database
export async function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('EmailWorkflowDB', 1);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Create the object store for folder handles
      if (!db.objectStoreNames.contains('folderHandles')) {
        db.createObjectStore('folderHandles', {
          keyPath: 'userId',
        });
        console.log('✅ ObjectStore "folderHandles" created');
      }
    };
  });
}

// Store a folder handle in IndexedDB
export async function storeFolderHandle(userId, handle) {
  try {
    console.log(`🔍 DEBUG: Attempting to store for userId: ${userId}`);
    const db = await openDB();
    const transaction = db.transaction(['folderHandles'], 'readwrite');
    const store = transaction.objectStore('folderHandles');

    return new Promise((resolve, reject) => {
      const request = store.put({ userId, handle });

      request.onsuccess = async () => {
        console.log(`✅ Handle stored for user: ${userId}`);

        // Verify that the storage worked
        const verifyRequest = store.get(userId);
        verifyRequest.onsuccess = () => {
          console.log(`🔍 DEBUG: Storage verification - found:`, !!verifyRequest.result);
          resolve(true);
        };
        verifyRequest.onerror = () => {
          console.error('❌ Storage verification error:', verifyRequest.error);
          resolve(false);
        };
      };

      request.onerror = () => {
        console.error('❌ Handle storage error:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('❌ Handle storage error:', error);
    return false;
  }
}

// Restore a folder handle from IndexedDB
export async function restoreFolderHandle(userId) {
  try {
    console.log(`🔍 DEBUG: Attempting to restore for userId: ${userId}`);
    const db = await openDB();
    const transaction = db.transaction(['folderHandles'], 'readonly');
    const store = transaction.objectStore('folderHandles');

    return new Promise((resolve, reject) => {
      const request = store.get(userId);

      request.onsuccess = async () => {
        const result = request.result;
        console.log(`🔍 DEBUG: Lookup result:`, result);

        if (!result || !result.handle) {
          console.log(`❌ No handle found for user: ${userId}`);
          resolve(null);
          return;
        }

        const handle = result.handle;
        console.log(`🔍 DEBUG: Handle found, checking permissions...`);

        // Check permissions
        const permission = await handle.queryPermission({
          mode: 'readwrite',
        });

        console.log(`🔍 DEBUG: Current permission:`, permission);

        if (permission === 'granted') {
          console.log(`✅ Handle restored with permissions for: ${userId}`);
          resolve({ handle, granted: true });
        } else if (permission === 'prompt') {
          // Do not auto-call requestPermission(): Chrome/Edge/Opera require
          // recent user activation, which does not work at page load. The
          // caller must trigger the request on an explicit interaction.
          console.log(`⚠️ Permission 'prompt' for: ${userId} — requires a user click`);
          resolve({ handle, granted: false });
        } else {
          console.log(`❌ Permissions denied for: ${userId}`);
          resolve(null);
        }
      };

      request.onerror = () => {
        console.error('❌ IndexedDB request error:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('❌ Handle restoration error:', error);
    return null;
  }
}

// Delete a folder handle
export async function deleteFolderHandle(userId) {
  try {
    const db = await openDB();
    const transaction = db.transaction(['folderHandles'], 'readwrite');
    const store = transaction.objectStore('folderHandles');

    // store.delete() returns an IDBRequest, not a Promise: `await`-ing it
    // does not wait for the transaction to finish. We wrap it to wait for
    // the actual completion and surface errors.
    await new Promise((resolve, reject) => {
      const request = store.delete(userId);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    console.log(`🗑️ Handle deleted for: ${userId}`);
    return true;
  } catch (error) {
    console.error('❌ Handle deletion error:', error);
    return false;
  }
}
