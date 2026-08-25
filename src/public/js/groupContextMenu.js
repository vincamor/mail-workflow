/**
 * Menu contextuel pour la gestion des groupes de sujets
 *
 * Déclenché au clic droit sur :
 *   - .subject-drawer-header  → menu sujet (ajouter/retirer d'un groupe)
 *   - .group-header            → menu groupe (renommer, sous-groupe, supprimer)
 *
 * Utilise event delegation sur #subjectsList pour fonctionner
 * même après les re-rendus de la liste.
 */

import {
  getCurrentGroupsData,
  saveGroupsData,
  refreshSubjectsDisplay
} from './analysis.js';

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
  getGroupsForSubject
} from './groups.js';
import { toastError, toastSuccess, showConfirmModal } from './toast.js';

const GROUP_COLORS = [
  { name: 'Rouge',   value: '#ef4444' },
  { name: 'Orange',  value: '#f97316' },
  { name: 'Ambre',   value: '#f59e0b' },
  { name: 'Vert',    value: '#22c55e' },
  { name: 'Émeraude',value: '#10b981' },
  { name: 'Cyan',    value: '#06b6d4' },
  { name: 'Bleu',    value: '#3b82f6' },
  { name: 'Indigo',  value: '#6366f1' },
  { name: 'Violet',  value: '#a855f7' },
  { name: 'Rose',    value: '#ec4899' },
];

let menuEl = null;

// ─── Initialisation ──────────────────────────────────────────────────────────

export function initGroupContextMenu() {
  menuEl = document.getElementById('groupContextMenu');
  if (!menuEl) return;

  // Fermeture sur clic extérieur ou Echap
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

  // Délégation sur #subjectsList (persiste entre les re-rendus)
  const subjectsList = document.getElementById('subjectsList');
  if (subjectsList) {
    subjectsList.addEventListener('contextmenu', handleContextMenu);
  }
}

function closeMenu() {
  if (menuEl) menuEl.style.display = 'none';
}

// ─── Dispatch selon la cible ──────────────────────────────────────────────────

function handleContextMenu(event) {
  event.preventDefault();

  const data = getCurrentGroupsData();

  // Clic droit sur un sujet
  const drawer = event.target.closest('.subject-drawer');
  if (drawer) {
    const subjectKey = drawer.getAttribute('data-subject');
    if (subjectKey) {
      buildSubjectMenu(subjectKey, data);
      positionMenu(event.clientX, event.clientY);
      return;
    }
  }

  // Clic droit sur un groupe
  const groupItem = event.target.closest('.group-item');
  if (groupItem) {
    const groupId = groupItem.getAttribute('data-group-id');
    if (groupId && data) {
      buildGroupMenu(groupId, data);
      positionMenu(event.clientX, event.clientY);
    }
  }
}

// ─── Menu sujet ───────────────────────────────────────────────────────────────

