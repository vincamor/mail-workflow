/**
 * Conversation analysis module
 */

import { getEmailFileHandle } from './folders.js';
import { hideLoadingOverlay, updateLoadingOverlay } from './ui.js';
import { showGuideModal } from './toast.js';
import { getCurrentFilters } from './filterUI.js';
import { migrateJsonlIfNeeded } from './emails.js';
import {
  readGroups,
  writeGroups,
  getUserFolderHandle,
  getChildGroups,
  getSubjectsInGroup,
  toggleFavoriteSubject,
  toggleFavoriteGroup,
  isSubjectFavorite,
  isGroupFavorite,
} from './groups.js';

// Callback to select a subject (injected by app.js to avoid the circular import)
let _selectSubjectHandler = null;
export function setSelectSubjectHandler(fn) {
  _selectSubjectHandler = fn;
}

// Callbacks notified when a subject becomes active (selected in the sidebar)
const subjectSelectedCallbacks = [];

export function onSubjectSelected(callback) {
  subjectSelectedCallbacks.push(callback);
}

function notifySubjectSelected(subjectKey, subjectInfo) {
  for (const cb of subjectSelectedCallbacks) {
    try {
      cb(subjectKey, subjectInfo);
    } catch (e) {
      console.warn('onSubjectSelected cb error:', e);
    }
  }
}

// Global variables for analysis state
let currentSubjects = [];
let currentOpenSubject = null;
let currentTreeContainerId = null;
const currentEmailsMap = new Map(); // Map storing full emails by ID

// Variables for groups (loaded after each analysis)
let currentGroupsData = null;
let groupsProvider = 'gmail';
let groupsUserId = null;

// Whether the favourites filter is active
let currentFavoritesOnly = false;
let currentMyConversationsOnly = false;

// Full list display (triggered by the "+N conversations" indicator).
// Without this, subjects 11..N are unreachable (the indicator was not clickable).
let showAllSubjects = false;
// Last set of subjects passed to displaySubjects (so "show all" re-renders identically).
let lastDisplayedSubjects = [];

// State for progressive/incremental analysis
let currentSelectedSubject = null; // Subject name currently displayed in tree
let pendingNewEmailsCount = 0; // New emails for the selected subject since last tree build

export function getCurrentSubjects() {
  return currentSubjects;
}

export function getCurrentTreeContainerId() {
  return currentTreeContainerId;
}

export function getSelectedSubject() {
  return currentSelectedSubject;
}

export function getEmailById(emailId) {
  return currentEmailsMap.get(emailId);
}

// ─── Exports for group management (used by the context menu) ─────────────────

export function getCurrentGroupsData() {
  return currentGroupsData;
}

export async function saveGroupsData() {
  if (!currentGroupsData || !groupsUserId) return;
  const ugfh = await getUserFolderHandle(groupsUserId);
  if (ugfh) await writeGroups(ugfh, groupsProvider, currentGroupsData);
}

export function refreshSubjectsDisplay() {
  displaySubjects(currentSubjects);
}

export function toggleFavoritesFilter() {
  currentFavoritesOnly = !currentFavoritesOnly;
  // Update the button in the header
  const btn = document.getElementById('favoritesFilterBtn');
  if (btn) btn.classList.toggle('active', currentFavoritesOnly);
  displaySubjects(currentSubjects);
}

export function toggleMyConversationsFilter() {
  currentMyConversationsOnly = !currentMyConversationsOnly;
  const btn = document.getElementById('myConversationsBtn');
  if (btn) btn.classList.toggle('active', currentMyConversationsOnly);
  displaySubjects(currentSubjects);
}

export function clearTreeNotification() {
  const banner = document.getElementById('treeNewEmailsBanner');
  if (banner) banner.style.display = 'none';
  pendingNewEmailsCount = 0;
}

