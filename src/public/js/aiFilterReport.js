/**
 * Module for rendering the AI clean-up report
 * Displays the results in the central panel with 3 coloured sections
 */

import { getCurrentFilters, updateCurrentFilters } from './filterUI.js';
import { cleanupExcludedSubjectsFromJSONL } from './emails.js';
import { refreshSubjectsDisplay } from './analysis.js';
import { getFilterStats } from './aiFilter.js';

// Current report state (mutable for moves between sections)
let currentResults = null;

/**
 * Shows the progress bar during AI analysis
 * @param {{ percent: number, message?: string }} progress
 */
export function renderProgress(progress) {
  const container = getOrCreateContainer();
  container.style.display = 'block';

  const pct = Math.round(progress.percent || 0);
  const msg = progress.message || 'Analysis in progress...';

  container.innerHTML = `
    <div style="max-width: 480px; margin: 120px auto; text-align: center; font-family: var(--font-sans, Inter, sans-serif);">
      <h2 style="color: var(--text-primary, #EDE7F3); margin-bottom: 24px;">AI subject analysis</h2>
      <div style="background: var(--bg-tertiary, #2A1740); border-radius: 8px; height: 12px; overflow: hidden; margin-bottom: 12px;">
        <div style="height: 100%; width: ${pct}%; background: var(--aurora-gradient, linear-gradient(135deg, #F2A07B, #B44AE6)); border-radius: 8px; transition: width 300ms ease-out;"></div>
      </div>
      <p style="color: var(--text-secondary, #B8A9C8); font-size: 14px;">${msg} (${pct}%)</p>
    </div>
  `;

  hideTreeAndDefault();
}

/**
 * Displays the AI clean-up report
 * @param {{ exclure: string[], garder: string[], incertain: string[] }} results
 */
export function renderFilterReport(results) {
  currentResults = {
    exclure: [...results.exclure],
    garder: [...results.garder],
    incertain: [...results.incertain],
  };

  const container = getOrCreateContainer();
  container.style.display = 'block';
  container.innerHTML = buildReportHTML(currentResults);

  hideTreeAndDefault();
  attachEventListeners();
}

/**
 * Closes the report and restores the previous view
 */
export function closeReport() {
  const container = document.getElementById('aiFilterReport');
  if (container) container.style.display = 'none';

  currentResults = null;

  const treeEl = document.getElementById('treeVisualization');
  const defaultView = document.getElementById('defaultView');

  // If the tree has SVG content, show it; otherwise show the defaultView
  if (treeEl && treeEl.querySelector('svg')) {
    treeEl.style.display = 'block';
    if (defaultView) defaultView.style.display = 'none';
  } else {
    if (treeEl) treeEl.style.display = 'none';
    if (defaultView) defaultView.style.display = 'flex';
  }
}

// ─── Internals ───────────────────────────────────────────────────────────────

function getOrCreateContainer() {
  let container = document.getElementById('aiFilterReport');
  if (!container) {
    container = document.createElement('div');
    container.id = 'aiFilterReport';
    container.style.cssText =
      'display:none; overflow-y:auto; height:100%; padding:16px; box-sizing:border-box;';
    const treeEl = document.getElementById('treeVisualization');
    if (treeEl && treeEl.parentNode) {
      treeEl.parentNode.insertBefore(container, treeEl);
    } else {
      document.body.appendChild(container);
    }
  }
  return container;
}

function hideTreeAndDefault() {
  const treeEl = document.getElementById('treeVisualization');
  const defaultView = document.getElementById('defaultView');
  if (treeEl) treeEl.style.display = 'none';
  if (defaultView) defaultView.style.display = 'none';
}

