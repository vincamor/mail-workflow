/**
 * Email filters management module
 * Configures and applies filters to exclude certain emails during download
 */

// Default filter configuration
const DEFAULT_FILTERS = {
  excludeNoSubject: true,
  excludeNotifications: true,
  excludePromotional: true,
  excludeShortConversations: false,
  minConversationLength: 3,
  useCustomAfterDate: false,
  customAfterDate: null,
  autoExcludeRepetitive: true,
  blacklistedSenders: [
    'noreply@facebook.com',
    'notifications@linkedin.com',
    'no-reply@google.com',
    'noreply@github.com',
  ],
  blacklistedKeywords: ['[SPAM]', 'Newsletter', 'Unsubscribe', 'Promotional'],
  blacklistedSubjects: [],
  notificationKeywords: [
    'noreply',
    'no-reply',
    'notification',
    'automated',
    'do-not-reply',
    'donotreply',
  ],
  promotionalKeywords: ['unsubscribe', 'promo', 'promotional', 'offer', 'sale', 'discount'],
};

// Key for IndexedDB
const FILTERS_STORAGE_KEY = 'emailFilters';

/**
 * Loads filters from IndexedDB
 * @returns {Promise<Object>} - Filter configuration
 */
export async function loadFilters() {
  try {
    const db = await openFiltersDB();
    const transaction = db.transaction(['filters'], 'readonly');
    const store = transaction.objectStore('filters');
    const request = store.get(FILTERS_STORAGE_KEY);

    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const savedFilters = request.result?.value || {};

        // Merge with default filters to ensure the keywords are present
        const filters = {
          ...DEFAULT_FILTERS,
          ...savedFilters,
          // Always include the default keywords if they are not customised
          notificationKeywords:
            savedFilters.notificationKeywords || DEFAULT_FILTERS.notificationKeywords,
          promotionalKeywords:
            savedFilters.promotionalKeywords || DEFAULT_FILTERS.promotionalKeywords,
        };

        console.log('✅ Filters loaded:', filters);
        resolve(filters);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    console.log('Using default filters');
    return { ...DEFAULT_FILTERS };
  }
}

/**
 * Saves filters to IndexedDB
 * @param {Object} filters - Filter configuration
 */
export async function saveFilters(filters) {
  try {
    const db = await openFiltersDB();
    const transaction = db.transaction(['filters'], 'readwrite');
    const store = transaction.objectStore('filters');

    // store.put() returns an IDBRequest, NOT a Promise: an `await` on it
    // resolves immediately without waiting for the transaction. So we wrap it
    // in a real Promise that only resolves once the transaction completes and
    // rejects on failure (otherwise errors are invisible and the caller's
    // success toast is misleading).
    await new Promise((resolve, reject) => {
      const request = store.put({
        key: FILTERS_STORAGE_KEY,
        value: filters,
      });
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    console.log('✅ Filters saved');
  } catch (e) {
    console.error('❌ Error saving filters:', e);
    // Propagate so the caller's catch fires (error toast).
    throw e;
  }
}

/**
 * Opens or creates the database for filters
 * @returns {Promise<IDBDatabase>}
 */
function openFiltersDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('EmailFiltersDB', 1);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('filters')) {
        db.createObjectStore('filters', { keyPath: 'key' });
      }
    };
  });
}

/**
 * Resets filters to their default values
 */
export async function resetFilters() {
  await saveFilters(DEFAULT_FILTERS);
  return DEFAULT_FILTERS;
}

/**
 * Checks whether an email should be excluded according to the filters
 * @param {Object} email - Email to check
 * @param {Object} filters - Filter configuration
 * @returns {Object} - { shouldExclude: boolean, reason: string }
 */
export function shouldExcludeEmail(email, filters) {
  const subject = (email.subject || '').toLowerCase();
  const from = (email.from || '').toLowerCase();

  // 1. Check for an empty subject
  if (filters.excludeNoSubject && (!email.subject || email.subject.trim() === '')) {
    return { shouldExclude: true, reason: 'No subject' };
  }

  // 2. Check for notifications
  if (filters.excludeNotifications) {
    const isNotification = filters.notificationKeywords.some(
      (keyword) => from.includes(keyword.toLowerCase()) || subject.includes(keyword.toLowerCase())
    );
    if (isNotification) {
      return { shouldExclude: true, reason: 'Notification' };
    }
  }

  // 3. Check for promotional content
  if (filters.excludePromotional) {
    const isPromotional = filters.promotionalKeywords.some((keyword) =>
      subject.includes(keyword.toLowerCase())
    );
    if (isPromotional) {
      return { shouldExclude: true, reason: 'Promotional' };
    }
  }

  // 4. Check the sender blocklist
  if (filters.blacklistedSenders && filters.blacklistedSenders.length > 0) {
    const isBlacklisted = filters.blacklistedSenders.some((sender) =>
      from.includes(sender.toLowerCase())
    );
    if (isBlacklisted) {
      return { shouldExclude: true, reason: 'Blocked sender' };
    }
  }

  // 5. Check the forbidden keywords
  if (filters.blacklistedKeywords && filters.blacklistedKeywords.length > 0) {
    const hasBlacklistedKeyword = filters.blacklistedKeywords.some((keyword) =>
      subject.includes(keyword.toLowerCase())
    );
    if (hasBlacklistedKeyword) {
      return { shouldExclude: true, reason: 'Forbidden keyword' };
    }
  }

  return { shouldExclude: false, reason: null };
}

/**
 * Filters a list of emails
 * @param {Array} emails - List of emails to filter
 * @param {Object} filters - Filter configuration
 * @returns {Object} - { filtered: Array, excluded: Array, stats: Object }
 */
export function filterEmails(emails, filters) {
  const filtered = [];
  const excluded = [];
  const stats = {
    total: emails.length,
    kept: 0,
    excluded: 0,
    reasons: {},
  };

  for (const email of emails) {
    const result = shouldExcludeEmail(email, filters);

    if (result.shouldExclude) {
      excluded.push({ ...email, exclusionReason: result.reason });
      stats.excluded++;
      stats.reasons[result.reason] = (stats.reasons[result.reason] || 0) + 1;
    } else {
      filtered.push(email);
      stats.kept++;
    }
  }

  return { filtered, excluded, stats };
}

/**
 * Gets the default filters
 * @returns {Object}
 */
export function getDefaultFilters() {
  return { ...DEFAULT_FILTERS };
}