function notifyNewEmailsForSubject(count) {
  const banner = document.getElementById('treeNewEmailsBanner');
  const text = document.getElementById('treeNewEmailsText');
  if (!banner || !text) return;

  pendingNewEmailsCount = count;
  if (count > 0) {
    text.textContent = `${count} new email${count > 1 ? 's' : ''} for this subject`;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

/**
 * Incremental analysis: update subjects from a growing email buffer.
 * Called by the download milestone callback.
 * @param {Object} emailAnalyzer - The emailAnalyzer module
 * @param {Array} rawEmails - All accumulated raw emails so far
 * @param {Object} options - { isFinal, totalReceived, totalRequested }
 */
export function incrementalAnalyze(emailAnalyzer, rawEmails, options = {}) {
  const { isFinal = false } = options;

  // Clean all emails
  const emailsClean = rawEmails.map(emailAnalyzer.cleanEmail);
  // Release bodyText to save memory
  emailsClean.forEach((e) => {
    e.bodyText = '';
  });

  // Extract subjects with minCount >= 3
  const userEmail = new URLSearchParams(window.location.search).get('email') || '';
  const validSubjects = emailAnalyzer.getSubjectsWithMinEmails(emailsClean, 3, userEmail);

  // Check whether the selected subject got new emails
  if (currentSelectedSubject) {
    const prevSubject = currentSubjects.find((s) => s.subject === currentSelectedSubject);
    const newSubject = validSubjects.find((s) => s.subject === currentSelectedSubject);
    const prevCount = prevSubject ? prevSubject.emailCount : 0;
    const newCount = newSubject ? newSubject.emailCount : 0;
    if (newCount > prevCount) {
      notifyNewEmailsForSubject(newCount - prevCount + pendingNewEmailsCount);
    }
  }

  // Update global state
  currentSubjects = validSubjects;

  // Preserve UI state: scroll position
  const subjectsList = document.getElementById('subjectsList');
  const scrollTop = subjectsList ? subjectsList.scrollTop : 0;

  // Show the subjects list and navigation on the first meaningful update
  const loadingAnalysis = document.getElementById('loadingAnalysis');
  const searchSection = document.getElementById('searchSection');
  const subjectNavigationBar = document.getElementById('subjectNavigationBar');

  if (validSubjects.length > 0) {
    if (loadingAnalysis) loadingAnalysis.style.display = 'none';
    if (searchSection) searchSection.style.display = 'block';
    if (subjectNavigationBar) subjectNavigationBar.style.display = 'flex';
    if (subjectsList) subjectsList.style.display = 'block';
    const defaultView = document.getElementById('defaultView');
    if (defaultView) defaultView.style.display = 'none';
  }

  // Re-render subjects
  displaySubjects(currentSubjects);

  // Restore the scroll position
  if (subjectsList) subjectsList.scrollTop = scrollTop;

  // Re-activate the selected subject drawer if it exists
  if (currentOpenSubject) {
    const activeDrawer = document.querySelector(`[data-subject-id="${currentOpenSubject}"]`);
    if (activeDrawer) {
      activeDrawer.classList.add('active');
      const activeHeader = activeDrawer.querySelector('.subject-drawer-header');
      if (activeHeader) activeHeader.setAttribute('aria-expanded', 'true');
      const chevron = activeDrawer.querySelector('.subject-drawer-chevron');
      if (chevron) chevron.textContent = '▼';
    }
  }

  // Set up the search handler
  const searchInput = document.getElementById('subjectSearch');
  if (searchInput) {
    searchInput.removeEventListener('input', filterSubjects);
    searchInput.addEventListener('input', filterSubjects);
  }

  console.log(
    `📊 Incremental analysis${isFinal ? ' (final)' : ''}: ${validSubjects.length} subjects (${rawEmails.length} emails)`
  );
}

export function initTreeNotificationBanner(onRefresh) {
  const refreshBtn = document.getElementById('treeNewEmailsRefreshBtn');
  const dismissBtn = document.getElementById('treeNewEmailsDismissBtn');

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      clearTreeNotification();
      if (onRefresh && currentSelectedSubject) {
        onRefresh(currentSelectedSubject);
      }
    });
  }

  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      clearTreeNotification();
    });
  }
}

// Automatic conversation analysis function
export async function autoAnalyzeConversations(emailAnalyzer, treeVisualization, provider, email) {
  console.log('🔍 DEBUG autoAnalyze - Starting');

  try {
    const currentProvider = provider || 'gmail';
    const currentEmail = email;

    if (!currentEmail) {
      console.log('❌ No user signed in');
      return;
    }

    // Update the overlay
    updateLoadingOverlay('Analysing conversations...', 50);

    // Change the loading bar text for the analysis
    const loadingAnalysis = document.getElementById('loadingAnalysis');
    const searchSection = document.getElementById('searchSection');
    const loadingTextSpan = document.querySelector('#loadingAnalysis .loading-text');

    if (loadingTextSpan) {
      loadingTextSpan.innerHTML = '<span id="loadingPercentage">0%</span> - Analysing...';
    }
    document.getElementById('loadingPercentage').textContent = '0%';
    document.getElementById('loadingProgress').style.width = '0%';

    // Show the loading bar
    loadingAnalysis.style.display = 'block';
    searchSection.style.display = 'none';

    // Get the JSONL file handle
    const fileInfo = await getEmailFileHandle(currentEmail, currentProvider);

    if (!fileInfo || !fileInfo.exists) {
      loadingAnalysis.style.display = 'none';
      hideLoadingOverlay();
      const fileName = fileInfo?.fileName || `${currentProvider}_emails.jsonl`;
      console.log(`⚠️ File ${fileName} not found.`);

      // Show a guide to the user
      showGuideModal({
        title: 'No email file found',
        icon: '\uD83D\uDCC1',
        type: 'warning',
        body: `
          <p>The file <code>${fileName}</code> does not exist in your folder.</p>
          <p>To analyse your conversations, you must first:</p>
          <ol class="guide-steps">
            <li class="guide-step-item">
              <span class="guide-step-badge">1</span>
              <span class="guide-step-text">Select a backup folder</span>
            </li>
            <li class="guide-step-item">
              <span class="guide-step-badge">2</span>
              <span class="guide-step-text">Download your emails (the &laquo; Download emails &raquo; button)</span>
            </li>
            <li class="guide-step-item">
              <span class="guide-step-badge">3</span>
              <span class="guide-step-text">Run the conversation analysis again</span>
            </li>
          </ol>
          <div class="guide-hint">\uD83D\uDCA1 Emails are downloaded in batches of 500 with automatic filters.</div>
        `,
        buttonText: 'Got it',
      });

      return false;
    }

    console.log('🔍 DEBUG userId:', currentEmail);
    console.log('🔍 DEBUG fileInfo:', fileInfo);

    // Hide the default view
    document.getElementById('defaultView').style.display = 'none';

    // Migrate old JSONL format if needed (extract bodyHtml to companion file)
    await migrateJsonlIfNeeded(currentProvider, currentEmail);

    // Load subjects in chunks (optimised version)
    await loadSubjectsFromHandleChunkedOptimized(
      emailAnalyzer,
      fileInfo.fileHandle,
      500,
      currentProvider,
      currentEmail
    );

    // Hide the loading bar and show the search
    loadingAnalysis.style.display = 'none';
    searchSection.style.display = 'block';

    // Show the "Subject" title
    document.getElementById('subjectNavigationBar').style.display = 'flex';

    // Hide the overlay once the analysis is complete
    updateLoadingOverlay('Analysis complete!', 100);
    setTimeout(() => hideLoadingOverlay(), 500);
    return true;
  } catch (e) {
    document.getElementById('loadingAnalysis').style.display = 'none';
    hideLoadingOverlay();
    console.error('❌ Error during automatic analysis:', e.message);
    return false;
  }
}

