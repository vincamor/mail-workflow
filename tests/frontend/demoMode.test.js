// Demo mode — the fake file handle, and above all the regression guard that keeps
// the SHIPPED fixture readable by the REAL analysis path. If the app's data shape
// or threading logic drifts, this suite fails instead of the demo rotting silently.
//
// Runs in the default `node` environment on purpose: Node's `File` implements
// `.size`, `.stream()` and `.text()` exactly like the browser's, whereas jsdom's
// Blob does not — and `.stream()` is precisely what every reader in this app uses.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { describe, test, expect, beforeAll, afterAll } = require('@jest/globals');

const DEMO_DIR = path.join(__dirname, '..', '..', 'src', 'public', 'demo');
const MAIN_JSONL = path.join(DEMO_DIR, 'gmail_emails.jsonl');
const HTML_JSONL = path.join(DEMO_DIR, 'gmail_emails_html.jsonl');
const ANALYZER = path.join(__dirname, '..', '..', 'src', 'services', 'emailAnalyzer_browser.js');

/**
 * Charge le VRAI emailAnalyzer_browser.js. Le fichier est un module ES servi tel
 * quel au navigateur, mais il vit hors de src/public/js/ (qui porte le
 * package.json "type":"module") : Node le verrait donc comme du CommonJS et
 * refuserait son `export default`. On l'evalue comme module ES dans un contexte
 * vm — c'est bien le fichier de production qui est charge, pas une copie.
 */
async function loadRealAnalyzer() {
  const source = fs.readFileSync(ANALYZER, 'utf8');
  const context = vm.createContext({
    console,
    TextDecoder,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    escape,
    unescape,
  });
  const mod = new vm.SourceTextModule(source, { context, identifier: ANALYZER });
  await mod.link(() => {
    throw new Error('emailAnalyzer_browser.js ne doit avoir aucun import');
  });
  await mod.evaluate();
  return mod.namespace.default;
}

// makeReadOnlyFileHandle est la VRAIE fabrique de demo.js : seul le fetch est
// remplace par une lecture disque du fixture.
let makeReadOnlyFileHandle;

beforeAll(async () => {
  const mod = await import('../../src/public/js/demo.js');
  makeReadOnlyFileHandle = mod.makeReadOnlyFileHandle;
});

function fakeHandleFromDisk(filePath) {
  const blob = new Blob([fs.readFileSync(filePath)]);
  return makeReadOnlyFileHandle(blob, path.basename(filePath));
}

