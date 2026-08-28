/**
 * Filter UI management module
 */

import { loadFilters, saveFilters, resetFilters, getDefaultFilters } from './emailFilters.js';
import { toastSuccess, toastWarning, showConfirmModal } from './toast.js';

let currentFilters = null;
let onFiltersSavedCallback = null;
let onSubjectRestoredCallback = null;
let lastFocusedBeforeModal = null;

/**
 * Initialises the filter UI
 */
export async function initFilterUI() {
  currentFilters = await loadFilters();
  createFilterModal();

  // Add the button in the folder section
  addFilterButton();
}

/**
 * Adds the "Download filters" button in the folder section
 */
function addFilterButton() {
  // Check whether the button already exists
  if (document.getElementById('filterButton')) return;

  // Find the folder container
  const folderContent = document.querySelector('#folderDrawer .folder-content');

  if (!folderContent) {
    console.warn('Folder section not found');
    return;
  }

  const filterButton = document.createElement('button');
  filterButton.id = 'filterButton';
  filterButton.className = 'filter-button';
  filterButton.innerHTML =
    '<span class="btn-icon icon icon-settings" aria-hidden="true"></span><span class="btn-text">Download filters</span>';
  filterButton.onclick = showFilterModal;

  // Insert after step2Guide
  const step2Guide = document.getElementById('step2Guide');
  if (step2Guide) {
    step2Guide.insertAdjacentElement('afterend', filterButton);
  } else {
    // Fallback: append at the end
    folderContent.appendChild(filterButton);
  }
}

/**
 * Creates the filter configuration modal
 */