// Load subjects in chunks (optimised version using emailAnalyzer)
async function loadSubjectsFromHandleChunkedOptimized(
  emailAnalyzer,
  fileHandle,
  chunkSize = 500,
  provider = 'gmail',
  userId = null
) {
  const subjectsList = document.getElementById('subjectsList');
  const loadingProgress = document.getElementById('loadingProgress');
  const loadingPercentage = document.getElementById('loadingPercentage');

  subjectsList.style.display = 'none';
  subjectsList.innerHTML = '<p class="no-data">Loading...</p>';

  // Declared outside the try so the finally block can always stop it, even if
  // loadEmailsFromHandle throws (otherwise the interval keeps running in the background).
  let progressInterval = null;

  try {
    // Simulate progress (emailAnalyzer loads everything in one go)
    let progress = 0;
    progressInterval = setInterval(() => {
      progress += Math.random() * 15;
      if (progress > 90) progress = 90;
      loadingProgress.style.width = progress + '%';
      loadingPercentage.textContent = Math.round(progress) + '%';
      // Update the overlay too
      updateLoadingOverlay('Analysing conversations...', progress);
    }, 200);

    // Use emailAnalyzer to load emails in chunks
    const emails = await emailAnalyzer.loadEmailsFromHandle(fileHandle, chunkSize);

    clearInterval(progressInterval);
    loadingProgress.style.width = '100%';
    loadingPercentage.textContent = '100%';
    updateLoadingOverlay('Finalising the analysis...', 95);

    if (emails.length === 0) {
      subjectsList.innerHTML = '<p class="no-data">No email found</p>';
      subjectsList.style.display = 'block';
      hideLoadingOverlay();
      return;
    }

    // Clean the emails with emailAnalyzer
    const emailsClean = emails.map(emailAnalyzer.cleanEmail);

    // Release the raw array immediately: emailsClean is the only copy needed.
    // Without this, both arrays coexist in memory until the GC catches up.
    emails.length = 0;

    // Release bodyText in the cleaned emails: getSubjectsWithMinEmails does not need it
    // (it only uses subject, from, date and _chunkIndex).
    // bodyText is reloaded on demand when a subject is selected (getEmailsForSubjectOptimized).
    emailsClean.forEach((e) => {
      e.bodyText = '';
    });

    // Get the subjects along with the chunk index
    const validSubjects = emailAnalyzer.getSubjectsWithMinEmails(emailsClean, 3, userId);

    currentSubjects = validSubjects;

    // Load groups into memory before display
    groupsProvider = provider;
    groupsUserId = userId;
    const ugfh = await getUserFolderHandle(userId);
    currentGroupsData = ugfh ? await readGroups(ugfh, provider) : null;

    displaySubjects(currentSubjects);

    // Show the list
    subjectsList.style.display = 'block';

    // Add the search event listener (only once)
    const searchInput = document.getElementById('subjectSearch');
    searchInput.removeEventListener('input', filterSubjects);
    searchInput.addEventListener('input', filterSubjects);

    console.log(`✅ Analysis complete: ${validSubjects.length} subjects found with chunk index`);
  } catch (error) {
    subjectsList.innerHTML = `<p class="no-data" style="color: var(--error);">❌ Error: ${escapeHtml(error.message)}</p>`;
    subjectsList.style.display = 'block';
    hideLoadingOverlay();
  } finally {
    // Always stop the progress interval, including on error.
    if (progressInterval) clearInterval(progressInterval);
  }
}

// ─── Display utilities ─────────────────────────────────────────────────────