describe('demo mode — faux handle de fichier', () => {
  test('getFile() rend un objet lisible comme un vrai File (size + stream)', async () => {
    const handle = fakeHandleFromDisk(MAIN_JSONL);
    const file = await handle.getFile();
    expect(file.name).toBe('gmail_emails.jsonl');

    expect(typeof file.size).toBe('number');
    expect(file.size).toBeGreaterThan(0);
    expect(typeof file.stream).toBe('function');
    // Tous les lecteurs de l'app consomment le stream avec `for await` : Firefox
    // et Safari n'implementent pas ReadableStream[Symbol.asyncIterator], demo.js
    // doit donc le garantir.
    expect(typeof file.stream()[Symbol.asyncIterator]).toBe('function');

    // Lecture streaming identique a celle de analyzeEmailFile / loadEmailsFromHandle
    const decoder = new TextDecoder();
    let text = '';
    for await (const chunk of file.stream()) {
      text += decoder.decode(chunk, { stream: true });
    }
    expect(Buffer.byteLength(text, 'utf8')).toBe(file.size);
    expect(() => JSON.parse(text.split('\n')[0])).not.toThrow();
  });

  test('le companion HTML se lit de la meme facon', async () => {
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

  test('false sur une URL normale', () => {
    globalThis.location.search = '';
    expect(isDemoMode()).toBe(false);
    globalThis.location.search = '?provider=gmail&email=me@example.com';
    expect(isDemoMode()).toBe(false);
    globalThis.location.search = '?demo=0';
    expect(isDemoMode()).toBe(false);
  });

  test('true avec ?demo=1', () => {
    globalThis.location.search = '?demo=1';
    expect(isDemoMode()).toBe(true);
    globalThis.location.search = '?provider=gmail&demo=1&email=x@example.com';
    expect(isDemoMode()).toBe(true);
  });

  test("l'identite demo est bien celle du fixture", async () => {
    const mod = await import('../../src/public/js/demo.js');
    expect(mod.DEMO_PROVIDER).toBe('gmail');
    expect(mod.DEMO_USER_ID).toBe('demo@example.com');
    // Le nom de fichier construit par demo.js doit exister dans src/public/demo/
    expect(fs.existsSync(path.join(DEMO_DIR, `${mod.DEMO_PROVIDER}_emails.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(DEMO_DIR, `${mod.DEMO_PROVIDER}_emails_html.jsonl`))).toBe(true);
  });
});

/**
 * LE test qui compte : le fixture embarque traverse la VRAIE chaine d'analyse et
 * produit un graphe {nodes, links} valide et non trivial.
 */
describe("demo mode — le fixture traverse la vraie chaine d'analyse", () => {
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

  test('le dataset se charge via loadEmailsFromHandle (faux handle)', async () => {
    const emails = await analyzer.loadEmailsFromHandle(fakeHandleFromDisk(MAIN_JSONL), 500);
    expect(emails.length).toBe(rawEmails.length);
    expect(emails.length).toBeGreaterThanOrEqual(50);
    // Les champs de threading portent toute la topologie de l'arbre.
    for (const e of emails) {
      expect(typeof e.id).toBe('string');
      expect(e.messageId.length).toBeGreaterThan(0);
      expect(typeof e.internalDate).toBe('string');
      expect(Number.isNaN(Number(e.internalDate))).toBe(false);
    }
  });

  test("les enregistrements ont la forme ecrite par l'app reelle", () => {
    // Champs produits par formatGmailEmail(), moins ceux que emails.js retire
    // avant ecriture (bodyHtml, sizeEstimate, historyId, labelIds).
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

  test('les champs de threading sont coherents entre eux', () => {
    const byMessageId = new Map(rawEmails.map((e) => [e.messageId, e]));
    expect(byMessageId.size).toBe(rawEmails.length); // messageId uniques
    expect(new Set(rawEmails.map((e) => e.id)).size).toBe(rawEmails.length);
    for (const e of rawEmails) {
      if (e.inReplyTo) expect(byMessageId.has(e.inReplyTo)).toBe(true);
      for (const ref of e.references.split(/\s+/).filter(Boolean)) {
        expect(byMessageId.has(ref)).toBe(true);
      }
    }
  });

  test('getSubjectsWithMinEmails rend plusieurs sujets exploitables', () => {
    const subjects = analyzer.getSubjectsWithMinEmails(cleanEmails, 3, 'demo@example.com');
    expect(subjects.length).toBeGreaterThanOrEqual(8);
    // Newsletter / transactionnel : cibles du "Faire le menage"
    expect(subjects.some((s) => s.isNewsletter)).toBe(true);
    // Fil court a 2 participants, pour le contraste
    expect(subjects.some((s) => s.participants.length === 2)).toBe(true);
    // Fil vedette : 5 participants
    expect(subjects.some((s) => s.participants.length >= 5)).toBe(true);
    // L'utilisateur demo participe reellement a la conversation
    expect(subjects.some((s) => s.userReplied)).toBe(true);
  });

  test('au moins deux emails portent hasAttachments', () => {
    expect(rawEmails.filter((e) => e.hasAttachments === true).length).toBeGreaterThanOrEqual(2);
  });

  test('au moins un email a un bodyHtml riche avec citation', () => {
    const entries = fs
      .readFileSync(HTML_JSONL, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    expect(entries.length).toBeGreaterThan(0);
    // Le toggle de citation de email-detail.js cherche gmail_quote / <blockquote>
    expect(entries.some((e) => /gmail_quote|<blockquote/i.test(e.bodyHtml))).toBe(true);
    expect(entries.some((e) => /<table/i.test(e.bodyHtml))).toBe(true);
    // Chaque bodyHtml doit correspondre a un email du JSONL principal
    const ids = new Set(rawEmails.map((e) => e.id));
    for (const e of entries) expect(ids.has(e.id)).toBe(true);
  });

  test('chaque sujet produit un graphe {nodes, links} valide', () => {
    const subjects = analyzer.getSubjectsWithMinEmails(cleanEmails, 3, 'demo@example.com');
    for (const s of subjects) {
      const tree = analyzer.createTemporalGroupTree(cleanEmails, s.subject);
      expect(Array.isArray(tree.nodes)).toBe(true);
      expect(Array.isArray(tree.links)).toBe(true);
      expect(tree.nodes.length).toBe(s.emailCount);
      expect(tree.nodes.length).toBeGreaterThan(1);
      // Un arbre : un lien entrant par node, sauf la racine
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

  test('le fil vedette est profond ET ramifie (la capture README)', () => {
    const flagship = cleanEmails
      .map((e) => e.subject)
      .find((s) => s.startsWith('Q3 platform migration'));
    expect(flagship).toBeTruthy();

    const tree = analyzer.createTemporalGroupTree(cleanEmails, flagship);
    expect(tree.nodes.length).toBe(15);
    expect(tree.links.length).toBe(14);

    // 5 participants distincts
    expect(new Set(tree.nodes.map((n) => n.from)).size).toBe(5);

    // Au moins deux points de divergence -> de vraies branches, pas une ligne
    const childCount = new Map();
    for (const link of tree.links) {
      childCount.set(link.source, (childCount.get(link.source) || 0) + 1);
    }
    expect([...childCount.values()].filter((c) => c > 1).length).toBeGreaterThanOrEqual(2);

    // Et une vraie profondeur (le tronc = plus long chemin depuis la racine)
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
