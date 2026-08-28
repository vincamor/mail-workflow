/**
 * Context menu for managing subject groups
 *
 * Triggered on right-click on:
 *   - .subject-drawer-header  → subject menu (add/remove from a group)
 *   - .group-header            → group menu (rename, subgroup, delete)
 *
 * Uses event delegation on #subjectsList to keep working
 * even after the list is re-rendered.
 */

import { getCurrentGroupsData, saveGroupsData, refreshSubjectsDisplay } from './analysis.js';

import { getCurrentFilters, updateCurrentFilters } from './filterUI.js';
import { saveFilters } from './emailFilters.js';
import { cleanupExcludedSubjectFromJSONL } from './emails.js';

import {
  createGroup,
  renameGroup,
  deleteGroup,
  setGroupColor,
  addSubjectToGroup,
  removeSubjectFromGroup,
  getChildGroups,
  getGroupsForSubject,
} from './groups.js';
import { toastError, toastSuccess, showConfirmModal } from './toast.js';

const GROUP_COLORS = [
  { name: 'Red', value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Amber', value: '#f59e0b' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Emerald', value: '#10b981' },
  { name: 'Cyan', value: '#06b6d4' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Indigo', value: '#6366f1' },
  { name: 'Violet', value: '#a855f7' },
  { name: 'Pink', value: '#ec4899' },
];

let menuEl = null;

// ─── Initialisation ──────────────────────────────────────────────────────────

export function initGroupContextMenu() {
  menuEl = document.getElementById('groupContextMenu');
  if (!menuEl) return;

  // Close on outside click or Escape
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });

  // Delegation on #subjectsList (persists across re-renders)
  const subjectsList = document.getElementById('subjectsList');
  if (subjectsList) {
    subjectsList.addEventListener('contextmenu', handleContextMenu);
  }
}

function closeMenu() {
  if (menuEl) menuEl.style.display = 'none';
}

// ─── Dispatch based on target ──────────────────────────────────────────────────

function handleContextMenu(event) {
  event.preventDefault();

  const data = getCurrentGroupsData();

  // Right-click on a subject
  const drawer = event.target.closest('.subject-drawer');
  if (drawer) {
    const subjectKey = drawer.getAttribute('data-subject');
    if (subjectKey) {
      buildSubjectMenu(subjectKey, data);
      positionMenu(event.clientX, event.clientY);
      return;
    }
  }

  // Right-click on a group
  const groupItem = event.target.closest('.group-item');
  if (groupItem) {
    const groupId = groupItem.getAttribute('data-group-id');
    if (groupId && data) {
      buildGroupMenu(groupId, data);
      positionMenu(event.clientX, event.clientY);
    }
  }
}

// ─── Subject menu ───────────────────────────────────────────────────────────────

function buildSubjectMenu(subjectKey, data) {
  menuEl.innerHTML = '';

  // ── "Add to" section ──
  const addLabel = makeLabel('Add to');
  menuEl.appendChild(addLabel);

  if (data && data.groups.length > 0) {
    const memberIds = getGroupsForSubject(data, subjectKey);
    const rootGroups = getChildGroups(data, null);

    rootGroups.forEach((group) => {
      menuEl.appendChild(makeGroupOption(group, subjectKey, memberIds, data, false));
      getChildGroups(data, group.id).forEach((child) => {
        menuEl.appendChild(makeGroupOption(child, subjectKey, memberIds, data, true));
      });
    });
  }

  // "New group…" option
  const newGroupItem = makeItem('＋ New group…', 'context-menu-item--accent');
  newGroupItem.addEventListener('click', () => {
    closeMenu();
    promptCreateGroupAndAdd(subjectKey);
  });
  menuEl.appendChild(newGroupItem);

  // ── "Remove from" section (visible only if already a member) ──
  if (data) {
    const memberIds = getGroupsForSubject(data, subjectKey);
    if (memberIds.length > 0) {
      menuEl.appendChild(makeSeparator());
      memberIds.forEach((groupId) => {
        const group = data.groups.find((g) => g.id === groupId);
        if (!group) return;
        const removeItem = makeItem(`Remove from "${group.name}"`, 'context-menu-item--danger');
        removeItem.addEventListener('click', async () => {
          closeMenu();
          removeSubjectFromGroup(data, subjectKey, groupId);
          await saveGroupsData();
          refreshSubjectsDisplay();
        });
        menuEl.appendChild(removeItem);
      });
    }
  }

  // ── "Exclude" section ──
  menuEl.appendChild(makeSeparator());
  const excludeItem = makeItem('Exclude this subject', 'context-menu-item--danger', 'icon-ban');
  excludeItem.addEventListener('click', async () => {
    closeMenu();
    await excludeSubject(subjectKey);
  });
  menuEl.appendChild(excludeItem);
}