/** Local helpers for favourite state (avoid passing data as a parameter everywhere) */
function isSubjectFav(subjectKey) {
  return currentGroupsData ? isSubjectFavorite(currentGroupsData, subjectKey) : false;
}
function isGroupFav(groupId) {
  return currentGroupsData ? isGroupFavorite(currentGroupsData, groupId) : false;
}

/** Returns a stable ID for a subject based on its position in currentSubjects */
function getStableSubjectId(subjectKey) {
  const idx = currentSubjects.findIndex((s) => s.subject === subjectKey);
  return `subject-${idx >= 0 ? idx : 'u-' + subjectKey.substring(0, 12).replace(/\s+/g, '-')}`;
}

/** Escapes HTML characters in a string */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Generates the HTML for a subject drawer */
function renderSubjectItemHtml(subject, stableId, isGrouped = false) {
  const groupedClass = isGrouped ? ' subject-drawer--grouped' : '';
  const isFav = isSubjectFav(subject.subject);
  const starClass = isFav ? ' is-favorite' : '';
  const starTitle = isFav ? 'Remove from favourites' : 'Add to favourites';
  const starChar = isFav ? '★' : '☆';
  return `
    <div class="subject-drawer${groupedClass}" data-subject="${escapeHtml(subject.subject)}" data-subject-id="${stableId}">
      <div class="subject-drawer-header" role="button" tabindex="0" aria-expanded="false">
        <div class="subject-drawer-content">
          <div class="subject-drawer-title">${escapeHtml(subject.subject)}</div>
          <div class="subject-drawer-meta">
            ${subject.emailCount || subject.count || 0} emails${subject.userReplied ? '<span class="badge-replied" title="You took part">↩</span>' : ''}${subject.isNewsletter ? '<span class="badge-newsletter" title="Newsletter detected">📰</span>' : ''}${subject.userInCcOnly ? '<span class="badge-cc" title="CC only">cc</span>' : ''}
          </div>
        </div>
        <button class="star-btn${starClass}" data-star-subject="${escapeHtml(subject.subject)}" title="${starTitle}">${starChar}</button>
        <div class="subject-drawer-chevron">›</div>
      </div>
    </div>`;
}

/** Generates the HTML for a "N more subjects" indicator */
function renderMoreIndicatorHtml(remainingCount) {
  const plural = remainingCount > 1 ? 's' : '';
  return `
    <div class="more-subjects-indicator" role="button" tabindex="0" data-more-subjects="1" aria-label="Show ${remainingCount} more conversation${plural}">
      <div class="more-subjects-dots">•••</div>
      <div class="more-subjects-text">+${remainingCount} conversation${plural}</div>
    </div>`;
}

/** Attaches the expand behaviour to the "+N conversations" indicator */
function attachMoreIndicator(container) {
  container.querySelectorAll('[data-more-subjects]').forEach((indicator) => {
    const activate = () => {
      showAllSubjects = true;
      displaySubjects(lastDisplayedSubjects);
    };
    indicator.addEventListener('click', activate);
    indicator.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
  });
}

/** Recursively generates the HTML for a group and its content */
function renderGroupItemHtml(
  group,
  subjectMap,
  renderedKeys,
  isNested,
  showEmptyPlaceholder = true
) {
  const subjectKeysInGroup = getSubjectsInGroup(currentGroupsData, group.id);

  let contentHtml = '';

  // Sub-groups (root level only, max 2 levels)
  if (!isNested) {
    const childGroups = getChildGroups(currentGroupsData, group.id);
    childGroups.forEach((child) => {
      contentHtml += renderGroupItemHtml(
        child,
        subjectMap,
        renderedKeys,
        true,
        showEmptyPlaceholder
      );
    });
  }

  // Subjects directly in this group
  subjectKeysInGroup.forEach((key) => {
    const subject = subjectMap.get(key);
    if (!subject) return;
    renderedKeys.add(key);
    contentHtml += renderSubjectItemHtml(subject, getStableSubjectId(key), true);
  });

  // Empty group
  if (!contentHtml) {
    if (!showEmptyPlaceholder) return ''; // In favourites mode: hide empty groups
    contentHtml =
      '<div class="group-empty-placeholder">No subject — right-click a subject to add it</div>';
  }

  // Count of subjects visible in this group
  const visibleCount = subjectKeysInGroup.filter((k) => subjectMap.has(k)).length;
  const nestClass = isNested ? ' group-item--nested' : '';
  const isFav = isGroupFav(group.id);
  const starClass = isFav ? ' is-favorite' : '';
  const starTitle = isFav ? 'Remove from favourites' : 'Add to favourites';
  const starChar = isFav ? '★' : '☆';
  const folderColor = group.color || '#94a3b8';
  const iconHtml = `<span class="group-folder-icon" style="color:${folderColor}"><svg width="15" height="13" viewBox="0 0 20 16" fill="currentColor" aria-hidden="true"><path d="M0 2C0 .9.9 0 2 0h5l2 2h9c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2H2c-1.1 0-2-.9-2-2V2z"/></svg></span>`;

  return `
    <div class="group-item${nestClass}" data-group-id="${group.id}">
      <div class="group-header" role="button" tabindex="0" aria-expanded="false">
        ${iconHtml}
        <span class="group-name">${escapeHtml(group.name)}</span>
        ${visibleCount > 0 ? `<span class="group-badge">${visibleCount}</span>` : ''}
        <button class="star-btn${starClass}" data-star-group="${group.id}" title="${starTitle}">${starChar}</button>
        <span class="group-chevron">›</span>
      </div>
      <div class="group-content">${contentHtml}</div>
    </div>`;
}

