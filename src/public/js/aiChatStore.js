/**
 * IndexedDB store for AI chat conversations, one entry per subject.
 * Schema v1 : keyPath = 'subjectKey'
 */

const DB_NAME = 'AIChatsDB';
const DB_VERSION = 1;
const STORE_NAME = 'chats';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'subjectKey' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB ouverture bloquee (autre onglet ?)'));
  });
}

export async function loadChat(subjectKey) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(subjectKey);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveChat(subjectKey, chatData) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const record = { ...chatData, subjectKey };
    store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function deleteChat(subjectKey) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(subjectKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function appendMessage(subjectKey, message) {
  const existing = await loadChat(subjectKey);
  const chat = existing || {
    subjectKey,
    messages: [],
    tokensIn: 0,
    tokensOut: 0,
    msgCount: 0,
    updatedAt: Date.now()
  };
  chat.messages.push(message);
  chat.msgCount = chat.messages.length;
  chat.updatedAt = Date.now();
  await saveChat(subjectKey, chat);
  return chat;
}
