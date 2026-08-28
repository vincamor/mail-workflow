/**
 * folderResolver.js — Tolerant resolution of the data folder.
 *
 * The app stores data under <root>/EmailWorkflow/<userId>/ (files
 * <provider>_emails.jsonl, _groups.json, _sync_metadata.json, companion HTML).
 * Historically, the user HAD to select the exact root, otherwise nothing
 * would load — a recurring gotcha.
 *
 * This module accepts the three plausible levels and always returns THE SAME
 * data folder, so that reading, downloading, syncing and cleaning up stay
 * consistent (no accidental nested structure):
 *
 *   1) root selected                 → <root>/EmailWorkflow/<userId>
 *   2) EmailWorkflow folder selected  → <root>/<userId>
 *   3) account folder selected directly → <root> itself
 *        (its name == userId, or it already contains a *_emails.jsonl)
 *   4) nothing found + create:true    → creates <root>/EmailWorkflow/<userId>
 *        (default structure, backward-compatible for a first download)
 *
 * PURE function (the root handle is passed as a parameter) → testable without a DOM.
 */

/** True if the folder directly contains a *_emails.jsonl file. */
async function folderHasEmailsJsonl(dirHandle) {
  try {
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'file' && /_emails\.jsonl$/i.test(name)) return true;
    }
  } catch (e) {
    // entries() can fail without read permission — stay cautious.
  }
  return false;
}

/**
 * @param {FileSystemDirectoryHandle|null} rootHandle - folder chosen by the user
 * @param {string} userId - user's email (= account folder name)
 * @param {{ create?: boolean }} [opts] - create:true to create the structure if missing
 * @returns {Promise<FileSystemDirectoryHandle|null>} the data folder, or null
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

  // 1) root: <root>/EmailWorkflow/<userId>
  const emailWorkflow = await tryDir(rootHandle, 'EmailWorkflow');
  if (emailWorkflow) {
    const user = await tryDir(emailWorkflow, userId);
    if (user) return user;
  }

  // 2) EmailWorkflow folder selected: <root>/<userId>
  const directUser = await tryDir(rootHandle, userId);
  if (directUser) return directUser;

  // 3) account folder selected directly
  if (rootHandle.name === userId || (await folderHasEmailsJsonl(rootHandle))) {
    return rootHandle;
  }

  // 4) nothing found: create the default structure if requested
  if (create) {
    const ew = await rootHandle.getDirectoryHandle('EmailWorkflow', { create: true });
    return await ew.getDirectoryHandle(userId, { create: true });
  }

  return null;
}