function escapeAttr(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildReportHTML(results) {
  const totalExclude = results.exclure.length;
  const totalKeep = results.garder.length;
  const totalUncertain = results.incertain.length;

  return `
    <div style="max-width: 700px; margin: 0 auto; font-family: var(--font-sans, Inter, sans-serif);">
      <h2 style="color: var(--text-primary, #EDE7F3); margin-bottom: 8px;">AI clean-up report</h2>
      <p style="color: var(--text-secondary, #B8A9C8); font-size: 13px; margin-bottom: 16px;">
        Move subjects between sections if needed, then click Apply.
        Subjects in red will be excluded. Subjects in yellow will be kept.
      </p>
      <div style="display: flex; gap: 16px; margin-bottom: 20px; padding: 10px 14px; background: var(--bg-tertiary, #2A1740); border-radius: 6px; font-size: 12px; color: var(--text-tertiary, #7A6B8A);">
        <span>${getFilterStats().totalRequests} AI requests</span>
        <span>~${Math.round(getFilterStats().totalTokensEstimated / 1000)}k tokens estimated</span>
        <span>${totalExclude + totalKeep + totalUncertain} subjects analysed</span>
      </div>

      ${buildSection(
        'exclure',
        '&#128308; Exclude',
        totalExclude,
        results.exclure,
        'rgba(220,38,38,0.12)',
        'rgba(220,38,38,0.3)',
        [
          { target: 'garder', label: '&rarr;&#128994;' },
          { target: 'incertain', label: '&rarr;&#128992;' },
        ]
      )}

      ${buildSection(
        'garder',
        '&#128994; Keep',
        totalKeep,
        results.garder,
        'rgba(34,197,94,0.12)',
        'rgba(34,197,94,0.3)',
        [
          { target: 'exclure', label: '&rarr;&#128308;' },
          { target: 'incertain', label: '&rarr;&#128992;' },
        ]
      )}

      ${buildSection(
        'incertain',
        '&#128992; Unsure',
        totalUncertain,
        results.incertain,
        'rgba(234,179,8,0.12)',
        'rgba(234,179,8,0.3)',
        [
          { target: 'exclure', label: '&rarr;&#128308;' },
          { target: 'garder', label: '&rarr;&#128994;' },
        ]
      )}

      <div style="display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px; padding-bottom: 32px;">
        <button id="aiFilterCancel" style="padding: 8px 20px; border-radius: 6px; border: 1px solid var(--border-medium, rgba(255,255,255,0.25)); background: transparent; color: var(--text-primary, #EDE7F3); cursor: pointer; font-size: 14px;">
          Cancel
        </button>
        <button id="aiFilterApply" style="padding: 8px 20px; border-radius: 6px; border: none; background: var(--aurora-gradient, linear-gradient(135deg, #F2A07B, #B44AE6)); color: #fff; cursor: pointer; font-size: 14px; font-weight: 600;">
          Apply (${totalExclude} exclusion${totalExclude !== 1 ? 's' : ''})
        </button>
      </div>
    </div>
  `;
}

// The three section keys — exclure / garder / incertain — are the JSON keys the
// AI prompt asks the model to emit (see aiFilter.js). They are an internal
// protocol, deliberately kept in French so both sides stay in sync; renaming
// them would break the prompt, this report, and users' saved filters at once.
//
// This map is the ONE place they are turned into user-facing text. Without it
// the move-button tooltip read "Move to exclure", leaking the internal key into
// the interface.
const SECTION_LABELS = {
  exclure: 'Exclude',
  garder: 'Keep',
  incertain: 'Unsure',
};

function buildSection(key, title, count, subjects, bgColor, borderColor, moveButtons) {
  const isOpen = subjects.length > 0;
  return `
    <div style="margin-bottom: 16px; border: 1px solid ${borderColor}; border-radius: 8px; background: ${bgColor}; overflow: hidden;">
      <div class="ai-section-header" data-section="${key}" style="display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; cursor: pointer; user-select: none;">
        <span style="font-size: 15px; font-weight: 600; color: var(--text-primary, #EDE7F3);">
          ${title} <span style="font-weight: 400; opacity: 0.7;">(${count})</span>
        </span>
        <span class="ai-chevron" style="transition: transform 200ms ease; transform: rotate(${isOpen ? '90' : '0'}deg); color: var(--text-secondary, #B8A9C8);">&#9654;</span>
      </div>
      <div class="ai-section-body" data-section="${key}" style="display: ${isOpen ? 'block' : 'none'}; padding: 0 8px 8px;">
        ${
          subjects.length === 0
            ? `<p style="color: var(--text-muted, #7A6B8A); font-size: 13px; padding: 8px; margin: 0;">No subjects</p>`
            : subjects
                .map(
                  (subject) => `
            <div style="display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 4px; margin-bottom: 2px;" class="ai-subject-item">
              <span style="flex: 1; font-size: 13px; color: var(--text-primary, #EDE7F3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeAttr(subject)}">${escapeHtml(subject)}</span>
              ${moveButtons
                .map(
                  (btn) => `
                <button class="ai-move-btn" data-from="${key}" data-to="${btn.target}" data-subject="${escapeAttr(subject)}"
                  style="background: none; border: 1px solid var(--border-light, rgba(255,255,255,0.15)); border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 12px; color: var(--text-secondary, #B8A9C8); white-space: nowrap;"
                  title="Move to ${SECTION_LABELS[btn.target] || btn.target}">${btn.label}</button>
              `
                )
                .join('')}
            </div>
          `
                )
                .join('')
        }
      </div>
    </div>
  `;
}

function attachEventListeners() {
  const container = document.getElementById('aiFilterReport');
  if (!container) return;

  // Accordion toggles
  container.querySelectorAll('.ai-section-header').forEach((header) => {
    header.addEventListener('click', () => {
      const section = header.dataset.section;
      const body = container.querySelector(`.ai-section-body[data-section="${section}"]`);
      const chevron = header.querySelector('.ai-chevron');
      if (!body) return;
      const isVisible = body.style.display !== 'none';
      body.style.display = isVisible ? 'none' : 'block';
      if (chevron) chevron.style.transform = isVisible ? 'rotate(0deg)' : 'rotate(90deg)';
    });
  });

  // Move buttons
  container.querySelectorAll('.ai-move-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const from = btn.dataset.from;
      const to = btn.dataset.to;
      const subject = btn.dataset.subject;
      if (!currentResults || !currentResults[from] || !currentResults[to]) return;

      const idx = currentResults[from].indexOf(subject);
      if (idx === -1) return;
      currentResults[from].splice(idx, 1);
      currentResults[to].push(subject);

      // Re-render full report
      container.innerHTML = buildReportHTML(currentResults);
      attachEventListeners();
    });
  });

  // Cancel
  const cancelBtn = container.querySelector('#aiFilterCancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => closeReport());
  }

  // Apply
  const applyBtn = container.querySelector('#aiFilterApply');
  if (applyBtn) {
    applyBtn.addEventListener('click', () => applyExclusions());
  }
}

