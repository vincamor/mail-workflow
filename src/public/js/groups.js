/**
 * Subject group management module
 * Storage: EmailWorkflow/{userId}/{provider}_groups.json
 *
 * File structure:
 * {
 *   version: 1,
 *   groups: [{ id, name, parentId, order }],
 *   subjectMemberships: [{ subjectKey, groupIds[] }]
 * }
 *
 * Rules:
 *  - Max 2 levels of depth (root group + subgroup)
 *  - A subject can belong to several groups at once
 *  - subjectKey = normalised subject (without Re:/Fwd:, trimmed) — same as subject.subject in currentSubjects
 */

import { getCurrentFolderHandle } from './folders.js';
import { resolveUserFolderHandle } from './folderResolver.js';

const GROUPS_VERSION = 1;

// ─── Internal helpers ────────────────────────────────────────────────────────

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
 * Gets the EmailWorkflow/{userId}/ folder handle from currentFolderHandle.
 * Returns null if no folder is selected or if the folder does not exist yet.
 * @param {string} userId
 * @returns {FileSystemDirectoryHandle|null}
 */
export async function getUserFolderHandle(userId) {
  const rootHandle = getCurrentFolderHandle();
  if (!rootHandle) return null;
  try {
    // Tolerant resolution (root / EmailWorkflow / account folder), create if missing.
    return await resolveUserFolderHandle(rootHandle, userId, { create: true });
  } catch (e) {
    console.error('❌ [groups] Could not get the userFolderHandle:', e);
    return null;
  }
}

// ─── Read / write ───────────────────────────────────────────────────────

/**
 * Reads the groups file from the user folder.
 * Returns an empty structure if the file does not exist yet.
 * @param {FileSystemDirectoryHandle} userFolderHandle - EmailWorkflow/{userId}/ folder
 * @param {string} provider - "gmail" or "outlook"
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
    // Missing file = first use, return an empty structure
    return createEmptyGroupsData();
  }
}

/**
 * Writes (or overwrites) the groups file.
 * @param {FileSystemDirectoryHandle} userFolderHandle
 * @param {string} provider
 * @param {Object} data - Complete groups structure
 */
export async function writeGroups(userFolderHandle, provider, data) {
  const fileName = `${provider}_groups.json`;
  try {
    const fileHandle = await userFolderHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  } catch (e) {
    console.error('❌ [groups] Error writing groups:', e);
    throw e;
  }
}

// ─── Group operations ──────────────────────────────────────────

/**
 * Creates a new group and returns its ID.
 * @param {Object} data - Complete structure (modified in place)
 * @param {string} name - Group name
 * @param {string|null} parentId - Parent group ID (null = root)
 * @returns {string} - New group ID
 * @throws if the max depth (2 levels) would be exceeded
 */
export function createGroup(data, name, parentId = null) {
  if (parentId !== null) {
    const parent = data.groups.find((g) => g.id === parentId);
    if (!parent) throw new Error(`Parent group "${parentId}" not found.`);
    if (parent.parentId !== null) throw new Error('Maximum depth (2 levels) reached.');
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
 * Renames a group.
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
 * Deletes a group (and its direct subgroups) and frees all associated memberships.
 * @param {Object} data
 * @param {string} groupId
 */
export function deleteGroup(data, groupId) {
  // Collect the IDs to delete: the group itself + its direct children
  const idsToDelete = new Set([groupId]);
  data.groups.forEach((g) => {
    if (g.parentId === groupId) idsToDelete.add(g.id);
  });

  data.groups = data.groups.filter((g) => !idsToDelete.has(g.id));

  // Clean up memberships
  data.subjectMemberships = data.subjectMemberships
    .map((m) => ({
      ...m,
      groupIds: m.groupIds.filter((id) => !idsToDelete.has(id)),
    }))
    .filter((m) => m.groupIds.length > 0);
}

// ─── Membership operations ──────────────────────────────────────────

/**
 * Adds a subject to a group. No effect if already a member.
 * @param {Object} data
 * @param {string} subjectKey - Normalised subject (same as subject.subject in currentSubjects)
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
 * Removes a subject from a group.
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

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Returns the groupIds a subject belongs to.
 * @param {Object} data
 * @param {string} subjectKey
 * @returns {string[]}
 */
export function getGroupsForSubject(data, subjectKey) {
  const membership = data.subjectMemberships.find((m) => m.subjectKey === subjectKey);
  return membership ? [...membership.groupIds] : [];
}

/**
 * Returns the subjectKeys of the subjects belonging to a given group.
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
 * Sets a group's colour (null = default colour).
 * @param {Object} data
 * @param {string} groupId
 * @param {string|null} color - CSS colour code (e.g. "#ef4444") or null
 */
export function setGroupColor(data, groupId, color) {
  const group = data.groups.find((g) => g.id === groupId);
  if (group) group.color = color || null;
}

/**
 * Returns the direct child groups of a parent, sorted by order.
 * @param {Object} data
 * @param {string|null} parentId - null = root groups
 * @returns {Array<{id, name, parentId, order}>}
 */
export function getChildGroups(data, parentId = null) {
  return data.groups
    .filter((g) => g.parentId === parentId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * Indicates whether a subject is a member of at least one group.
 * @param {Object} data
 * @param {string} subjectKey
 * @returns {boolean}
 */
export function isSubjectGrouped(data, subjectKey) {
  return data.subjectMemberships.some((m) => m.subjectKey === subjectKey && m.groupIds.length > 0);
}

// ─── Favourites ──────────────────────────────────────────────────────────────────

/**
 * Toggles a subject's favourite status.
 * @param {Object} data
 * @param {string} subjectKey
 * @returns {boolean} - true if now favourite, false if removed
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
 * Toggles a group's favourite status.
 * @param {Object} data
 * @param {string} groupId
 * @returns {boolean} - true if now favourite, false if removed
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
 * Indicates whether a subject is a favourite.
 * @param {Object} data
 * @param {string} subjectKey
 * @returns {boolean}
 */
export function isSubjectFavorite(data, subjectKey) {
  return Array.isArray(data.favoriteSubjects) && data.favoriteSubjects.includes(subjectKey);
}

/**
 * Indicates whether a group is a favourite.
 * @param {Object} data
 * @param {string} groupId
 * @returns {boolean}
 */
export function isGroupFavorite(data, groupId) {
  return Array.isArray(data.favoriteGroups) && data.favoriteGroups.includes(groupId);
}