function buildSubjectMenu(subjectKey, data) {
  menuEl.innerHTML = '';

  // ── Section "Ajouter à" ──
  const addLabel = makeLabel('Ajouter à');
  menuEl.appendChild(addLabel);

  if (data && data.groups.length > 0) {
    const memberIds = getGroupsForSubject(data, subjectKey);
    const rootGroups = getChildGroups(data, null);

    rootGroups.forEach(group => {
      menuEl.appendChild(makeGroupOption(group, subjectKey, memberIds, data, false));
      getChildGroups(data, group.id).forEach(child => {
        menuEl.appendChild(makeGroupOption(child, subjectKey, memberIds, data, true));
      });
    });
  }

  // Option "Nouveau groupe…"
  const newGroupItem = makeItem('＋ Nouveau groupe…', 'context-menu-item--accent');
  newGroupItem.addEventListener('click', () => {
    closeMenu();
    promptCreateGroupAndAdd(subjectKey);
  });
  menuEl.appendChild(newGroupItem);

  // ── Section "Retirer de" (visible seulement si déjà membre) ──
  if (data) {
    const memberIds = getGroupsForSubject(data, subjectKey);
    if (memberIds.length > 0) {
      menuEl.appendChild(makeSeparator());
      memberIds.forEach(groupId => {
        const group = data.groups.find(g => g.id === groupId);
        if (!group) return;
        const removeItem = makeItem(`Retirer de "${group.name}"`, 'context-menu-item--danger');
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

  // ── Section "Exclure" ──
  menuEl.appendChild(makeSeparator());
  const excludeItem = makeItem('Exclure ce sujet', 'context-menu-item--danger', 'icon-ban');
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

  const item = makeItem(`${prefix}${group.name}`, childClass + checkedClass, alreadyMember ? 'icon-check' : '');

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

// ─── Menu groupe ─────────────────────────────────────────────────────────────

function buildGroupMenu(groupId, data) {
  menuEl.innerHTML = '';
  const group = data.groups.find(g => g.id === groupId);
  if (!group) return;

  // Renommer
  const renameItem = makeItem('Renommer', '', 'icon-edit');
  renameItem.addEventListener('click', () => {
    closeMenu();
    promptRenameGroup(groupId, group.name, data);
  });
  menuEl.appendChild(renameItem);

  // Ajouter un sous-groupe (uniquement si groupe racine)
  if (group.parentId === null) {
    const addSubItem = makeItem('Ajouter un sous-groupe', '', 'icon-folder');
    addSubItem.addEventListener('click', () => {
      closeMenu();
      promptCreateSubGroup(groupId, data);
    });
    menuEl.appendChild(addSubItem);
  }

  menuEl.appendChild(makeSeparator());

  // Palette de couleurs
  menuEl.appendChild(makeLabel('Couleur du dossier'));
  menuEl.appendChild(makeColorPicker(groupId, group.color || null, data));

  menuEl.appendChild(makeSeparator());

  // Supprimer
  const deleteItem = makeItem('Supprimer', 'context-menu-item--danger', 'icon-trash');
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

  // Bouton "Aucune couleur"
  const noneBtn = document.createElement('button');
  noneBtn.className = 'color-swatch color-swatch--none';
  noneBtn.title = 'Aucune couleur';
  noneBtn.setAttribute('aria-label', 'Aucune couleur');
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

// ─── Actions asynchrones ─────────────────────────────────────────────────────

async function promptCreateGroupAndAdd(subjectKey) {
  const name = window.prompt('Nom du nouveau groupe :');
  if (!name || !name.trim()) return;

  const data = getCurrentGroupsData();
  if (!data) return;

  try {
    const newGroupId = createGroup(data, name.trim(), null);
    addSubjectToGroup(data, subjectKey, newGroupId);
    await saveGroupsData();
    refreshSubjectsDisplay();
  } catch (e) {
    toastError('Erreur : ' + e.message);
  }
}

async function promptRenameGroup(groupId, currentName, data) {
  const newName = window.prompt('Nouveau nom :', currentName);
  if (!newName || !newName.trim() || newName.trim() === currentName) return;

  renameGroup(data, groupId, newName.trim());
  await saveGroupsData();
  refreshSubjectsDisplay();
}

async function promptCreateSubGroup(parentId, data) {
  const name = window.prompt('Nom du sous-groupe :');
  if (!name || !name.trim()) return;

  try {
    createGroup(data, name.trim(), parentId);
    await saveGroupsData();
    refreshSubjectsDisplay();
  } catch (e) {
    toastError('Erreur : ' + e.message);
  }
}

async function confirmDeleteGroup(groupId, groupName, data) {
  const ok = await showConfirmModal({
    title: 'Supprimer le groupe',
    message: `Supprimer le groupe \u00ab\u00a0${groupName}\u00a0\u00bb\u00a0?<br><br>Les sujets seront lib\u00e9r\u00e9s (non supprim\u00e9s).`,
    html: true,
    type: 'warning',
    confirmText: 'Supprimer',
  });
  if (!ok) return;

  deleteGroup(data, groupId);
  await saveGroupsData();
  refreshSubjectsDisplay();
}

async function excludeSubject(subjectKey) {
  const ok = await showConfirmModal({
    title: 'Exclure ce sujet',
    message: `Exclure le sujet \u00ab\u00a0${subjectKey}\u00a0\u00bb de l\u2019affichage\u00a0?<br><br>Les emails de ce sujet seront aussi supprim\u00e9s du fichier local. Il ne sera plus t\u00e9l\u00e9charg\u00e9 \u00e0 l\u2019avenir.`,
    html: true,
    type: 'warning',
    confirmText: 'Exclure',
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
    toastSuccess(`Sujet exclu : \u00ab\u00a0${subjectKey}\u00a0\u00bb`);

    // Cleanup JSONL in background
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const provider = urlParams.get('provider') || 'gmail';
      const userId = urlParams.get('email');
      if (userId) {
        const result = await cleanupExcludedSubjectFromJSONL(provider, userId, subjectKey);
        console.log(`🗑️ JSONL nettoyé: ${result.removed} emails supprimés`);
      }
    } catch (e) {
      console.warn('⚠️ Nettoyage JSONL échoué (le sujet reste exclu de l\'affichage):', e);
    }
  }
}

// ─── Helpers DOM ─────────────────────────────────────────────────────────────

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
  // Afficher d'abord pour mesurer
  menuEl.style.display = 'block';

  const menuWidth = menuEl.offsetWidth || 200;
  const menuHeight = menuEl.offsetHeight || 150;

  const finalX = x + menuWidth > window.innerWidth ? x - menuWidth : x;
  const finalY = y + menuHeight > window.innerHeight ? y - menuHeight : y;

  menuEl.style.left = Math.max(4, finalX) + 'px';
  menuEl.style.top = Math.max(4, finalY) + 'px';
}
