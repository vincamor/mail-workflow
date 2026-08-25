/**
 * Demo mode — a read-only tour of the app on a bundled, entirely fictional dataset.
 *
 * Activated with `?demo=1`. No OAuth, no account, no folder picking, and — this is
 * the contract — NOTHING is ever written: no file, no IndexedDB entry, no folder
 * handle. (The theme in localStorage is a pre-existing exception and stays.)
 *
 * How it works: every read in this app goes through `fileHandle.getFile()` and then
 * `file.stream()`, and every caller gets that handle from `getEmailFileHandle()` in
 * folders.js. A `Blob` fetched over HTTP exposes the same read interface as a `File`
 * from the File System Access API, so demo mode duck-types a fake handle and nothing
 * downstream has to change. That also means the demo needs no `showDirectoryPicker`,
 * which is why it works on Firefox, Safari and mobile.
 */

export const DEMO_PROVIDER = 'gmail';
export const DEMO_USER_ID = 'demo@example.com';

const DEMO_BASE = '/demo/';
const README_SETUP_URL = 'https://github.com/vincamor/mail-workflow#quick-start';

// One Blob per dataset file, kept for the lifetime of the page.
const cache = new Map();

/** True when the page was opened with `?demo=1`. */
export function isDemoMode() {
  return new URLSearchParams(location.search).get('demo') === '1';
}

/**
 * Adds async iteration to a ReadableStream when the browser lacks it.
 * Every reader in this app consumes the stream with `for await (const chunk …)`.
 * Chromium implements `ReadableStream[Symbol.asyncIterator]`; Firefox and Safari
 * still do not, and the demo is supposed to work there — so we patch the
 * instance (never the prototype) with a getReader()-based iterator.
 * @param {ReadableStream} stream
 */
function withAsyncIteration(stream) {
  if (typeof stream[Symbol.asyncIterator] === 'function') return stream;
  stream[Symbol.asyncIterator] = function () {
    const reader = this.getReader();
    return {
      next: () => reader.read(),
      return: async (value) => {
        reader.releaseLock();
        return { done: true, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
  return stream;
}

/**
 * File-like view over a Blob. Readers in this app only ever touch `.size` and
 * `.stream()`; the rest is provided so the object behaves like a real File.
 * @param {Blob} blob
 * @param {string} name
 */
function fileLike(blob, name) {
  return {
    name,
    size: blob.size,
    type: blob.type,
    lastModified: 0,
    stream: () => withAsyncIteration(blob.stream()),
    text: () => blob.text(),
    arrayBuffer: () => blob.arrayBuffer(),
    slice: (...args) => blob.slice(...args),
  };
}

/**
 * Builds an object that duck-types FileSystemFileHandle well enough for every
 * reader in this app: it only ever needs `getFile()`, then `.size` and `.stream()`.
 * Exported so tests can exercise the real thing without a network round-trip.
 * @param {Blob} blob
 * @param {string} name
 * @returns {{getFile: function(): Promise<Object>}}
 */
export function makeReadOnlyFileHandle(blob, name) {
  return { getFile: async () => fileLike(blob, name) };
}

async function fileHandleFromUrl(url, name) {
  if (!cache.has(url)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Demo dataset not found: ${url}`);
    cache.set(url, await res.blob());
  }
  return makeReadOnlyFileHandle(cache.get(url), name);
}

/**
 * Same return shape as `getEmailFileHandle()` in folders.js, so callers cannot
 * tell the difference: { fileHandle, fileName, exists }.
 * @param {string} [provider]
 */
export async function getDemoEmailFileHandle(provider = DEMO_PROVIDER) {
  const fileName = `${provider}_emails.jsonl`;
  try {
    const fileHandle = await fileHandleFromUrl(DEMO_BASE + fileName, fileName);
    return { fileHandle, fileName, exists: true };
  } catch (e) {
    console.error('[demo] ', e.message);
    return { fileHandle: null, fileName, exists: false };
  }
}

/**
 * Fake handle for the bodyHtml companion file (`*_emails_html.jsonl`).
 * @param {string} [provider]
 * @returns {Promise<{getFile: function(): Promise<Object>}|null>}
 */
export async function getDemoHtmlFileHandle(provider = DEMO_PROVIDER) {
  const fileName = `${provider}_emails_html.jsonl`;
  try {
    return await fileHandleFromUrl(DEMO_BASE + fileName, fileName);
  } catch (e) {
    console.warn('[demo] ', e.message);
    return null;
  }
}

/** Reveals the persistent demo banner declared in index.html. */
export function showDemoBanner() {
  document.body.classList.add('demo-mode');
  const banner = document.getElementById('demoBanner');
  if (banner) banner.style.display = 'flex';
}

/**
 * Hides every write action rather than disabling it — a dead button is worse
 * than an absent one. Also replaces the AI entry point with a short note:
 * `/api/ai/*` requires an authenticated session, so in demo mode it would 401.
 */
export function applyDemoReadOnlyUI() {
  // Folder picking, download, incremental sync and the download filters all live
  // inside #folderSection; hiding it removes every write path in one go.
  hide('folderSection');
  hide('downloadEmailsBtn');
  hide('updateEmailsBtn');
  hide('downloadProgressBar');
  // "N mails available for download" makes no sense without an account.
  hide('emailCountInfo');
  // No session to destroy, and logging out would drop the ?demo=1 parameter.
  hide('disconnectBtn');

  replaceAiPanelWithNote();
}

function hide(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function replaceAiPanelWithNote() {
  const drawer = document.getElementById('aiDrawer');
  if (!drawer) return;

  const config = document.getElementById('aiConfigSubdrawer');
  if (config) config.style.display = 'none';
  const launch = drawer.querySelector('.ai-filter-launch');
  if (launch) launch.style.display = 'none';
  const divider = drawer.querySelector('.ai-filter-section-divider');
  if (divider) divider.style.display = 'none';

  if (document.getElementById('demoAiNote')) return;
  const note = document.createElement('p');
  note.id = 'demoAiNote';
  note.className = 'ai-filter-hint';
  note.textContent =
    'The AI assistant is off in demo mode: it proxies through your own account and provider key. Run the app locally to try it.';

  const link = document.createElement('a');
  link.href = README_SETUP_URL;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Setup instructions';

  drawer.appendChild(note);
  drawer.appendChild(link);
}

/** URL of the README section explaining how to run the real thing. */
export function getDemoSetupUrl() {
  return README_SETUP_URL;
}
