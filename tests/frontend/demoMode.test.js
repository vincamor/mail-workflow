// Demo mode — the fake file handle, and above all the regression guard that keeps
// the SHIPPED fixture readable by the REAL analysis path. If the app's data shape
// or threading logic drifts, this suite fails instead of the demo rotting silently.
//
// Runs in the default `node` environment on purpose: Node's `File` implements
// `.size`, `.stream()` and `.text()` exactly like the browser's, whereas jsdom's
// Blob does not — and `.stream()` is precisely what every reader in this app uses.
const fs = require('fs');
const path = require('path');
const { describe, test, expect, beforeAll, afterAll } = require('@jest/globals');
const { loadRealAnalyzer } = require('./helpers/loadRealAnalyzer');

const DEMO_DIR = path.join(__dirname, '..', '..', 'src', 'public', 'demo');
const MAIN_JSONL = path.join(DEMO_DIR, 'gmail_emails.jsonl');
const HTML_JSONL = path.join(DEMO_DIR, 'gmail_emails_html.jsonl');

// The analyzer is loaded from the production file by the shared helper.

// makeReadOnlyFileHandle is the REAL factory from demo.js: only the fetch is
// replaced by a disk read of the fixture.
let makeReadOnlyFileHandle;

beforeAll(async () => {
  const mod = await import('../../src/public/js/demo.js');
  makeReadOnlyFileHandle = mod.makeReadOnlyFileHandle;
});

function fakeHandleFromDisk(filePath) {
  const blob = new Blob([fs.readFileSync(filePath)]);
  return makeReadOnlyFileHandle(blob, path.basename(filePath));
}

describe('demo mode — fake file handle', () => {
  test('getFile() returns an object readable like a real File (size + stream)', async () => {
    const handle = fakeHandleFromDisk(MAIN_JSONL);
    const file = await handle.getFile();
    expect(file.name).toBe('gmail_emails.jsonl');

    expect(typeof file.size).toBe('number');
    expect(file.size).toBeGreaterThan(0);
    expect(typeof file.stream).toBe('function');
    // All the app's readers consume the stream with `for await`: Firefox
    // and Safari do not implement ReadableStream[Symbol.asyncIterator], demo.js
    // must therefore guarantee it.
    expect(typeof file.stream()[Symbol.asyncIterator]).toBe('function');

    // Streaming read identical to that of analyzeEmailFile / loadEmailsFromHandle
    const decoder = new TextDecoder();
    let text = '';
    for await (const chunk of file.stream()) {
      text += decoder.decode(chunk, { stream: true });
    }
    expect(Buffer.byteLength(text, 'utf8')).toBe(file.size);
    expect(() => JSON.parse(text.split('\n')[0])).not.toThrow();
  });

  test('the companion HTML is read the same way', async () => {
    const handle = fakeHandleFromDisk(HTML_JSONL);
    const file = await handle.getFile();
    expect(file.size).toBeGreaterThan(0);
    const first = JSON.parse((await file.text()).split('\n')[0]);
    expect(typeof first.id).toBe('string');
    expect(typeof first.bodyHtml).toBe('string');
  });
});