function createFilterModal() {
  // Check whether the modal already exists
  if (document.getElementById('filterModal')) return;

  const modal = document.createElement('div');
  modal.id = 'filterModal';
  modal.className = 'filter-modal';
  modal.style.display = 'none';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'filterModalTitle');

  modal.innerHTML = `
    <div class="filter-modal-content">
      <!-- Header -->
      <div class="filter-modal-header">
        <h2 id="filterModalTitle"><span class="icon icon-settings icon-inline" aria-hidden="true"></span>Download filters</h2>
        <button id="closeFilterModal" class="filter-modal-close" aria-label="Close the filters window">×</button>
      </div>

      <!-- Body -->
      <div class="filter-modal-body">
        <p class="filter-description">
          Configure the filters to exclude certain emails during download.
          Optimised filters are applied directly in the Gmail API so unwanted emails are never downloaded.
        </p>

        <!-- Filters BEFORE download (Optimised) -->
        <div class="filter-section filter-optimized">
          <h3><span class="icon icon-bolt icon-inline" aria-hidden="true"></span>Optimised filters (applied BEFORE download)</h3>
          <p class="filter-hint" style="color: var(--success); font-weight: 500;">
            <span class="icon icon-check-circle icon-inline" aria-hidden="true"></span>These emails will never be downloaded from Gmail = 30%+ faster download + API quota savings
          </p>

          <label class="filter-checkbox filter-optimized-item">
            <input type="checkbox" id="filterNotifications" checked>
            <span>
              <strong>Exclude automatic notifications (noreply, no-reply)</strong>
            </span>
            <small style="display: block; margin-top: 4px;">
              <strong>Blocked senders:</strong> noreply, no-reply, notification, automated, do-not-reply, donotreply<br>
              <em style="color: var(--success);"><span class="icon icon-check icon-inline" aria-hidden="true"></span>Recommended: these emails usually do not need a reply</em>
            </small>
          </label>

          <label class="filter-checkbox filter-optimized-item">
            <input type="checkbox" id="filterPromotional" checked>
            <span>
              <strong>Exclude promotional emails and newsletters</strong>
            </span>
            <small style="display: block; margin-top: 4px;">
              <strong>Keywords in the subject:</strong> unsubscribe, promo, promotional, offer, sale, discount<br>
              <em style="color: var(--success);"><span class="icon icon-check icon-inline" aria-hidden="true"></span>Recommended: significantly reduces the volume of emails</em>
            </small>
          </label>

          <label class="filter-checkbox filter-optimized-item">
            <input type="checkbox" id="filterAutoExcludeRepetitive" checked>
            <span>
              <strong>Automatic detection of repetitive senders</strong>
            </span>
            <small style="display: block; margin-top: 4px;">
              After 5 emails from the same sender with similar subjects, the following ones are filtered automatically.
              Detected senders are added to the blocklist for future downloads.<br>
              <em style="color: var(--success);"><span class="icon icon-check icon-inline" aria-hidden="true"></span>Recommended: eliminates mailing lists and automated emails</em>
            </small>
          </label>

          <div style="background: var(--bg-tertiary); padding: 12px; border-radius: 8px; margin-top: 12px; border-left: 4px solid var(--warning);">
            <small style="color: var(--text-secondary); font-weight: 500;">
              <span class="icon icon-lightbulb icon-inline" aria-hidden="true"></span><strong>Info:</strong> You can also add specific senders to the "Blocklist" below
            </small>
          </div>
        </div>

        <!-- Date filter -->
        <div class="filter-section">
          <h3><span class="icon icon-calendar icon-inline" aria-hidden="true"></span>Download period</h3>
          <p class="filter-hint">Limit the download to emails received after a given date</p>

          <label class="filter-checkbox">
            <input type="checkbox" id="filterUseCustomAfterDate">
            <span>Only download emails after a date</span>
          </label>

          <div class="filter-input-group" id="customAfterDateGroup" style="display: none; margin-left: 28px;">
            <label>Only download emails received after:</label>
            <input type="date" id="filterCustomAfterDate" style="width: 180px; padding: var(--space-1-5) var(--space-3); border: 1px solid var(--border-light); border-radius: var(--radius-md); font-size: var(--text-sm); background: var(--bg-secondary); color: var(--text-primary);">
          </div>
        </div>

        <!-- Filters AFTER download -->
        <div class="filter-section">
          <h3><span class="icon icon-wrench icon-inline" aria-hidden="true"></span>Standard filters (applied after download)</h3>
          <p class="filter-hint" style="color: var(--warning);">
            <span class="icon icon-alert-triangle icon-inline" aria-hidden="true"></span>These emails will be downloaded then filtered server-side
          </p>

          <label class="filter-checkbox">
            <input type="checkbox" id="filterNoSubject">
            <span>Exclude emails with no subject</span>
            <small>Not supported by the Gmail API - filtered after download</small>
          </label>

          <label class="filter-checkbox">
            <input type="checkbox" id="filterShortConversations">
            <span>Exclude short conversations</span>
          </label>

          <div class="filter-input-group" id="minConversationLengthGroup" style="display: none; margin-left: 28px;">
            <label>Minimum emails per conversation:</label>
            <input type="number" id="minConversationLength" min="2" max="10" value="3">
          </div>
        </div>

        <!-- Sender blocklist -->
        <div class="filter-section">
          <h3><span class="icon icon-ban icon-inline" aria-hidden="true"></span>Sender blocklist</h3>
          <p class="filter-hint">Add the email addresses to block</p>

          <div class="filter-list" id="blacklistedSendersList"></div>

          <div class="filter-add-group">
            <input type="email" id="newBlacklistedSender" placeholder="example@email.com">
            <button id="addBlacklistedSender" class="filter-add-btn">+ Add</button>
          </div>
        </div>

        <!-- Forbidden keywords -->
        <div class="filter-section">
          <h3><span class="icon icon-search icon-inline" aria-hidden="true"></span>Keywords to exclude (in the subject)</h3>
          <p class="filter-hint">Add the keywords to block</p>

          <div class="filter-list" id="blacklistedKeywordsList"></div>

          <div class="filter-add-group">
            <input type="text" id="newBlacklistedKeyword" placeholder="Keyword">
            <button id="addBlacklistedKeyword" class="filter-add-btn">+ Add</button>
          </div>
        </div>

        <!-- Excluded subjects -->
        <div class="filter-section">
          <h3><span class="icon icon-ban icon-inline" aria-hidden="true"></span>Excluded subjects</h3>
          <p class="filter-hint">Subjects hidden from the list (added via right click → Exclude)</p>

          <div class="filter-list" id="blacklistedSubjectsList"></div>
        </div>

        <!-- Statistics -->
        <div class="filter-section filter-stats" id="filterStats" style="display: none;">
          <h3><span class="icon icon-chart icon-inline" aria-hidden="true"></span>Statistics</h3>
          <div id="filterStatsContent"></div>
        </div>
      </div>

      <!-- Footer -->
      <div class="filter-modal-footer">
        <button id="resetFilters" class="filter-btn filter-btn-secondary"><span class="icon icon-refresh icon-inline" aria-hidden="true"></span>Reset</button>
        <button id="saveFilters" class="filter-btn filter-btn-primary"><span class="icon icon-save icon-inline" aria-hidden="true"></span>Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Events
  setupFilterModalEvents();
}

/**
 * Sets up the modal's event handlers
 */
function setupFilterModalEvents() {
  // Closing
  document.getElementById('closeFilterModal').onclick = hideFilterModal;
  document.getElementById('filterModal').onclick = (e) => {
    if (e.target.id === 'filterModal') hideFilterModal();
  };

  // Custom date checkbox
  document.getElementById('filterUseCustomAfterDate').onchange = (e) => {
    const group = document.getElementById('customAfterDateGroup');
    group.style.display = e.target.checked ? 'block' : 'none';
  };

  // Short conversations checkbox
  document.getElementById('filterShortConversations').onchange = (e) => {
    const group = document.getElementById('minConversationLengthGroup');
    group.style.display = e.target.checked ? 'block' : 'none';
  };

  // Add sender
  document.getElementById('addBlacklistedSender').onclick = addBlacklistedSender;
  document.getElementById('newBlacklistedSender').onkeypress = (e) => {
    if (e.key === 'Enter') addBlacklistedSender();
  };

  // Add keyword
  document.getElementById('addBlacklistedKeyword').onclick = addBlacklistedKeyword;
  document.getElementById('newBlacklistedKeyword').onkeypress = (e) => {
    if (e.key === 'Enter') addBlacklistedKeyword();
  };

  // Buttons
  document.getElementById('resetFilters').onclick = async () => {
    const ok = await showConfirmModal({
      title: 'Reset filters',
      message: 'Do you really want to reset all filters?',
      type: 'warning',
      confirmText: 'Reset',
    });
    if (ok) {
      currentFilters = await resetFilters();
      populateFilterModal();
      toastSuccess('Filters reset');
    }
  };

  document.getElementById('saveFilters').onclick = saveCurrentFilters;

  // Escape + focus trap (keyboard focus must never leave the modal while it is open)
  document.getElementById('filterModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      hideFilterModal();
      return;
    }
    if (e.key === 'Tab') trapFocus(e);
  });
}

/**
 * Prevents Tab/Shift+Tab from moving focus outside the open modal.
 */
function trapFocus(e) {
  const modal = document.getElementById('filterModal');
  const focusable = modal.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Shows the filters modal
 */
export function showFilterModal() {
  lastFocusedBeforeModal = document.activeElement;
  populateFilterModal();
  const modal = document.getElementById('filterModal');
  modal.style.display = 'flex';
  // Focus the first interactive element (the close button) to prime the trap
  const closeBtn = document.getElementById('closeFilterModal');
  if (closeBtn) closeBtn.focus();
}

/**
 * Hides the filters modal
 */
function hideFilterModal() {
  document.getElementById('filterModal').style.display = 'none';
  // Restore focus to the element that opened the modal
  if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === 'function') {
    lastFocusedBeforeModal.focus();
  }
  lastFocusedBeforeModal = null;
}

/**
 * Fills the modal with the current filters
 */
function populateFilterModal() {
  // Checkboxes
  document.getElementById('filterNoSubject').checked = currentFilters.excludeNoSubject;
  document.getElementById('filterNotifications').checked = currentFilters.excludeNotifications;
  document.getElementById('filterPromotional').checked = currentFilters.excludePromotional;
  document.getElementById('filterAutoExcludeRepetitive').checked =
    currentFilters.autoExcludeRepetitive !== false;
  document.getElementById('filterShortConversations').checked =
    currentFilters.excludeShortConversations;
  document.getElementById('minConversationLength').value = currentFilters.minConversationLength;

  // Custom date
  document.getElementById('filterUseCustomAfterDate').checked =
    currentFilters.useCustomAfterDate || false;
  document.getElementById('filterCustomAfterDate').value = currentFilters.customAfterDate || '';
  document.getElementById('customAfterDateGroup').style.display = currentFilters.useCustomAfterDate
    ? 'block'
    : 'none';

  // Show/hide the short conversations field
  const group = document.getElementById('minConversationLengthGroup');
  group.style.display = currentFilters.excludeShortConversations ? 'block' : 'none';

  // Sender blocklist
  renderBlacklistedSenders();

  // Keyword list
  renderBlacklistedKeywords();

  // Excluded subjects list
  renderBlacklistedSubjects();
}

/**
 * Shows the list of blocked senders
 */
function renderBlacklistedSenders() {
  const list = document.getElementById('blacklistedSendersList');
  list.innerHTML = '';

  if (!currentFilters.blacklistedSenders || currentFilters.blacklistedSenders.length === 0) {
    list.innerHTML = '<p class="filter-empty">No blocked sender</p>';
    return;
  }

  currentFilters.blacklistedSenders.forEach((sender, index) => {
    const item = document.createElement('div');
    item.className = 'filter-list-item';
    const span = document.createElement('span');
    span.textContent = sender;
    const btn = document.createElement('button');
    btn.className = 'filter-remove-btn';
    btn.textContent = '×';
    btn.addEventListener('click', () => removeBlacklistedSender(index));
    item.append(span, btn);
    list.appendChild(item);
  });
}

/**
 * Shows the list of forbidden keywords
 */
function renderBlacklistedKeywords() {
  const list = document.getElementById('blacklistedKeywordsList');
  list.innerHTML = '';

  if (!currentFilters.blacklistedKeywords || currentFilters.blacklistedKeywords.length === 0) {
    list.innerHTML = '<p class="filter-empty">No blocked keyword</p>';
    return;
  }

  currentFilters.blacklistedKeywords.forEach((keyword, index) => {
    const item = document.createElement('div');
    item.className = 'filter-list-item';
    const span = document.createElement('span');
    span.textContent = keyword;
    const btn = document.createElement('button');
    btn.className = 'filter-remove-btn';
    btn.textContent = '×';
    btn.addEventListener('click', () => removeBlacklistedKeyword(index));
    item.append(span, btn);
    list.appendChild(item);
  });
}

/**
 * Shows the list of excluded subjects
 */
function renderBlacklistedSubjects() {
  const list = document.getElementById('blacklistedSubjectsList');
  if (!list) return;
  list.innerHTML = '';

  if (!currentFilters.blacklistedSubjects || currentFilters.blacklistedSubjects.length === 0) {
    list.innerHTML = '<p class="filter-empty">No excluded subject</p>';
    return;
  }

  currentFilters.blacklistedSubjects.forEach((subject, index) => {
    const item = document.createElement('div');
    item.className = 'filter-list-item';
    const span = document.createElement('span');
    span.textContent = subject;
    span.style.fontSize = '0.85rem';
    const btn = document.createElement('button');
    btn.className = 'filter-remove-btn';
    btn.textContent = '×';
    btn.title = 'Restore this subject';
    btn.addEventListener('click', () => removeBlacklistedSubject(index));
    item.append(span, btn);
    list.appendChild(item);
  });
}

/**
 * Removes a subject from the exclusion list and triggers a re-download.
 */
async function removeBlacklistedSubject(index) {
  const subject = currentFilters.blacklistedSubjects[index];
  currentFilters.blacklistedSubjects.splice(index, 1);
  renderBlacklistedSubjects();

  // Save immediately (don't wait for the "Save" button)
  await saveFilters(currentFilters);

  toastSuccess(`Subject restored: "${subject}" — re-downloading...`);

  // Trigger re-download in background
  if (onSubjectRestoredCallback && subject) {
    onSubjectRestoredCallback(subject);
  }
}

/**
 * Adds a sender to the blocklist
 */
function addBlacklistedSender() {
  const input = document.getElementById('newBlacklistedSender');
  const email = input.value.trim();

  if (!email) return;

  if (!currentFilters.blacklistedSenders) {
    currentFilters.blacklistedSenders = [];
  }

  if (!currentFilters.blacklistedSenders.includes(email)) {
    currentFilters.blacklistedSenders.push(email);
    renderBlacklistedSenders();
    input.value = '';
  } else {
    toastWarning('This sender is already in the list');
  }
}

/**
 * Removes a sender from the blocklist
 */
function removeBlacklistedSender(index) {
  currentFilters.blacklistedSenders.splice(index, 1);
  renderBlacklistedSenders();
}

/**
 * Adds a keyword to the list
 */
function addBlacklistedKeyword() {
  const input = document.getElementById('newBlacklistedKeyword');
  const keyword = input.value.trim();

  if (!keyword) return;

  if (!currentFilters.blacklistedKeywords) {
    currentFilters.blacklistedKeywords = [];
  }

  if (!currentFilters.blacklistedKeywords.includes(keyword)) {
    currentFilters.blacklistedKeywords.push(keyword);
    renderBlacklistedKeywords();
    input.value = '';
  } else {
    toastWarning('This keyword is already in the list');
  }
}

/**
 * Removes a keyword from the list
 */
function removeBlacklistedKeyword(index) {
  currentFilters.blacklistedKeywords.splice(index, 1);
  renderBlacklistedKeywords();
}

/**
 * Saves the current filters
 */
async function saveCurrentFilters() {
  // Read the values from the form
  currentFilters.excludeNoSubject = document.getElementById('filterNoSubject').checked;
  currentFilters.excludeNotifications = document.getElementById('filterNotifications').checked;
  currentFilters.excludePromotional = document.getElementById('filterPromotional').checked;
  currentFilters.autoExcludeRepetitive = document.getElementById(
    'filterAutoExcludeRepetitive'
  ).checked;
  currentFilters.excludeShortConversations = document.getElementById(
    'filterShortConversations'
  ).checked;
  currentFilters.minConversationLength = parseInt(
    document.getElementById('minConversationLength').value
  );
  currentFilters.useCustomAfterDate = document.getElementById('filterUseCustomAfterDate').checked;
  currentFilters.customAfterDate = document.getElementById('filterCustomAfterDate').value || null;

  await saveFilters(currentFilters);
  toastSuccess('Filters saved successfully!');
  hideFilterModal();
  if (onFiltersSavedCallback) onFiltersSavedCallback();
}

/**
 * Registers a callback called after each filter save.
 * Allows app.js to re-fetch IDs with the new filters.
 */
export function setOnFiltersSaved(callback) {
  onFiltersSavedCallback = callback;
}

/**
 * Registers a callback called when a subject is restored (removed from the blocklist).
 * The callback receives the name of the restored subject.
 */
export function setOnSubjectRestored(callback) {
  onSubjectRestoredCallback = callback;
}

/**
 * Updates the in-memory filters (without opening the modal).
 * Used to sync after a programmatic addition (e.g. auto-exclusion).
 */
export function updateCurrentFilters(filters) {
  if (filters) {
    currentFilters = filters;
  }
}

/**
 * Gets the current filters (with the default keywords if missing)
 */
export function getCurrentFilters() {
  if (!currentFilters) {
    return null;
  }

  // Ensure the keyword arrays are present
  const filters = { ...currentFilters };

  // Add the default keywords if they are missing
  const defaultFilters = getDefaultFilters();
  if (!filters.notificationKeywords || filters.notificationKeywords.length === 0) {
    filters.notificationKeywords = defaultFilters.notificationKeywords;
  }
  if (!filters.promotionalKeywords || filters.promotionalKeywords.length === 0) {
    filters.promotionalKeywords = defaultFilters.promotionalKeywords;
  }

  return filters;
}

/**
 * Shows the filtering statistics
 */
export function showFilterStats(stats) {
  const statsDiv = document.getElementById('filterStats');
  const content = document.getElementById('filterStatsContent');

  if (!stats || stats.total === 0) {
    statsDiv.style.display = 'none';
    return;
  }

  let html = `
    <div class="stats-grid">
      <div class="stat-item">
        <div class="stat-value">${stats.total}</div>
        <div class="stat-label">Total</div>
      </div>
      <div class="stat-item stat-success">
        <div class="stat-value">${stats.kept}</div>
        <div class="stat-label">Kept</div>
      </div>
      <div class="stat-item stat-danger">
        <div class="stat-value">${stats.excluded}</div>
        <div class="stat-label">Excluded</div>
      </div>
    </div>
  `;

  if (stats.reasons && Object.keys(stats.reasons).length > 0) {
    html += '<div class="stats-reasons"><h4>Exclusion reasons:</h4><ul>';
    for (const [reason, count] of Object.entries(stats.reasons)) {
      html += `<li>${reason}: <strong>${count}</strong></li>`;
    }
    html += '</ul></div>';
  }

  content.innerHTML = html;
  statsDiv.style.display = 'block';
}
