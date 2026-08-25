/**
 * Module de gestion des filtres d'emails
 * Permet de configurer et appliquer des filtres pour exclure certains emails lors du téléchargement
 */

// Configuration par défaut des filtres
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
    'noreply@github.com'
  ],
  blacklistedKeywords: [
    '[SPAM]',
    'Newsletter',
    'Unsubscribe',
    'Promotional'
  ],
  blacklistedSubjects: [],
  notificationKeywords: [
    'noreply',
    'no-reply',
    'notification',
    'automated',
    'do-not-reply',
    'donotreply'
  ],
  promotionalKeywords: [
    'unsubscribe',
    'promo',
    'promotional',
    'offer',
    'sale',
    'discount'
  ]
};

// Clé pour IndexedDB
const FILTERS_STORAGE_KEY = 'emailFilters';

/**
 * Charge les filtres depuis IndexedDB
 * @returns {Promise<Object>} - Configuration des filtres
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
        
        // Fusionner avec les filtres par défaut pour s'assurer que les keywords sont présents
        const filters = {
          ...DEFAULT_FILTERS,
          ...savedFilters,
          // Toujours inclure les keywords par défaut s'ils ne sont pas personnalisés
          notificationKeywords: savedFilters.notificationKeywords || DEFAULT_FILTERS.notificationKeywords,
          promotionalKeywords: savedFilters.promotionalKeywords || DEFAULT_FILTERS.promotionalKeywords
        };
        
        console.log('✅ Filtres chargés:', filters);
        resolve(filters);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    console.log('Utilisation des filtres par défaut');
    return { ...DEFAULT_FILTERS };
  }
}

/**
 * Sauvegarde les filtres dans IndexedDB
 * @param {Object} filters - Configuration des filtres
 */
export async function saveFilters(filters) {
  try {
    const db = await openFiltersDB();
    const transaction = db.transaction(['filters'], 'readwrite');
    const store = transaction.objectStore('filters');

    // store.put() renvoie un IDBRequest, PAS une Promise : un `await` dessus se
    // resout immediatement sans attendre la transaction. On enveloppe donc dans
    // une vraie Promise qui n'est resolue qu'a la fin de la transaction et
    // rejetee en cas d'echec (sinon les erreurs sont invisibles et le toast de
    // succes de l'appelant est mensonger).
    await new Promise((resolve, reject) => {
      const request = store.put({
        key: FILTERS_STORAGE_KEY,
        value: filters
      });
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    console.log('✅ Filtres sauvegardés');
  } catch (e) {
    console.error('❌ Erreur sauvegarde filtres:', e);
    // Propager pour que le catch de l'appelant se declenche (toast d'erreur).
    throw e;
  }
}

/**
 * Ouvre ou crée la base de données pour les filtres
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
 * Réinitialise les filtres aux valeurs par défaut
 */
export async function resetFilters() {
  await saveFilters(DEFAULT_FILTERS);
  return DEFAULT_FILTERS;
}

/**
 * Vérifie si un email doit être exclu selon les filtres
 * @param {Object} email - Email à vérifier
 * @param {Object} filters - Configuration des filtres
 * @returns {Object} - { shouldExclude: boolean, reason: string }
 */
export function shouldExcludeEmail(email, filters) {
  const subject = (email.subject || '').toLowerCase();
  const from = (email.from || '').toLowerCase();
  
  // 1. Vérifier le sujet vide
  if (filters.excludeNoSubject && (!email.subject || email.subject.trim() === '')) {
    return { shouldExclude: true, reason: 'Sans sujet' };
  }
  
  // 2. Vérifier les notifications
  if (filters.excludeNotifications) {
    const isNotification = filters.notificationKeywords.some(keyword => 
      from.includes(keyword.toLowerCase()) || subject.includes(keyword.toLowerCase())
    );
    if (isNotification) {
      return { shouldExclude: true, reason: 'Notification' };
    }
  }
  
  // 3. Vérifier les promotions
  if (filters.excludePromotional) {
    const isPromotional = filters.promotionalKeywords.some(keyword =>
      subject.includes(keyword.toLowerCase())
    );
    if (isPromotional) {
      return { shouldExclude: true, reason: 'Promotional' };
    }
  }
  
  // 4. Vérifier la liste noire d'expéditeurs
  if (filters.blacklistedSenders && filters.blacklistedSenders.length > 0) {
    const isBlacklisted = filters.blacklistedSenders.some(sender =>
      from.includes(sender.toLowerCase())
    );
    if (isBlacklisted) {
      return { shouldExclude: true, reason: 'Expéditeur bloqué' };
    }
  }
  
  // 5. Vérifier les mots-clés interdits
  if (filters.blacklistedKeywords && filters.blacklistedKeywords.length > 0) {
    const hasBlacklistedKeyword = filters.blacklistedKeywords.some(keyword =>
      subject.includes(keyword.toLowerCase())
    );
    if (hasBlacklistedKeyword) {
      return { shouldExclude: true, reason: 'Mot-clé interdit' };
    }
  }
  
  return { shouldExclude: false, reason: null };
}

/**
 * Filtre une liste d'emails
 * @param {Array} emails - Liste d'emails à filtrer
 * @param {Object} filters - Configuration des filtres
 * @returns {Object} - { filtered: Array, excluded: Array, stats: Object }
 */
export function filterEmails(emails, filters) {
  const filtered = [];
  const excluded = [];
  const stats = {
    total: emails.length,
    kept: 0,
    excluded: 0,
    reasons: {}
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
 * Obtient les filtres par défaut
 * @returns {Object}
 */
export function getDefaultFilters() {
  return { ...DEFAULT_FILTERS };
}

