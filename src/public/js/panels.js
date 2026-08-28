/**
 * Module for managing side panel resizing and collapsing
 */

import { autoFit } from './treeRenderer.js';

const STORAGE_KEY = 'mailproject-panels';
const DEFAULTS = { leftWidth: 260, rightWidth: 280, leftCollapsed: false, rightCollapsed: false };
const MIN_PANEL_WIDTH = 180;
const MAX_PANEL_WIDTH = 600;
const RESIZER_WIDTH = 1;
// Must stay in sync with the 1024px breakpoint in three-panel.css (1-column
// grid). Below it, the mobile layout must be handled by the CSS media
// queries — an inline style on gridTemplateColumns would override them.
const MOBILE_BREAKPOINT = 1024;

let state = { ...DEFAULTS };

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      leftWidth: clampWidth(parsed.leftWidth ?? DEFAULTS.leftWidth),
      rightWidth: clampWidth(parsed.rightWidth ?? DEFAULTS.rightWidth),
      leftCollapsed: !!parsed.leftCollapsed,
      rightCollapsed: !!parsed.rightCollapsed,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded or storage unavailable: ignore silently
  }
}

function clampWidth(w) {
  const n = Number(w);
  if (!Number.isFinite(n)) return DEFAULTS.leftWidth;
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, n));
}

function applyLayout() {
  const layout = document.querySelector('.three-panel-layout');
  if (!layout) return;

  if (window.innerWidth <= MOBILE_BREAKPOINT) {
    // Let the CSS (media queries) fully handle the mobile grid —
    // do not write an inline gridTemplateColumns that would always override it.
    layout.style.gridTemplateColumns = '';
  } else {
    const left = state.leftCollapsed ? 0 : state.leftWidth;
    const right = state.rightCollapsed ? 0 : state.rightWidth;
    const leftResizer = state.leftCollapsed ? 0 : RESIZER_WIDTH;
    const rightResizer = state.rightCollapsed ? 0 : RESIZER_WIDTH;

    layout.style.gridTemplateColumns = `${left}px ${leftResizer}px 1fr ${rightResizer}px ${right}px`;
  }

  layout.classList.toggle('left-collapsed', state.leftCollapsed);
  layout.classList.toggle('right-collapsed', state.rightCollapsed);
}

function refitTree(delay = 240) {
  setTimeout(() => {
    if (typeof autoFit === 'function') autoFit();
  }, delay);
}

// === RESET (from the Actions menu) ===
export function resetPanelSizes() {
  state = { ...DEFAULTS };
  saveState();
  applyLayout();
  refitTree(50);
}

// === TOGGLE COLLAPSE ===
function togglePanel(side) {
  if (side === 'left') {
    state.leftCollapsed = !state.leftCollapsed;
  } else if (side === 'right') {
    state.rightCollapsed = !state.rightCollapsed;
  }
  saveState();
  applyLayout();
  refitTree();
}

// === INIT ===
export function initPanelResizers() {
  state = loadState();
  applyLayout();

  const leftPanel = document.querySelector('.left-panel');
  const rightPanel = document.querySelector('.right-panel');
  const resizerLeft = document.querySelector('.resizer-left');
  const resizerRight = document.querySelector('.resizer-right');
  const toggleLeft = document.getElementById('panelToggleLeft');
  const toggleRight = document.getElementById('panelToggleRight');

  // === Collapse buttons ===
  if (toggleLeft) toggleLeft.addEventListener('click', () => togglePanel('left'));
  if (toggleRight) toggleRight.addEventListener('click', () => togglePanel('right'));

  // === Responsiveness: re-apply the layout if the window crosses the mobile breakpoint ===
  let layoutResizeTimeout = null;
  window.addEventListener('resize', () => {
    if (layoutResizeTimeout) clearTimeout(layoutResizeTimeout);
    layoutResizeTimeout = setTimeout(applyLayout, 150);
  });

  // === Drag resize (Pointer Events: covers mouse, touch and stylus) ===
  let isResizing = false;
  let currentResizer = null;
  let startX = 0;
  let startLeftWidth = 0;
  let startRightWidth = 0;
  let resizeTimeout = null;
  const layoutEl = document.querySelector('.three-panel-layout');

  function startResize(e, resizer) {
    // Do not start a resize if the panel is collapsed
    if (resizer === resizerLeft && state.leftCollapsed) return;
    if (resizer === resizerRight && state.rightCollapsed) return;

    isResizing = true;
    currentResizer = resizer;
    startX = e.clientX;

    if (resizer === resizerLeft) startLeftWidth = leftPanel.offsetWidth;
    else if (resizer === resizerRight) startRightWidth = rightPanel.offsetWidth;

    resizer.classList.add('dragging');
    if (layoutEl) layoutEl.classList.add('resizing-active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    if (resizer.setPointerCapture && e.pointerId !== undefined) {
      try {
        resizer.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    e.preventDefault();
  }

  function resize(e) {
    if (!isResizing) return;
    const deltaX = e.clientX - startX;

    if (currentResizer === resizerLeft) {
      const newWidth = clampWidth(startLeftWidth + deltaX);
      state.leftWidth = newWidth;
      applyLayout();
    } else if (currentResizer === resizerRight) {
      const newWidth = clampWidth(startRightWidth - deltaX);
      state.rightWidth = newWidth;
      applyLayout();
    }

    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (typeof autoFit === 'function') autoFit();
    }, 150);

    e.preventDefault();
  }

  function stopResize() {
    if (!isResizing) return;
    isResizing = false;
    if (currentResizer) currentResizer.classList.remove('dragging');
    if (layoutEl) layoutEl.classList.remove('resizing-active');
    currentResizer = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (resizeTimeout) {
      clearTimeout(resizeTimeout);
      resizeTimeout = null;
    }
    saveState();
    refitTree(50);
  }

  if (resizerLeft) {
    resizerLeft.addEventListener('pointerdown', (e) => startResize(e, resizerLeft));
  }
  if (resizerRight) {
    resizerRight.addEventListener('pointerdown', (e) => startResize(e, resizerRight));
  }
  document.addEventListener('pointermove', resize);
  document.addEventListener('pointerup', stopResize);
  document.addEventListener('pointercancel', stopResize);
}
