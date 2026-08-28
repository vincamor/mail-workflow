const { describe, test, expect, beforeAll } = require('@jest/globals');

// Minimal mock of a FileSystemDirectoryHandle (no DOM/IDB needed).
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

describe('resolveUserFolderHandle — folder level tolerance', () => {
  const USER = 'me@example.com';
  let resolveUserFolderHandle;

  beforeAll(async () => {
    const mod = await import('../../src/public/js/folderResolver.js');
    resolveUserFolderHandle = mod.resolveUserFolderHandle;
  });

  test('root selected → <root>/EmailWorkflow/<user>', async () => {
    const userDir = makeDir(USER, { files: ['gmail_emails.jsonl'] });
    const ew = makeDir('EmailWorkflow', { dirs: { [USER]: userDir } });
    const root = makeDir('Stockage', { dirs: { EmailWorkflow: ew } });
    expect(await resolveUserFolderHandle(root, USER)).toBe(userDir);
  });

  test('EmailWorkflow folder selected → <root>/<user>', async () => {
    const userDir = makeDir(USER, { files: ['gmail_emails.jsonl'] });
    const ew = makeDir('EmailWorkflow', { dirs: { [USER]: userDir } });
    expect(await resolveUserFolderHandle(ew, USER)).toBe(userDir);
  });

  test('account folder selected directly (name == userId)', async () => {
    const acct = makeDir(USER, { files: ['gmail_emails.jsonl'] });
    expect(await resolveUserFolderHandle(acct, USER)).toBe(acct);
  });

  test('account folder selected (detection *_emails.jsonl, different name)', async () => {
    const acct = makeDir('renomme', { files: ['outlook_emails.jsonl'] });
    expect(await resolveUserFolderHandle(acct, USER)).toBe(acct);
  });

  test('unrelated folder, create:false → null', async () => {
    const root = makeDir('Downloads', {});
    expect(await resolveUserFolderHandle(root, USER, { create: false })).toBeNull();
  });

  test('unrelated folder, create:true → creates EmailWorkflow/<user>', async () => {
    const root = makeDir('Downloads', {});
    const res = await resolveUserFolderHandle(root, USER, { create: true });
    expect(res).toBeTruthy();
    expect(res.name).toBe(USER);
    expect(root._dirs.EmailWorkflow).toBeTruthy();
    expect(root._dirs.EmailWorkflow._dirs[USER]).toBe(res);
  });

  test('root handle null → null', async () => {
    expect(await resolveUserFolderHandle(null, USER)).toBeNull();
  });

  test('priority: EmailWorkflow structure wins over jsonl in root', async () => {
    // Root containing BOTH a parasitic jsonl and the real structure:
    // we must prioritise <root>/EmailWorkflow/<user>.
    const userDir = makeDir(USER, { files: ['gmail_emails.jsonl'] });
    const ew = makeDir('EmailWorkflow', { dirs: { [USER]: userDir } });
    const root = makeDir('Stockage', {
      files: ['gmail_emails.jsonl'],
      dirs: { EmailWorkflow: ew },
    });
    expect(await resolveUserFolderHandle(root, USER)).toBe(userDir);
  });
});