/** Attaches listeners to every .subject-drawer in a container */
function attachSubjectListeners(container) {
  container.querySelectorAll('.subject-drawer').forEach((drawer) => {
    const header = drawer.querySelector('.subject-drawer-header');
    if (!header) return;

    // Favourite star — stopPropagation so it does not open the drawer
    const starBtn = header.querySelector('.star-btn[data-star-subject]');
    if (starBtn) {
      starBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const key = starBtn.getAttribute('data-star-subject');
        if (!currentGroupsData || !key) return;
        const isFav = toggleFavoriteSubject(currentGroupsData, key);
        starBtn.classList.toggle('is-favorite', isFav);
        starBtn.title = isFav ? 'Remove from favourites' : 'Add to favourites';
        await saveGroupsData();
        // Refresh only if the favourites filter is active
        if (currentFavoritesOnly) refreshSubjectsDisplay();
      });
    }

    header.addEventListener('click', () => {
      toggleSubjectDrawer(
        drawer,
        drawer.getAttribute('data-subject'),
        drawer.getAttribute('data-subject-id')
      );
    });

    // Keyboard: Enter/Space activates the drawer (unless focus is on the star).
    header.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('.star-btn')) return;
      e.preventDefault();
      toggleSubjectDrawer(
        drawer,
        drawer.getAttribute('data-subject'),
        drawer.getAttribute('data-subject-id')
      );
    });
  });
}

/** Attaches toggle listeners to every .group-header in a container */
function attachGroupListeners(container) {
  container.querySelectorAll('.group-item').forEach((groupItem) => {
    const header = groupItem.querySelector(':scope > .group-header');
    if (!header) return;

    // Group's favourite star
    const starBtn = header.querySelector('.star-btn[data-star-group]');
    if (starBtn) {
      starBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const groupId = starBtn.getAttribute('data-star-group');
        if (!currentGroupsData || !groupId) return;
        const isFav = toggleFavoriteGroup(currentGroupsData, groupId);
        starBtn.classList.toggle('is-favorite', isFav);
        starBtn.title = isFav ? 'Remove from favourites' : 'Add to favourites';
        await saveGroupsData();
        if (currentFavoritesOnly) refreshSubjectsDisplay();
      });
    }

    const toggleGroup = () => {
      const open = groupItem.classList.toggle('open');
      header.setAttribute('aria-expanded', open ? 'true' : 'false');
    };

    header.addEventListener('click', toggleGroup);

    header.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('.star-btn')) return;
      e.preventDefault();
      toggleGroup();
    });
  });
}

// ─── List rendering functions ──────────────────────────────────────────────

/** Flat rendering (search mode or no groups) — max 10 subjects */
function renderFlatSubjectsList(subjectsList, subjects) {
  const limit = showAllSubjects ? subjects.length : 10;
  const limited = subjects.slice(0, limit);
  const hasMore = subjects.length > limit;

  let html = limited
    .map((subject) => renderSubjectItemHtml(subject, getStableSubjectId(subject.subject)))
    .join('');

  if (hasMore) {
    html += renderMoreIndicatorHtml(subjects.length - limit);
  }

  subjectsList.innerHTML = html;
  attachSubjectListeners(subjectsList);
  attachMoreIndicator(subjectsList);
}

/** Grouped rendering (normal mode with groups) */
function renderGroupedSubjectsList(subjectsList, subjects, hideEmptyGroups = false) {
  const subjectMap = new Map(subjects.map((s) => [s.subject, s]));
  const renderedKeys = new Set();

  const rootGroups = getChildGroups(currentGroupsData, null);
  let html = rootGroups
    .map((group) => renderGroupItemHtml(group, subjectMap, renderedKeys, false, !hideEmptyGroups))
    .join('');

  // Ungrouped subjects
  const ungrouped = subjects.filter((s) => !renderedKeys.has(s.subject));
  if (ungrouped.length > 0 && rootGroups.length > 0) {
    html += `<div class="ungrouped-separator"><span>Ungrouped</span></div>`;
  }

  const ungroupedLimit = showAllSubjects ? ungrouped.length : 10;
  const limitedUngrouped = ungrouped.slice(0, ungroupedLimit);
  html += limitedUngrouped
    .map((subject) => renderSubjectItemHtml(subject, getStableSubjectId(subject.subject)))
    .join('');

  if (ungrouped.length > ungroupedLimit) {
    html += renderMoreIndicatorHtml(ungrouped.length - ungroupedLimit);
  }

  subjectsList.innerHTML = html;
  attachSubjectListeners(subjectsList);
  attachGroupListeners(subjectsList);
  attachMoreIndicator(subjectsList);
}

