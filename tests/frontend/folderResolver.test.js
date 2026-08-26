const { describe, test, expect, beforeAll } = require('@jest/globals');

// Mock minimal d'un FileSystemDirectoryHandle (pas de DOM/IDB nécessaire).
function makeDir(name, { files = [], dirs = {} } = {}) {
  const self = {
    kind: 'directory',
    name,
    _files: [...files],
    _dirs: { ...dirs },
    async getDirectoryHandle(n, opts = {}) {
      if (self._dirs[n]) return self._dirs[n];
      if (opts.create) {
        const d = makeDir(n);
        self._dirs[n] = d;
        return d;
      }
      const e = new Error('NotFound: ' + n);
      e.name = 'NotFoundError';
      throw e;
    },
    async getFileHandle(n, opts = {}) {
      if (self._files.includes(n)) return { kind: 'file', name: n };
      if (opts.create) {
        self._files.push(n);
        return { kind: 'file', name: n };
      }
      const e = new Error('NotFound: ' + n);
      e.name = 'NotFoundError';
      throw e;
    },
    async *entries() {
      for (const f of self._files) yield [f, { kind: 'file', name: f }];
      for (const dn of Object.keys(self._dirs)) yield [dn, self._dirs[dn]];
    },
  };
  return self;
}

describe('resolveUserFolderHandle — tolérance de niveau de dossier', () => {
  const USER = 'me@example.com';
  let resolveUserFolderHandle;

  beforeAll(async () => {
    const mod = await import('../../src/public/js/folderResolver.js');
    resolveUserFolderHandle = mod.resolveUserFolderHandle;
  });

  test('racine sélectionnée → <root>/EmailWorkflow/<user>', async () => {
    const userDir = makeDir(USER, { files: ['gmail_emails.jsonl'] });
    const ew = makeDir('EmailWorkflow', { dirs: { [USER]: userDir } });
    const root = makeDir('Stockage', { dirs: { EmailWorkflow: ew } });
    expect(await resolveUserFolderHandle(root, USER)).toBe(userDir);
  });

  test('dossier EmailWorkflow sélectionné → <root>/<user>', async () => {
    const userDir = makeDir(USER, { files: ['gmail_emails.jsonl'] });
    const ew = makeDir('EmailWorkflow', { dirs: { [USER]: userDir } });
    expect(await resolveUserFolderHandle(ew, USER)).toBe(userDir);
  });

  test('dossier compte sélectionné directement (nom == userId)', async () => {
    const acct = makeDir(USER, { files: ['gmail_emails.jsonl'] });
    expect(await resolveUserFolderHandle(acct, USER)).toBe(acct);
  });

  test('dossier compte sélectionné (détection *_emails.jsonl, nom différent)', async () => {
    const acct = makeDir('renomme', { files: ['outlook_emails.jsonl'] });
    expect(await resolveUserFolderHandle(acct, USER)).toBe(acct);
  });

  test('dossier sans rapport, create:false → null', async () => {
    const root = makeDir('Downloads', {});
    expect(await resolveUserFolderHandle(root, USER, { create: false })).toBeNull();
  });

  test('dossier sans rapport, create:true → crée EmailWorkflow/<user>', async () => {
    const root = makeDir('Downloads', {});
    const res = await resolveUserFolderHandle(root, USER, { create: true });
    expect(res).toBeTruthy();
    expect(res.name).toBe(USER);
    expect(root._dirs.EmailWorkflow).toBeTruthy();
    expect(root._dirs.EmailWorkflow._dirs[USER]).toBe(res);
  });

  test('handle racine null → null', async () => {
    expect(await resolveUserFolderHandle(null, USER)).toBeNull();
  });

  test('priorité : structure EmailWorkflow gagne sur un jsonl à la racine', async () => {
    // Racine contenant À LA FOIS un jsonl parasite et la vraie structure :
    // on doit privilégier <root>/EmailWorkflow/<user>.
    const userDir = makeDir(USER, { files: ['gmail_emails.jsonl'] });
    const ew = makeDir('EmailWorkflow', { dirs: { [USER]: userDir } });
    const root = makeDir('Stockage', {
      files: ['gmail_emails.jsonl'],
      dirs: { EmailWorkflow: ew },
    });
    expect(await resolveUserFolderHandle(root, USER)).toBe(userDir);
  });
});