async function applyExclusions() {
  if (!currentResults) return;

  const toExclude = currentResults.exclure;
  if (toExclude.length === 0) {
    closeReport();
    return;
  }

  const { toastSuccess, toastWarning } = await import('./toast.js');

  try {
    const filters = getCurrentFilters();
    if (!filters) {
      console.error('🧹 [Apply] getCurrentFilters() returned null — filters not initialised');
      toastWarning('Cannot apply: filters not loaded');
      return;
    }

    if (!filters.blacklistedSubjects) filters.blacklistedSubjects = [];

    // Add the subjects that are not already excluded
    const before = filters.blacklistedSubjects.length;
    for (const subject of toExclude) {
      if (!filters.blacklistedSubjects.includes(subject)) {
        filters.blacklistedSubjects.push(subject);
      }
    }
    const added = filters.blacklistedSubjects.length - before;
    console.log(
      `🧹 [Apply] ${added}/${toExclude.length} subjects added to blacklistedSubjects (total: ${filters.blacklistedSubjects.length})`
    );

    // Save the filters (dynamic import to avoid circular imports)
    const { saveFilters } = await import('./emailFilters.js');
    await saveFilters(filters);
    updateCurrentFilters(filters);
    refreshSubjectsDisplay();

    // JSONL cleanup in a SINGLE pass for all subjects (batch version)
    const params = new URLSearchParams(window.location.search);
    const provider = params.get('provider') || 'gmail';
    const email = params.get('email');

    if (email) {
      try {
        const result = await cleanupExcludedSubjectsFromJSONL(provider, email, toExclude);
        console.log(
          `🧹 [Apply] JSONL cleaned in one pass: ${result.removed} emails removed (${toExclude.length} subjects)`
        );
      } catch (err) {
        console.warn('🧹 [Apply] JSONL cleanup error:', err);
      }
    } else {
      console.warn('🧹 [Apply] URL param "email" missing, JSONL cleanup skipped');
    }

    closeReport();
    toastSuccess(`${toExclude.length} subject${toExclude.length > 1 ? 's' : ''} excluded`);
  } catch (err) {
    console.error('🧹 [Apply] Unexpected error:', err);
    toastWarning('Error while applying: ' + (err.message || err));
  }
}