describe('demo mode — isDemoMode()', () => {
  let isDemoMode;
  let previousLocation;

  beforeAll(async () => {
    previousLocation = globalThis.location;
    // demo.js ne lit que location.search
    globalThis.location = { search: '' };
    const mod = await import('../../src/public/js/demo.js');
    isDemoMode = mod.isDemoMode;
  });

  afterAll(() => {
    globalThis.location = previousLocation;
  });

  test('false on a normal URL', () => {
    globalThis.location.search = '';
    expect(isDemoMode()).toBe(false);
    globalThis.location.search = '?provider=gmail&email=me@example.com';
    expect(isDemoMode()).toBe(false);
    globalThis.location.search = '?demo=0';
    expect(isDemoMode()).toBe(false);
  });

  test('true with ?demo=1', () => {
    globalThis.location.search = '?demo=1';
    expect(isDemoMode()).toBe(true);
    globalThis.location.search = '?provider=gmail&demo=1&email=x@example.com';
    expect(isDemoMode()).toBe(true);
  });

  test('the demo identity is indeed the fixture one', async () => {
    const mod = await import('../../src/public/js/demo.js');
    expect(mod.DEMO_PROVIDER).toBe('gmail');
    expect(mod.DEMO_USER_ID).toBe('demo@example.com');
    // The filename built by demo.js must exist in src/public/demo/
    expect(fs.existsSync(path.join(DEMO_DIR, `${mod.DEMO_PROVIDER}_emails.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(DEMO_DIR, `${mod.DEMO_PROVIDER}_emails_html.jsonl`))).toBe(true);
  });
});

/**
 * THE test that matters: the embedded fixture traverses the REAL analysis chain and
 * produces a valid and non-trivial {nodes, links} graph.
 */
describe('demo mode — the fixture traverses the real analysis chain', () => {
  let analyzer;
  let rawEmails;
  let cleanEmails;

  beforeAll(async () => {
    analyzer = await loadRealAnalyzer();
    rawEmails = fs
      .readFileSync(MAIN_JSONL, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    cleanEmails = rawEmails.map(analyzer.cleanEmail);
  });

  test('the dataset loads via loadEmailsFromHandle (fake handle)', async () => {
    const emails = await analyzer.loadEmailsFromHandle(fakeHandleFromDisk(MAIN_JSONL), 500);
    expect(emails.length).toBe(rawEmails.length);
    expect(emails.length).toBeGreaterThanOrEqual(50);
    // The threading fields carry the entire tree topology.
    for (const e of emails) {
      expect(typeof e.id).toBe('string');
      expect(e.messageId.length).toBeGreaterThan(0);
      expect(typeof e.internalDate).toBe('string');
      expect(Number.isNaN(Number(e.internalDate))).toBe(false);
    }
  });

  test('records have the shape written by the real app', () => {
    // Fields produced by formatGmailEmail(), minus those that emails.js removes
    // before writing (bodyHtml, sizeEstimate, historyId, labelIds).
    const expected = [
      'id',
      'threadId',
      'snippet',
      'subject',
      'from',
      'to',
      'cc',
      'date',
      'messageId',
      'inReplyTo',
      'references',
      'internalDate',
      'hasAttachments',
      'bodyText',
    ];
    for (const e of rawEmails) {
      expect(Object.keys(e).sort()).toEqual([...expected].sort());
      expect(e.bodyHtml).toBeUndefined();
    }
  });

  test('threading fields are consistent with each other', () => {
    const byMessageId = new Map(rawEmails.map((e) => [e.messageId, e]));
    expect(byMessageId.size).toBe(rawEmails.length); // unique messageIds
    expect(new Set(rawEmails.map((e) => e.id)).size).toBe(rawEmails.length);
    for (const e of rawEmails) {
      if (e.inReplyTo) expect(byMessageId.has(e.inReplyTo)).toBe(true);
      for (const ref of e.references.split(/\s+/).filter(Boolean)) {
        expect(byMessageId.has(ref)).toBe(true);
      }
    }
  });

  test('getSubjectsWithMinEmails returns multiple exploitable subjects', () => {
    const subjects = analyzer.getSubjectsWithMinEmails(cleanEmails, 3, 'demo@example.com');
    expect(subjects.length).toBeGreaterThanOrEqual(8);
    // Newsletter / transactional: targets of "Clean-up"
    expect(subjects.some((s) => s.isNewsletter)).toBe(true);
    // Short thread with 2 participants, for contrast
    expect(subjects.some((s) => s.participants.length === 2)).toBe(true);
    // Flagship thread: 5 participants
    expect(subjects.some((s) => s.participants.length >= 5)).toBe(true);
    // The demo user actually participates in the conversation
    expect(subjects.some((s) => s.userReplied)).toBe(true);
  });

  test('at least two emails carry hasAttachments', () => {
    expect(rawEmails.filter((e) => e.hasAttachments === true).length).toBeGreaterThanOrEqual(2);
  });

  test('at least one email has rich bodyHtml with quoted text', () => {
    const entries = fs
      .readFileSync(HTML_JSONL, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    expect(entries.length).toBeGreaterThan(0);
    // The quoted text toggle in email-detail.js looks for gmail_quote / <blockquote>
    expect(entries.some((e) => /gmail_quote|<blockquote/i.test(e.bodyHtml))).toBe(true);
    expect(entries.some((e) => /<table/i.test(e.bodyHtml))).toBe(true);
    // Each bodyHtml must correspond to an email in the main JSONL
    const ids = new Set(rawEmails.map((e) => e.id));
    for (const e of entries) expect(ids.has(e.id)).toBe(true);
  });

  test('each subject produces a valid {nodes, links} graph', () => {
    const subjects = analyzer.getSubjectsWithMinEmails(cleanEmails, 3, 'demo@example.com');
    for (const s of subjects) {
      const tree = analyzer.createTemporalGroupTree(cleanEmails, s.subject);
      expect(Array.isArray(tree.nodes)).toBe(true);
      expect(Array.isArray(tree.links)).toBe(true);
      expect(tree.nodes.length).toBe(s.emailCount);
      expect(tree.nodes.length).toBeGreaterThan(1);
      // A tree: one incoming link per node, except the root
      expect(tree.links.length).toBe(tree.nodes.length - 1);
      const incoming = new Set();
      for (const link of tree.links) {
        expect(tree.nodes[link.source]).toBeDefined();
        expect(tree.nodes[link.target]).toBeDefined();
        expect(link.source).not.toBe(link.target);
        expect(incoming.has(link.target)).toBe(false);
        incoming.add(link.target);
      }
      expect(incoming.has(0)).toBe(false);
      expect(tree.nodes[0].isRoot).toBe(true);
    }
  });

  test('the flagship thread is deep AND branched (the README capture)', () => {
    const flagship = cleanEmails
      .map((e) => e.subject)
      .find((s) => s.startsWith('Q3 platform migration'));
    expect(flagship).toBeTruthy();

    const tree = analyzer.createTemporalGroupTree(cleanEmails, flagship);
    expect(tree.nodes.length).toBe(15);
    expect(tree.links.length).toBe(14);

    // 5 distinct participants
    expect(new Set(tree.nodes.map((n) => n.from)).size).toBe(5);

    // At least two divergence points -> true branches, not a single line
    const childCount = new Map();
    for (const link of tree.links) {
      childCount.set(link.source, (childCount.get(link.source) || 0) + 1);
    }
    expect([...childCount.values()].filter((c) => c > 1).length).toBeGreaterThanOrEqual(2);

    // And true depth (the trunk = longest path from the root)
    const children = new Map();
    for (const link of tree.links) {
      if (!children.has(link.source)) children.set(link.source, []);
      children.get(link.source).push(link.target);
    }
    const depthOf = (i) => {
      const kids = children.get(i) || [];
      return kids.length === 0 ? 1 : 1 + Math.max(...kids.map(depthOf));
    };
    expect(depthOf(0)).toBeGreaterThanOrEqual(6);
  });
});
