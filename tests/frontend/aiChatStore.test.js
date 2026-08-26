/**
 * @jest-environment jsdom
 */

// jsdom does not expose structuredClone — polyfill from Node's globalThis
if (typeof globalThis.structuredClone === 'undefined') {
  globalThis.structuredClone = (v) => JSON.parse(JSON.stringify(v));
}

require('fake-indexeddb/auto');
const { describe, test, expect, beforeEach, beforeAll } = require('@jest/globals');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');

describe('aiChatStore (real module)', () => {
  let loadChat, saveChat, deleteChat, appendMessage;

  beforeAll(async () => {
    const mod = await import('../../src/public/js/aiChatStore.js');
    loadChat = mod.loadChat;
    saveChat = mod.saveChat;
    deleteChat = mod.deleteChat;
    appendMessage = mod.appendMessage;
  });

  beforeEach(() => {
    // Reset fake-indexeddb between tests so each test gets a clean DB
    global.indexedDB = new FDBFactory();
  });

  test('loadChat returns null for missing subject', async () => {
    const result = await loadChat('missing');
    expect(result).toBeNull();
  });

  test('saveChat + loadChat round-trip', async () => {
    const chat = {
      subjectKey: 'Projet Alpha',
      messages: [
        { role: 'user', content: 'Hi', ts: 1000 },
        { role: 'assistant', content: 'Hello', ts: 1001 },
      ],
      tokensIn: 50,
      tokensOut: 30,
      msgCount: 2,
      updatedAt: 1002,
    };
    await saveChat('Projet Alpha', chat);
    const loaded = await loadChat('Projet Alpha');
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[0].content).toBe('Hi');
    expect(loaded.tokensIn).toBe(50);
  });

  test('deleteChat removes entry', async () => {
    await saveChat('X', { subjectKey: 'X', messages: [], tokensIn: 0, tokensOut: 0, msgCount: 0 });
    await deleteChat('X');
    const loaded = await loadChat('X');
    expect(loaded).toBeNull();
  });

  test('appendMessage creates entry if missing', async () => {
    await appendMessage('New', { role: 'user', content: 'Hello', ts: 500 });
    const loaded = await loadChat('New');
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0].content).toBe('Hello');
    expect(loaded.msgCount).toBe(1);
  });

  test('appendMessage appends to existing entry', async () => {
    await saveChat('Exists', {
      subjectKey: 'Exists',
      messages: [{ role: 'user', content: 'a', ts: 1 }],
      tokensIn: 0,
      tokensOut: 0,
      msgCount: 1,
      updatedAt: 1,
    });
    await appendMessage('Exists', { role: 'assistant', content: 'b', ts: 2 });
    const loaded = await loadChat('Exists');
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.msgCount).toBe(2);
  });
});
