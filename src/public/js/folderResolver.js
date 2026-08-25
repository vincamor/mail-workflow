/**
 * folderResolver.js — Résolution tolérante du dossier de données.
 *
 * L'app stocke les données sous <racine>/EmailWorkflow/<userId>/ (fichiers
 * <provider>_emails.jsonl, _groups.json, _sync_metadata.json, companion HTML).
 * Historiquement, l'utilisateur DEVAIT sélectionner la racine exacte, sinon
 * rien ne se lisait — piège de niveau récurrent.
 *
 * Ce module accepte les trois niveaux plausibles et renvoie toujours LE MÊME
 * dossier de données, pour que lecture, téléchargement, sync et nettoyage
 * soient cohérents (pas de structure imbriquée accidentelle) :
 *
 *   1) racine sélectionnée        → <root>/EmailWorkflow/<userId>
 *   2) dossier EmailWorkflow choisi → <root>/<userId>
 *   3) dossier compte choisi direct → <root> lui-même
 *        (son nom == userId, ou il contient déjà un *_emails.jsonl)
 *   4) rien trouvé + create:true    → crée <root>/EmailWorkflow/<userId>
 *        (structure par défaut, rétro-compatible pour un premier téléchargement)
 *
 * Fonction PURE (le handle racine est passé en paramètre) → testable sans DOM.
 */

/** Vrai si le dossier contient directement un fichier *_emails.jsonl. */
async function folderHasEmailsJsonl(dirHandle) {
  try {
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'file' && /_emails\.jsonl$/i.test(name)) return true;
    }
  } catch (e) {
    // entries() peut échouer sans permission de lecture — on reste prudent.
  }
  return false;
}

/**
 * @param {FileSystemDirectoryHandle|null} rootHandle - dossier choisi par l'utilisateur
 * @param {string} userId - email de l'utilisateur (= nom du dossier compte)
 * @param {{ create?: boolean }} [opts] - create:true pour créer la structure si absente
 * @returns {Promise<FileSystemDirectoryHandle|null>} le dossier de données, ou null
 */
export async function resolveUserFolderHandle(rootHandle, userId, { create = false } = {}) {
  if (!rootHandle) return null;

  const tryDir = async (parent, name) => {
    try {
      return await parent.getDirectoryHandle(name, { create: false });
    } catch (e) {
      return null;
    }
  };

  // 1) racine : <root>/EmailWorkflow/<userId>
  const emailWorkflow = await tryDir(rootHandle, 'EmailWorkflow');
  if (emailWorkflow) {
    const user = await tryDir(emailWorkflow, userId);
    if (user) return user;
  }

  // 2) dossier EmailWorkflow sélectionné : <root>/<userId>
  const directUser = await tryDir(rootHandle, userId);
  if (directUser) return directUser;

  // 3) dossier compte sélectionné directement
  if (rootHandle.name === userId || (await folderHasEmailsJsonl(rootHandle))) {
    return rootHandle;
  }

  // 4) rien trouvé : créer la structure par défaut si demandé
  if (create) {
    const ew = await rootHandle.getDirectoryHandle('EmailWorkflow', { create: true });
    return await ew.getDirectoryHandle(userId, { create: true });
  }

  return null;
}
