/**
 * Module de gestion des groupes de sujets
 * Stockage : EmailWorkflow/{userId}/{provider}_groups.json
 *
 * Structure du fichier :
 * {
 *   version: 1,
 *   groups: [{ id, name, parentId, order }],
 *   subjectMemberships: [{ subjectKey, groupIds[] }]
 * }
 *
 * Règles :
 *  - Max 2 niveaux de profondeur (groupe racine + sous-groupe)
 *  - Un sujet peut appartenir à plusieurs groupes simultanément
 *  - subjectKey = sujet normalisé (sans Re:/Fwd:, trimé) — identique à subject.subject dans currentSubjects
 */

import { getCurrentFolderHandle } from './folders.js';
import { resolveUserFolderHandle } from './folderResolver.js';

const GROUPS_VERSION = 1;

// ─── Helpers internes ────────────────────────────────────────────────────────

function createEmptyGroupsData() {
  return {
    version: GROUPS_VERSION,
    groups: [],
    subjectMemberships: [],
    favoriteSubjects: [],
    favoriteGroups: [],
  };
}

function generateGroupId() {
  return 'grp-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 6);
}

/**
 * Obtient le handle du dossier EmailWorkflow/{userId}/ depuis currentFolderHandle.
 * Retourne null si aucun dossier n'est sélectionné ou si le dossier n'existe pas encore.
 * @param {string} userId
 * @returns {FileSystemDirectoryHandle|null}
 */
export async function getUserFolderHandle(userId) {
  const rootHandle = getCurrentFolderHandle();
  if (!rootHandle) return null;
  try {
    // Résolution tolérante (racine / EmailWorkflow / dossier compte), create si absent.
    return await resolveUserFolderHandle(rootHandle, userId, { create: true });
  } catch (e) {
    console.error("❌ [groups] Impossible d'obtenir le userFolderHandle:", e);
    return null;
  }
}

// ─── Lecture / écriture ───────────────────────────────────────────────────────

/**
 * Lit le fichier de groupes depuis le dossier utilisateur.
 * Retourne une structure vide si le fichier n'existe pas encore.
 * @param {FileSystemDirectoryHandle} userFolderHandle - Dossier EmailWorkflow/{userId}/
 * @param {string} provider - "gmail" ou "outlook"
 * @returns {Object}
 */
export async function readGroups(userFolderHandle, provider) {
  const fileName = `${provider}_groups.json`;
  try {
    const fileHandle = await userFolderHandle.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    const content = await file.text();
    return JSON.parse(content);
  } catch (e) {
    // Fichier absent = premier usage, on retourne une structure vide
    return createEmptyGroupsData();
  }
}

/**
 * Écrit (ou écrase) le fichier de groupes.
 * @param {FileSystemDirectoryHandle} userFolderHandle
 * @param {string} provider
 * @param {Object} data - Structure complète des groupes
 */
export async function writeGroups(userFolderHandle, provider, data) {
  const fileName = `${provider}_groups.json`;
  try {
    const fileHandle = await userFolderHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  } catch (e) {
    console.error('❌ [groups] Erreur écriture groupes:', e);
    throw e;
  }
}

// ─── Opérations sur les groupes ──────────────────────────────────────────────

/**
 * Crée un nouveau groupe et retourne son ID.
 * @param {Object} data - Structure complète (modifiée en place)
 * @param {string} name - Nom du groupe
 * @param {string|null} parentId - ID du groupe parent (null = racine)
 * @returns {string} - ID du nouveau groupe
 * @throws si la profondeur max (2 niveaux) serait dépassée
 */
export function createGroup(data, name, parentId = null) {
  if (parentId !== null) {
    const parent = data.groups.find((g) => g.id === parentId);
    if (!parent) throw new Error(`Groupe parent "${parentId}" introuvable.`);
    if (parent.parentId !== null) throw new Error('Profondeur maximale (2 niveaux) atteinte.');
  }

  const newId = generateGroupId();
  const siblings = data.groups.filter((g) => g.parentId === parentId);
  const maxOrder = siblings.reduce((max, g) => Math.max(max, g.order ?? 0), -1);

  data.groups.push({
    id: newId,
    name: name.trim(),
    parentId: parentId,
    order: maxOrder + 1,
    color: null,
  });

  return newId;
}

/**
 * Renomme un groupe.
 * @param {Object} data
 * @param {string} groupId
 * @param {string} newName
 */
export function renameGroup(data, groupId, newName) {
  const group = data.groups.find((g) => g.id === groupId);
  if (group) {
    group.name = newName.trim();
  }
}

/**
 * Supprime un groupe (et ses sous-groupes directs) et libère tous les memberships associés.
 * @param {Object} data
 * @param {string} groupId
 */
export function deleteGroup(data, groupId) {
  // Collecter les IDs à supprimer : le groupe lui-même + ses enfants directs
  const idsToDelete = new Set([groupId]);
  data.groups.forEach((g) => {
    if (g.parentId === groupId) idsToDelete.add(g.id);
  });

  data.groups = data.groups.filter((g) => !idsToDelete.has(g.id));

  // Nettoyer les memberships
  data.subjectMemberships = data.subjectMemberships
    .map((m) => ({
      ...m,
      groupIds: m.groupIds.filter((id) => !idsToDelete.has(id)),
    }))
    .filter((m) => m.groupIds.length > 0);
}

