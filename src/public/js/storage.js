/**
 * Module de gestion du stockage IndexedDB
 * Gère les handles de dossiers pour la persistance
 */

// Ouvrir/créer la base de données IndexedDB
export async function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('EmailWorkflowDB', 1);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Créer l'object store pour les handles de dossiers
      if (!db.objectStoreNames.contains('folderHandles')) {
        db.createObjectStore('folderHandles', {
          keyPath: 'userId',
        });
        console.log('✅ ObjectStore "folderHandles" créé');
      }
    };
  });
}

// Stocker un handle de dossier dans IndexedDB
export async function storeFolderHandle(userId, handle) {
  try {
    console.log(`🔍 DEBUG: Tentative de stockage pour userId: ${userId}`);
    const db = await openDB();
    const transaction = db.transaction(['folderHandles'], 'readwrite');
    const store = transaction.objectStore('folderHandles');

    return new Promise((resolve, reject) => {
      const request = store.put({ userId, handle });

      request.onsuccess = async () => {
        console.log(`✅ Handle stocké pour l'utilisateur: ${userId}`);

        // Vérifier que le stockage a fonctionné
        const verifyRequest = store.get(userId);
        verifyRequest.onsuccess = () => {
          console.log(`🔍 DEBUG: Vérification stockage - trouvé:`, !!verifyRequest.result);
          resolve(true);
        };
        verifyRequest.onerror = () => {
          console.error('❌ Erreur vérification stockage:', verifyRequest.error);
          resolve(false);
        };
      };

      request.onerror = () => {
        console.error('❌ Erreur stockage handle:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('❌ Erreur stockage handle:', error);
    return false;
  }
}

// Restaurer un handle de dossier depuis IndexedDB
export async function restoreFolderHandle(userId) {
  try {
    console.log(`🔍 DEBUG: Tentative de restauration pour userId: ${userId}`);
    const db = await openDB();
    const transaction = db.transaction(['folderHandles'], 'readonly');
    const store = transaction.objectStore('folderHandles');

    return new Promise((resolve, reject) => {
      const request = store.get(userId);

      request.onsuccess = async () => {
        const result = request.result;
        console.log(`🔍 DEBUG: Résultat de la recherche:`, result);

        if (!result || !result.handle) {
          console.log(`❌ Aucun handle trouvé pour l'utilisateur: ${userId}`);
          resolve(null);
          return;
        }

        const handle = result.handle;
        console.log(`🔍 DEBUG: Handle trouvé, vérification des permissions...`);

        // Vérifier les permissions
        const permission = await handle.queryPermission({
          mode: 'readwrite',
        });

        console.log(`🔍 DEBUG: Permission actuelle:`, permission);

        if (permission === 'granted') {
          console.log(`✅ Handle restauré avec permissions pour: ${userId}`);
          resolve({ handle, granted: true });
        } else if (permission === 'prompt') {
          // Ne pas auto-appeler requestPermission() : Chrome/Edge/Opera exigent
          // une activation utilisateur recente, ce qui ne fonctionne pas au
          // chargement de la page. Le caller doit declencher la demande sur
          // une interaction explicite.
          console.log(`⚠️ Permission 'prompt' pour: ${userId} — requiert un clic utilisateur`);
          resolve({ handle, granted: false });
        } else {
          console.log(`❌ Permissions refusées pour: ${userId}`);
          resolve(null);
        }
      };

      request.onerror = () => {
        console.error('❌ Erreur requête IndexedDB:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('❌ Erreur restauration handle:', error);
    return null;
  }
}

// Supprimer un handle de dossier
export async function deleteFolderHandle(userId) {
  try {
    const db = await openDB();
    const transaction = db.transaction(['folderHandles'], 'readwrite');
    const store = transaction.objectStore('folderHandles');

    // store.delete() renvoie un IDBRequest, pas une Promise : `await` dessus
    // n'attend pas la fin de la transaction. On enveloppe pour attendre la
    // completion reelle et remonter les erreurs.
    await new Promise((resolve, reject) => {
      const request = store.delete(userId);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    console.log(`🗑️ Handle supprimé pour: ${userId}`);
    return true;
  } catch (error) {
    console.error('❌ Erreur suppression handle:', error);
    return false;
  }
}