/**
 * Search rendering with groups.
 * - Groups whose NAME matches → shown open with ALL their subjects
 * - Groups containing matching subjects → shown open with only the matching subjects
 * - Matching ungrouped subjects → shown below
 */
function renderSearchGroupedSubjectsList(subjectsList, subjects, searchTerm) {
  const lowerSearch = searchTerm.toLowerCase();

  // Map of subjects matching the search (filtered by filterSubjects)
  const matchingMap = new Map(subjects.map((s) => [s.subject, s]));
  // Map of ALL subjects (for groups whose name matches)
  const allMap = new Map(currentSubjects.map((s) => [s.subject, s]));

  const renderedKeys = new Set();
  const rootGroups = getChildGroups(currentGroupsData, null);
  let html = '';

  rootGroups.forEach((group) => {
    const nameMatches = group.name.toLowerCase().includes(lowerSearch);
    const mapToUse = nameMatches ? allMap : matchingMap;

    // In search mode, only show a group if its name matches
    // OR it contains at least one matching subject/sub-group
    if (!nameMatches) {
      const directKeys = getSubjectsInGroup(currentGroupsData, group.id);
      const childGroups = getChildGroups(currentGroupsData, group.id);
      const hasMatchingContent =
        directKeys.some((k) => matchingMap.has(k)) ||
        childGroups.some((child) =>
          getSubjectsInGroup(currentGroupsData, child.id).some((k) => matchingMap.has(k))
        );
      if (!hasMatchingContent) return;
    }

    html += renderGroupItemHtml(group, mapToUse, renderedKeys, false);
  });

  // Matching subjects not yet shown in a group
  const ungrouped = subjects.filter((s) => !renderedKeys.has(s.subject));
  if (ungrouped.length > 0 && html.length > 0) {
    html += `<div class="ungrouped-separator"><span>Ungrouped</span></div>`;
  }
  html += ungrouped.map((s) => renderSubjectItemHtml(s, getStableSubjectId(s.subject))).join('');

  if (!html) {
    subjectsList.innerHTML = '<p class="no-data">No results</p>';
    return;
  }

  subjectsList.innerHTML = html;
  attachSubjectListeners(subjectsList);
  attachGroupListeners(subjectsList);
  attachMoreIndicator(subjectsList);
  // Auto-open every group in search mode so results are visible
  subjectsList.querySelectorAll('.group-item').forEach((gi) => {
    gi.classList.add('open');
    const header = gi.querySelector(':scope > .group-header');
    if (header) header.setAttribute('aria-expanded', 'true');
  });
}

// ─── Main display function ─────────────────────────────────────────────────

// Display subjects in the list (handling groups and the favourites filter)
function displaySubjects(subjects) {
  const subjectsList = document.getElementById('subjectsList');

  // Remember the displayed set so the "+N" indicator can re-render everything.
  lastDisplayedSubjects = subjects;

  // Apply favorites filter
  let baseSubjects =
    currentFavoritesOnly && currentGroupsData
      ? subjects.filter((s) => isSubjectFavorite(currentGroupsData, s.subject))
      : subjects;

  // Apply excluded subjects filter
  const filters = getCurrentFilters();
  if (filters && filters.blacklistedSubjects && filters.blacklistedSubjects.length > 0) {
    const excluded = new Set(filters.blacklistedSubjects);
    baseSubjects = baseSubjects.filter((s) => !excluded.has(s.subject));
  }

  // Apply "my conversations" filter
  if (currentMyConversationsOnly) {
    baseSubjects = baseSubjects.filter((s) => s.userReplied || s.userInTo);
  }

  if (baseSubjects.length === 0) {
    subjectsList.innerHTML = currentFavoritesOnly
      ? '<p class="no-data">No favourite subject</p>'
      : '<p class="no-data">No subject found</p>';
    return;
  }

  const searchTerm = document.getElementById('subjectSearch')?.value?.trim() || '';
  const isSearching = searchTerm.length > 0;
  const hasGroups = currentGroupsData && currentGroupsData.groups.length > 0;

  if (!hasGroups) {
    renderFlatSubjectsList(subjectsList, baseSubjects);
  } else if (isSearching) {
    renderSearchGroupedSubjectsList(subjectsList, baseSubjects, searchTerm);
  } else {
    // In favourites mode, hide groups with no favourites (no empty placeholder)
    renderGroupedSubjectsList(subjectsList, baseSubjects, currentFavoritesOnly);
  }
}