function makeGroupOption(group, subjectKey, memberIds, data, isChild) {
  const alreadyMember = memberIds.includes(group.id);
  const childClass = isChild ? ' context-menu-item--child' : '';
  const checkedClass = alreadyMember ? ' context-menu-item--checked' : '';
  const prefix = isChild ? '↳ ' : '';

  const item = makeItem(
    `${prefix}${group.name}`,
    childClass + checkedClass,
    alreadyMember ? 'icon-check' : ''
  );

  if (!alreadyMember) {
    item.addEventListener('click', async () => {
      closeMenu();
      addSubjectToGroup(data, subjectKey, group.id);
      await saveGroupsData();
      refreshSubjectsDisplay();
    });
  } else {
    item.style.cursor = 'default';
  }

  return item;
}

// ─── Group menu ─────────────────────────────────────────────────────────────

function buildGroupMenu(groupId, data) {
  menuEl.innerHTML = '';
  const group = data.groups.find((g) => g.id === groupId);
  if (!group) return;

  // Rename
  const renameItem = makeItem('Rename', '', 'icon-edit');
  renameItem.addEventListener('click', () => {
    closeMenu();
    promptRenameGroup(groupId, group.name, data);
  });
  menuEl.appendChild(renameItem);

  // Add a subgroup (only if root group)
  if (group.parentId === null) {
    const addSubItem = makeItem('Add a subgroup', '', 'icon-folder');
    addSubItem.addEventListener('click', () => {
      closeMenu();
      promptCreateSubGroup(groupId, data);
    });
    menuEl.appendChild(addSubItem);
  }

  menuEl.appendChild(makeSeparator());

  // Colour palette
  menuEl.appendChild(makeLabel('Folder colour'));
  menuEl.appendChild(makeColorPicker(groupId, group.color || null, data));

  menuEl.appendChild(makeSeparator());

  // Delete
  const deleteItem = makeItem('Delete', 'context-menu-item--danger', 'icon-trash');
  deleteItem.addEventListener('click', () => {
    closeMenu();
    confirmDeleteGroup(groupId, group.name, data);
  });
  menuEl.appendChild(deleteItem);
}

function makeColorPicker(groupId, currentColor, data) {
  const row = document.createElement('div');
  row.className = 'color-picker-row';

  GROUP_COLORS.forEach(({ name, value }) => {
    const swatch = document.createElement('button');
    swatch.className = 'color-swatch';
    swatch.style.background = value;
    swatch.title = name;
    if (currentColor === value) {
      swatch.style.borderColor = 'rgba(0,0,0,0.4)';
      swatch.style.transform = 'scale(1.15)';
    }
    swatch.addEventListener('click', async () => {
      closeMenu();
      setGroupColor(data, groupId, value);
      await saveGroupsData();
      refreshSubjectsDisplay();
    });
    row.appendChild(swatch);
  });

  // "No colour" button
  const noneBtn = document.createElement('button');
  noneBtn.className = 'color-swatch color-swatch--none';
  noneBtn.title = 'No colour';
  noneBtn.setAttribute('aria-label', 'No colour');
  noneBtn.innerHTML = '<span class="icon icon-close icon-sm" aria-hidden="true"></span>';
  noneBtn.addEventListener('click', async () => {
    closeMenu();
    setGroupColor(data, groupId, null);
    await saveGroupsData();
    refreshSubjectsDisplay();
  });
  row.appendChild(noneBtn);

  return row;
}