// ─── Opérations sur les memberships ──────────────────────────────────────────

/**
 * Ajoute un sujet à un groupe. Sans effet si déjà membre.
 * @param {Object} data
 * @param {string} subjectKey - Sujet normalisé (identique à subject.subject dans currentSubjects)
 * @param {string} groupId
 */
export function addSubjectToGroup(data, subjectKey, groupId) {
  const existing = data.subjectMemberships.find((m) => m.subjectKey === subjectKey);
  if (existing) {
    if (!existing.groupIds.includes(groupId)) {
      existing.groupIds.push(groupId);
    }
  } else {
    data.subjectMemberships.push({ subjectKey, groupIds: [groupId] });
  }
}

/**
 * Retire un sujet d'un groupe.
 * @param {Object} data
 * @param {string} subjectKey
 * @param {string} groupId
 */
export function removeSubjectFromGroup(data, subjectKey, groupId) {
  const existing = data.subjectMemberships.find((m) => m.subjectKey === subjectKey);
  if (!existing) return;

  existing.groupIds = existing.groupIds.filter((id) => id !== groupId);

  if (existing.groupIds.length === 0) {
    data.subjectMemberships = data.subjectMemberships.filter((m) => m.subjectKey !== subjectKey);
  }
}

// ─── Requêtes ─────────────────────────────────────────────────────────────────

/**
 * Retourne les groupIds auxquels appartient un sujet.
 * @param {Object} data
 * @param {string} subjectKey
 * @returns {string[]}
 */
export function getGroupsForSubject(data, subjectKey) {
  const membership = data.subjectMemberships.find((m) => m.subjectKey === subjectKey);
  return membership ? [...membership.groupIds] : [];
}

/**
 * Retourne les subjectKeys des sujets appartenant à un groupe donné.
 * @param {Object} data
 * @param {string} groupId
 * @returns {string[]}
 */
export function getSubjectsInGroup(data, groupId) {
  return data.subjectMemberships
    .filter((m) => m.groupIds.includes(groupId))
    .map((m) => m.subjectKey);
}

/**
 * Définit la couleur d'un groupe (null = couleur par défaut).
 * @param {Object} data
 * @param {string} groupId
 * @param {string|null} color - Code couleur CSS (ex: "#ef4444") ou null
 */
export function setGroupColor(data, groupId, color) {
  const group = data.groups.find((g) => g.id === groupId);
  if (group) group.color = color || null;
}

/**
 * Retourne les groupes enfants directs d'un parent, triés par order.
 * @param {Object} data
 * @param {string|null} parentId - null = groupes racine
 * @returns {Array<{id, name, parentId, order}>}
 */
export function getChildGroups(data, parentId = null) {
  return data.groups
    .filter((g) => g.parentId === parentId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * Indique si un sujet est membre d'au moins un groupe.
 * @param {Object} data
 * @param {string} subjectKey
 * @returns {boolean}
 */
export function isSubjectGrouped(data, subjectKey) {
  return data.subjectMemberships.some((m) => m.subjectKey === subjectKey && m.groupIds.length > 0);
}

// ─── Favoris ──────────────────────────────────────────────────────────────────

/**
 * Bascule le statut favori d'un sujet.
 * @param {Object} data
 * @param {string} subjectKey
 * @returns {boolean} - true si maintenant favori, false si retiré
 */
export function toggleFavoriteSubject(data, subjectKey) {
  if (!data.favoriteSubjects) data.favoriteSubjects = [];
  const idx = data.favoriteSubjects.indexOf(subjectKey);
  if (idx >= 0) {
    data.favoriteSubjects.splice(idx, 1);
    return false;
  } else {
    data.favoriteSubjects.push(subjectKey);
    return true;
  }
}

/**
 * Bascule le statut favori d'un groupe.
 * @param {Object} data
 * @param {string} groupId
 * @returns {boolean} - true si maintenant favori, false si retiré
 */
export function toggleFavoriteGroup(data, groupId) {
  if (!data.favoriteGroups) data.favoriteGroups = [];
  const idx = data.favoriteGroups.indexOf(groupId);
  if (idx >= 0) {
    data.favoriteGroups.splice(idx, 1);
    return false;
  } else {
    data.favoriteGroups.push(groupId);
    return true;
  }
}

/**
 * Indique si un sujet est favori.
 * @param {Object} data
 * @param {string} subjectKey
 * @returns {boolean}
 */
export function isSubjectFavorite(data, subjectKey) {
  return Array.isArray(data.favoriteSubjects) && data.favoriteSubjects.includes(subjectKey);
}

/**
 * Indique si un groupe est favori.
 * @param {Object} data
 * @param {string} groupId
 * @returns {boolean}
 */
export function isGroupFavorite(data, groupId) {
  return Array.isArray(data.favoriteGroups) && data.favoriteGroups.includes(groupId);
}