// Toggle a subject drawer
function toggleSubjectDrawer(drawer, subject, subjectId) {
  const chevron = drawer.querySelector('.subject-drawer-chevron');

  const header = drawer.querySelector('.subject-drawer-header');

  // If this subject is already open, close it
  if (currentOpenSubject === subjectId) {
    drawer.classList.remove('active');
    if (header) header.setAttribute('aria-expanded', 'false');
    chevron.textContent = '›';
    currentOpenSubject = null;
    currentSelectedSubject = null;
    pendingNewEmailsCount = 0;
    clearTreeNotification();
    return;
  }

  // Close the previously open subject
  if (currentOpenSubject) {
    const previousDrawer = document.querySelector(`[data-subject-id="${currentOpenSubject}"]`);
    if (previousDrawer) {
      previousDrawer.classList.remove('active');
      const prevHeader = previousDrawer.querySelector('.subject-drawer-header');
      if (prevHeader) prevHeader.setAttribute('aria-expanded', 'false');
      previousDrawer.querySelector('.subject-drawer-chevron').textContent = '›';
    }
  }

  // Open the new subject
  drawer.classList.add('active');
  if (header) header.setAttribute('aria-expanded', 'true');
  chevron.textContent = '▼';
  currentOpenSubject = subjectId;
  currentSelectedSubject = subject;
  pendingNewEmailsCount = 0;
  clearTreeNotification();

  // Notify subscribers (e.g. the AI chat button).
  // `subject` here is a string (data-subject attribute) — we look up the
  // full subject object in currentSubjects to pass it as subjectInfo.
  const subjectInfo = currentSubjects.find((s) => s.subject === subject);
  notifySubjectSelected(subject, subjectInfo || { subject });

  // Load the tree (callback injected by app.js)
  if (_selectSubjectHandler) {
    _selectSubjectHandler(subject);
  }
}

// Filter subjects based on the search
function filterSubjects() {
  // New search → we start again from the truncated list (the "+N" expansion
  // is reset on every term change).
  showAllSubjects = false;

  const searchTerm = document.getElementById('subjectSearch').value.toLowerCase();

  if (!searchTerm) {
    displaySubjects(currentSubjects);
    hideSearchingIndicator();
    return;
  }

  // Level 1: instant search in metadata (subject, participants, recipients, snippets)
  const filteredSubjects = currentSubjects.filter(
    (subject) =>
      subject.subject.toLowerCase().includes(searchTerm) ||
      subject.participants.some((p) => p.toLowerCase().includes(searchTerm)) ||
      (subject.recipients && subject.recipients.some((r) => r.includes(searchTerm))) ||
      (subject.allParticipants && subject.allParticipants.some((p) => p.includes(searchTerm))) ||
      (subject.snippets && subject.snippets.includes(searchTerm))
  );

  displaySubjects(filteredSubjects);

  // Level 2: always launch deep body search in parallel
  triggerDeepSearch(searchTerm, filteredSubjects);
}

// ─── Deep search (level 2 — body text) ─────────────────────────────────────

let _deepSearchAbort = null;
let _deepSearchTimeout = null;

/**
 * Runs a streaming search over the JSONL body text.
 * 500ms debounce to avoid launching one on every keystroke.
 */
function triggerDeepSearch(searchTerm, level1Results) {
  // Cancel previous deep search
  if (_deepSearchAbort) _deepSearchAbort.abort = true;
  if (_deepSearchTimeout) clearTimeout(_deepSearchTimeout);

  _deepSearchTimeout = setTimeout(() => {
    performDeepSearch(searchTerm, level1Results);
  }, 500);
}