// ─── Async actions ─────────────────────────────────────────────────────

async function promptCreateGroupAndAdd(subjectKey) {
  const name = window.prompt('New group name:');
  if (!name || !name.trim()) return;

  const data = getCurrentGroupsData();
  if (!data) return;

  try {
    const newGroupId = createGroup(data, name.trim(), null);
    addSubjectToGroup(data, subjectKey, newGroupId);
    await saveGroupsData();
    refreshSubjectsDisplay();
  } catch (e) {
    toastError('Error: ' + e.message);
  }
}

async function promptRenameGroup(groupId, currentName, data) {
  const newName = window.prompt('New name:', currentName);
  if (!newName || !newName.trim() || newName.trim() === currentName) return;

  renameGroup(data, groupId, newName.trim());
  await saveGroupsData();
  refreshSubjectsDisplay();
}

async function promptCreateSubGroup(parentId, data) {
  const name = window.prompt('Subgroup name:');
  if (!name || !name.trim()) return;

  try {
    createGroup(data, name.trim(), parentId);
    await saveGroupsData();
    refreshSubjectsDisplay();
  } catch (e) {
    toastError('Error: ' + e.message);
  }
}

async function confirmDeleteGroup(groupId, groupName, data) {
  const ok = await showConfirmModal({
    title: 'Delete group',
    message: `Delete the group "${groupName}"?<br><br>The subjects will be freed (not deleted).`,
    html: true,
    type: 'warning',
    confirmText: 'Delete',
  });
  if (!ok) return;

  deleteGroup(data, groupId);
  await saveGroupsData();
  refreshSubjectsDisplay();
}

async function excludeSubject(subjectKey) {
  const ok = await showConfirmModal({
    title: 'Exclude this subject',
    message: `Exclude the subject "${subjectKey}" from the display?<br><br>The emails for this subject will also be deleted from the local file. It will no longer be downloaded in future.`,
    html: true,
    type: 'warning',
    confirmText: 'Exclude',
  });
  if (!ok) return;

  const filters = getCurrentFilters();
  if (!filters) return;

  if (!filters.blacklistedSubjects) filters.blacklistedSubjects = [];

  if (!filters.blacklistedSubjects.includes(subjectKey)) {
    filters.blacklistedSubjects.push(subjectKey);
    await saveFilters(filters);
    updateCurrentFilters(filters);
    refreshSubjectsDisplay();
    toastSuccess(`Subject excluded: "${subjectKey}"`);

    // Cleanup JSONL in background
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const provider = urlParams.get('provider') || 'gmail';
      const userId = urlParams.get('email');
      if (userId) {
        const result = await cleanupExcludedSubjectFromJSONL(provider, userId, subjectKey);
        console.log(`🗑️ JSONL cleaned up: ${result.removed} emails removed`);
      }
    } catch (e) {
      console.warn('⚠️ JSONL cleanup failed (the subject stays excluded from the display):', e);
    }
  }
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function makeItem(text, extraClass = '', iconClass = '') {
  const el = document.createElement('div');
  el.className = ('context-menu-item ' + extraClass).trim();
  if (iconClass) {
    const icon = document.createElement('span');
    icon.className = `icon ${iconClass} icon-inline`;
    icon.setAttribute('aria-hidden', 'true');
    el.appendChild(icon);
  }
  el.appendChild(document.createTextNode(text));
  return el;
}

function makeLabel(text) {
  const el = document.createElement('div');
  el.className = 'context-menu-label';
  el.textContent = text;
  return el;
}

function makeSeparator() {
  const el = document.createElement('div');
  el.className = 'context-menu-separator';
  return el;
}

function positionMenu(x, y) {
  // Show first to measure
  menuEl.style.display = 'block';

  const menuWidth = menuEl.offsetWidth || 200;
  const menuHeight = menuEl.offsetHeight || 150;

  const finalX = x + menuWidth > window.innerWidth ? x - menuWidth : x;
  const finalY = y + menuHeight > window.innerHeight ? y - menuHeight : y;

  menuEl.style.left = Math.max(4, finalX) + 'px';
  menuEl.style.top = Math.max(4, finalY) + 'px';
}