async function performDeepSearch(searchTerm, level1Results) {
  const abort = { abort: false };
  _deepSearchAbort = abort;

  showSearchingIndicator();

  try {
    const urlParams = new URLSearchParams(window.location.search);
    const provider = urlParams.get('provider') || 'gmail';
    const userEmail = urlParams.get('email');
    if (!userEmail) return;

    const fileInfo = await getEmailFileHandle(userEmail, provider);
    if (!fileInfo || !fileInfo.exists) return;

    const file = await fileInfo.fileHandle.getFile();
    const stream = file.stream();
    const textDecoder = new TextDecoder();
    let buffer = '';

    // Track which subjects matched via body content
    const bodyMatchedSubjects = new Set();
    const level1SubjectNames = new Set(level1Results.map((s) => s.subject));
    const lowerSearch = searchTerm.toLowerCase();

    for await (const chunk of stream) {
      if (abort.abort) return;

      buffer += textDecoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        // Quick string check before parsing
        if (!line.toLowerCase().includes(lowerSearch)) continue;
        try {
          const parsed = JSON.parse(line);
          const bodyText = (parsed.bodyText || '').toLowerCase();
          if (bodyText.includes(lowerSearch)) {
            const subj = (parsed.subject || '').replace(/^(Re:|Fwd:|FW:|RE:|FWD:)\s*/i, '').trim();
            if (subj && !level1SubjectNames.has(subj)) {
              bodyMatchedSubjects.add(subj);
            }
          }
        } catch (e) {
          /* skip malformed lines */
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim() && buffer.toLowerCase().includes(lowerSearch)) {
      try {
        const parsed = JSON.parse(buffer);
        const bodyText = (parsed.bodyText || '').toLowerCase();
        if (bodyText.includes(lowerSearch)) {
          const subj = (parsed.subject || '').replace(/^(Re:|Fwd:|FW:|RE:|FWD:)\s*/i, '').trim();
          if (subj && !level1SubjectNames.has(subj)) {
            bodyMatchedSubjects.add(subj);
          }
        }
      } catch (e) {
        /* skip malformed lines */
      }
    }

    if (abort.abort) return;

    // Merge level 2 results with level 1
    if (bodyMatchedSubjects.size > 0) {
      const deepMatches = currentSubjects.filter((s) => bodyMatchedSubjects.has(s.subject));
      const merged = [...level1Results, ...deepMatches];
      displaySubjects(merged);
    }
  } catch (e) {
    console.warn('Deep search failed:', e.message);
  } finally {
    if (!abort.abort) hideSearchingIndicator();
  }
}

function showSearchingIndicator() {
  const searchInput = document.getElementById('subjectSearch');
  if (searchInput) searchInput.classList.add('searching');

  // Add a loading indicator below the subjects list
  const subjectsList = document.getElementById('subjectsList');
  if (subjectsList && !document.getElementById('deepSearchLoader')) {
    const loader = document.createElement('div');
    loader.id = 'deepSearchLoader';
    loader.className = 'deep-search-loader';
    loader.innerHTML =
      '<div class="deep-search-spinner"></div><span>Searching email content...</span>';
    subjectsList.appendChild(loader);
  }
}

function hideSearchingIndicator() {
  const searchInput = document.getElementById('subjectSearch');
  if (searchInput) searchInput.classList.remove('searching');

  const loader = document.getElementById('deepSearchLoader');
  if (loader) loader.remove();
}

// Select a subject and build the tree
export async function selectSubject(emailAnalyzer, treeVisualization, subject, provider, email) {
  const treeContainer = document.getElementById('treeContainer');
  treeContainer.innerHTML = '<p>⏳ Building the tree...</p>';
  document.getElementById('treeVisualization').style.display = 'block';
  document.getElementById('defaultView').style.display = 'none';

  try {
    const currentProvider = provider || 'gmail';
    const currentEmail = email;

    const fileInfo = await getEmailFileHandle(currentEmail, currentProvider);

    if (!fileInfo || !fileInfo.exists) {
      treeContainer.innerHTML = `
        <div style="padding: 2rem; text-align: center; color: var(--text-secondary);">
          <div style="font-size: 3rem; margin-bottom: 1rem;">📁</div>
          <h3 style="color: var(--error); margin-bottom: 1rem;">Email file not found</h3>
          <p style="margin-bottom: 1rem;">
            The file "${fileInfo?.fileName || `${currentProvider}_emails.jsonl`}" does not exist.
          </p>
          <p style="margin-bottom: 1.5rem;">
            Please download your emails from the left-hand panel first.
          </p>
          <div style="background: var(--bg-secondary); padding: 1rem; border-radius: 8px; font-size: 0.9rem; text-align: left; max-width: 400px; margin: 0 auto;">
            <strong>📝 Steps to follow:</strong><br/>
            1️⃣ Choose a backup folder<br/>
            2️⃣ Click "Download emails"<br/>
            3️⃣ Wait for the download to finish<br/>
            4️⃣ Run the conversation analysis again
          </div>
        </div>
      `;
      return;
    }

    // Find the subject's info in the current list
    const subjectInfo = currentSubjects.find((s) => s.subject === subject);

    if (!subjectInfo) {
      treeContainer.innerHTML = `<p style="color: var(--error);">❌ Subject not found in the list</p>`;
      return;
    }

    // Get the subject's emails using the chunk index (optimised)
    console.log('🔍 DEBUG subjectInfo:', subjectInfo);
    const subjectEmails = await emailAnalyzer.getEmailsForSubjectOptimized(
      fileInfo.fileHandle,
      subjectInfo
    );

    console.log('🔍 DEBUG subjectEmails found:', subjectEmails.length);

    if (subjectEmails.length === 0) {
      treeContainer.innerHTML = `<p style="color: var(--error);">❌ No email found for this subject</p>`;
      return;
    }

    // Clean the emails and build the tree with emailAnalyzer
    const emailsClean = subjectEmails.map(emailAnalyzer.cleanEmail);

    // Store the full emails in the Map for quick access
    currentEmailsMap.clear(); // Clear the previous Map
    emailsClean.forEach((email) => {
      if (email.id) {
        currentEmailsMap.set(email.id, email);
      }
    });

    const tree = emailAnalyzer.createTemporalGroupTree(emailsClean, subject);

    // Use the new visualisation module
    const treeHTML = treeVisualization.createCompleteVisualization(tree, {
      maxDepth: 4,
      showDetails: true,
    });

    treeContainer.innerHTML = treeHTML;

    // Extract the containerId from the generated HTML to store it
    const containerMatch = treeHTML.match(/id="(tree-container-[^"]+)"/);
    if (containerMatch) {
      currentTreeContainerId = containerMatch[1];
    }

    // Update the statistics in the drawer
    document.getElementById('totalEmails').textContent = tree.nodes.length;
    document.getElementById('totalConversations').textContent = tree.links.length;

    // Show the Statistics and Actions sections
    document.getElementById('statisticsSection').style.display = 'block';
    document.getElementById('actionsSection').style.display = 'block';
  } catch (error) {
    treeContainer.innerHTML = `<p style="color: var(--error);">❌ Generation error: ${escapeHtml(error.message)}</p>`;
  }
}
