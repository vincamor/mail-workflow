# FileSystem Handle Workflow - Documentation

*Dernière mise à jour : Mars 2026 — v2 (Outlook complet)*

---

## Parcours des fonctions étape par étape

### 1. Sélection du dossier (première fois)
```
Utilisateur clique "Choisir dossier"
→ changeFolderBtn.onclick()            (folders.js → initFolderHandlers)
→ window.showDirectoryPicker()
→ storeFolderHandle(userId, handle)    (storage.js)
→ Handle stocké dans IndexedDB ✅
→ updateFolderStatus() + showStep2() + showStep3()
```

### 2. Rechargement de la page
```
Page se charge
→ DOMContentLoaded                     (app.js → initApp)
→ fetchEmails()                        → IDs Gmail + badge compteur
→ restoreFolder(userId)                (folders.js)
→ restoreFolderHandle(userId)          (storage.js)
→ handle.queryPermission() / handle.requestPermission()
→ Si OK : currentFolderHandle = handle ✅
→ Si pas OK : interface "Aucun dossier sélectionné"
→ startEmailPolling(provider, userId)  → 1er check immédiat + timer 5 min
→ autoAnalyzeConversations()           → analyse le JSONL local existant
```

### 3. Récupération des IDs de mails (Gmail)
```
Utilisateur connecté via OAuth
→ GET /gmail/emails                    (routes/gmail.js → gmailService.getEmails)
→ Paramètres optionnels :
   - filters  : filtres actifs (JSON encodé)
   - afterDate: internalDate du dernier email stocké (sync incrémentale)
→ buildGmailQuery(filters, afterDate)  → query Gmail API
→ getAllMessages() avec pagination (INBOX + SENT + ALL MAIL)
→ Déduplication par Map
→ Retourne 20 emails complets (affichage) + liste complète des IDs
```

### 4. Téléchargement complet des emails (Gmail)
```
Utilisateur clique "Télécharger les emails"
→ downloadEmails(messageIds, provider, userId, { appendMode: false })   (emails.js)
→ POST /gmail/download-chunks                    (SSE stream)
→ Server: gmailService.downloadEmailsInChunks()
   → Traitement par tranches de 500
   → Filtres appliqués (buildGmailQuery + shouldExcludeEmail)
   → SSE: type 'start' → type 'emails' → type 'progress' → type 'complete'
→ Client: lecture stream + écriture en mode overwrite
   → Écriture dans fichier .temp → copie vers gmail_emails.jsonl
   → writeSyncMetadata() → création de gmail_sync_metadata.json ✅
```

### 5. Mise à jour incrémentale des emails (Gmail)
```
Utilisateur clique "Mettre à jour" (ou syncEmails() appelée)
→ syncEmails(provider, userId)                   (emails.js)
→ Lire gmail_sync_metadata.json
   ├─ Pas de metadata + JSONL existant
   │   → bootstrapSyncMetadata()                 → crée la metadata depuis le JSONL existant
   │   → continue avec la sync incrémentale
   ├─ Pas de metadata + pas de JSONL
   │   → return false (premier téléchargement manuel requis)
   ├─ Filtres changés vs filtersUsed en metadata
   │   → afterDate = null, appendMode = false     → re-téléchargement complet
   └─ Filtres identiques
       → afterDate = lastInternalDate, appendMode = true
→ GET /gmail/emails?afterDate=...&filters=...    → IDs uniquement depuis cette date
→ Déduplication : retirer les IDs déjà dans le JSONL
→ downloadEmails(newIds, ..., { appendMode: true, silent: true })
   → Écriture en mode append (seek fin de fichier, keepExistingData: true)
   → writeSyncMetadata() → mise à jour gmail_sync_metadata.json ✅
```

### 6. Polling léger (badge "nouveaux emails")
```
Au chargement : startEmailPolling(provider, userId)
  → checkForNewEmails() immédiatement
  → setInterval(checkForNewEmails, 5 min)

checkForNewEmails() :
→ Lire gmail_sync_metadata.json → lastInternalDate + filtersUsed
→ GET /gmail/count?afterDate=...&filters=...     (3 appels légers en parallèle)
   → Server: gmailService.getEmailCount()
   → listMessageIds() × 3 (INBOX, SENT, ALL MAIL) → déduplication → newCount
→ updateNewEmailsBadge(newCount)
   → badge bouton "Mettre à jour" : affiche le nombre si > 0
   → CSS class "has-updates" pour highlighting visuel
```

### 7. Analyse des conversations
```
Automatiquement après chargement (ou bouton "Analyser")
→ autoAnalyzeConversations()           (analysis.js)
→ getEmailFileHandle(userId, provider) (folders.js)
→ loadSubjectsFromHandleChunkedOptimized(emailAnalyzer, fileHandle, 500)
→ emailAnalyzer.loadEmailsFromHandle() (emailAnalyzer_browser.js)
   → file.stream() → lecture par chunks → parse JSONL ligne par ligne
→ emailAnalyzer.cleanEmail()           → normalisation des emails
→ emailAnalyzer.getSubjectsWithMinEmails(emails, 3)
→ displaySubjects() → affichage liste (max 10 sujets)
```

### 8. Sélection d'un sujet
```
Utilisateur clique sur un sujet
→ toggleSubjectDrawer()                (analysis.js)
→ window.selectSubject(subject)
→ selectSubject(emailAnalyzer, treeVisualization, subject, ...)
→ getEmailFileHandle()
→ emailAnalyzer.getEmailsForSubjectOptimized(fileHandle, subjectInfo)
   → loadEmailsFromHandle() + filtrage en mémoire par sujet
→ emailAnalyzer.cleanEmail() sur chaque email
→ emailAnalyzer.createTemporalGroupTree(emailsClean, subject)
→ treeVisualization.createCompleteVisualization(tree) → HTML D3.js ✅
```

---

## Structure des fichiers locaux

```
[DossierChoisi]/
  EmailWorkflow/
    {userId}/
      gmail_emails.jsonl          ← emails Gmail (1 JSON par ligne)
      gmail_sync_metadata.json    ← metadata de sync Gmail (date, filtres, total)
      gmail_groups.json           ← groupes de sujets + favoris Gmail
      outlook_emails.jsonl        ← emails Outlook (1 JSON par ligne — même format que Gmail)
      outlook_sync_metadata.json  ← metadata de sync Outlook
      outlook_groups.json         ← groupes de sujets + favoris Outlook
```

### Format `gmail_sync_metadata.json`

```json
{
  "lastSyncDate": "2026-02-22T10:30:00.000Z",
  "lastInternalDate": "1740218400000",
  "totalEmails": 1843,
  "filtersUsed": {
    "excludeNotifications": true,
    "notificationKeywords": ["noreply", "no-reply", ...],
    "excludePromotional": true,
    "promotionalKeywords": ["newsletter", "promo", ...]
  },
  "provider": "gmail",
  "bootstrapped": true
}
```

> `bootstrapped: true` indique que la metadata a été créée depuis un JSONL existant (sans re-téléchargement).

---

## Avantages du système FileSystem Handle

- **Plus de saisie de chemins** : L'utilisateur ne tape jamais de chemins
- **Persistance automatique** : Le handle est restauré au rechargement via IndexedDB
- **Permissions gérées** : Vérification/demande automatique des droits d'accès
- **Analyse 100% locale** : Aucune donnée n'est envoyée au serveur pour l'analyse
- **Lecture par chunks** : Traitement progressif des gros fichiers (500 emails par chunk)
- **Écriture streaming** : Téléchargement sans charger tous les emails en mémoire
- **Sync incrémentale** : Seuls les nouveaux emails sont téléchargés (append sur le JSONL)
- **Polling léger** : Badge mis à jour toutes les 5 min sans téléchargement

---

## Fichiers impliqués

### Backend (Node.js / Express)
- `src/app.js` : Serveur Express, routes principales
- `src/routes/gmail.js` : Routes OAuth, téléchargement, comptage Gmail
- `src/routes/outlook.js` : Routes OAuth Outlook
- `src/services/gmailService.js` : OAuth Gmail + API Gmail + SSE + comptage léger
- `src/services/outlookService.js` : OAuth Outlook + API Microsoft Graph — refresh token automatique, `formatOutlookEmail`, `buildOutlookQuery`, `getAllMessagesFromFolder`, `downloadEmailsInChunks`, `getEmailCount`, `sendReply`

### Frontend (ES6 Modules, navigateur)
- `src/public/index.html` : Interface utilisateur principale
- `src/public/js/app.js` : Point d'entrée, orchestration, polling
- `src/public/js/auth.js` : Gestion de l'authentification côté client
- `src/public/js/folders.js` : FileSystem Handle API + gestion dossier
- `src/public/js/storage.js` : Persistance IndexedDB (handles de dossiers)
- `src/public/js/emails.js` : Téléchargement, sync incrémentale, metadata, polling
- `src/public/js/analysis.js` : Orchestration de l'analyse et de l'affichage
- `src/public/js/email-detail.js` : Affichage du détail d'un email
- `src/public/js/filterUI.js` : Interface des filtres
- `src/public/js/emailFilters.js` : Logique de filtrage
- `src/public/js/panels.js` : Gestion des panneaux UI
- `src/public/js/ui.js` : Composants UI (overlays, animations)
- `src/services/emailAnalyzer_browser.js` : Analyse des emails côté client (version principale)
- `src/services/treeVisualization.js` : Visualisation D3.js des arbres de conversation

---

## Base de données IndexedDB

- **Nom** : `EmailWorkflowDB`
- **ObjectStore** : `folderHandles`
- **Clé** : `userId` (email de l'utilisateur)
- **Valeur** : `FileSystemDirectoryHandle`

---

## Fonctions principales

### IndexedDB (`storage.js`)
- `openDB()` : Ouvre/crée la base de données IndexedDB
- `storeFolderHandle(userId, handle)` : Stocke un handle avec vérification
- `restoreFolderHandle(userId)` : Restaure un handle avec gestion des permissions
- `deleteFolderHandle(userId)` : Supprime un handle

### FileSystem (`folders.js`)
- `getEmailFileHandle(userId, provider)` : Obtient le handle du fichier JSONL
- `analyzeEmailFile(fileHandle)` : Lit le JSONL en **streaming par chunks** et retourne `{ exists, emailCount, emailIds }`. Extrait uniquement l'`id` de chaque ligne — l'objet complet est éligible au GC immédiatement. Ne retourne plus le tableau `emails` complet (supprimé pour éviter les crashs mémoire).
- `getEmailStats(emails)` : Statistiques de date sur une liste d'emails
- `restoreFolder(userId)` : Restaure le handle au rechargement de page
- `initFolderHandlers(userId, callback)` : Initialise le bouton de sélection

### Téléchargement et sync (`emails.js`)
- `downloadEmails(messageIds, provider, userId, options)` : Télécharge et écrit le JSONL
  - `options.appendMode` : `true` = ajout aux emails existants, `false` = réécriture complète
  - `options.silent` : `true` = pas de dialog de confirmation (sync automatique)
  - `options.existingEmailCount` : nombre d'emails déjà présents (pour le total en metadata)
- `syncEmails(provider, userId)` : Orchestration de la sync incrémentale complète
- `bootstrapSyncMetadata(userFolderHandle, provider, filters)` : Crée la metadata depuis un JSONL existant sans re-télécharger
- `readSyncMetadata(userFolderHandle, provider)` : Lit `{provider}_sync_metadata.json`
- `writeSyncMetadata(userFolderHandle, provider, data)` : Écrit `{provider}_sync_metadata.json`
- `startEmailPolling(provider, userId, intervalMs)` : Démarre le polling toutes les 5 min
- `stopEmailPolling()` : Arrête le polling
- `checkForNewEmails(provider, userId)` : Vérifie le nombre de nouveaux emails (léger)
- `updateNewEmailsBadge(count)` : Met à jour le badge du bouton "Mettre à jour"

### API Gmail serveur (`gmailService.js`)
- `buildGmailQuery(filters, afterDate)` : Construit la query Gmail API (filtres + date)
- `getEmails(req, res)` : Récupère IDs + 20 emails display. Accepte `?afterDate=` et `?filters=`
- `downloadEmailsInChunks(req, res)` : Télécharge les emails par tranches via SSE
- `getEmailCount(req, res)` : Retourne uniquement `{ newCount }` — endpoint léger pour polling

### Analyse d'emails (`emailAnalyzer_browser.js`)
- `loadEmailsFromHandle(fileHandle, chunkSize)` : Charge tous les emails par chunks en **streaming**. Pour chaque ligne, crée un objet allégé avec uniquement les champs utiles (`id`, `threadId`, `subject`, `from`, `to`, `cc`, `date`, `messageId`, `inReplyTo`, `references`, `internalDate`, `bodyText`, `snippet`, `labelIds`). L'objet complet parsé (`full`) — contenant `bodyHtml` et `originalPayload` — sort de portée immédiatement et est libéré par le GC. Réduit le pic mémoire de ~80 Ko/email à ~15 Ko/email.
- `cleanEmail(email)` : Normalise un email brut
- `getSubjectsWithMinEmails(emails, minCount)` : Extrait les sujets avec 3+ mails
- `getEmailsForSubjectOptimized(fileHandle, subjectInfo)` : Récupère les emails d'un sujet
- `createTemporalGroupTree(emails, subject)` : Construit l'arbre de conversation
- `extractSubject/From/Date/BodyContent(email)` : Extracteurs de champs

---

## Structure des données email (format JSONL)

Chaque ligne du fichier `.jsonl` est un objet JSON produit par `formatGmailEmail()` :

```json
{
  "id": "...",
  "threadId": "...",
  "labelIds": [...],
  "snippet": "...",
  "subject": "...",
  "from": "...",
  "to": "...",
  "cc": "...",
  "date": "...",
  "messageId": "...",
  "inReplyTo": "...",
  "references": "...",
  "internalDate": "1740218400000",
  "bodyText": "...",
  "bodyHtml": "...",
  "originalPayload": { ... }
}
```

> `internalDate` est un timestamp en millisecondes (format Gmail). C'est la valeur utilisée comme référence de date pour la sync incrémentale (`afterDate`).

> **Note sur les champs `bodyHtml` et `originalPayload`** : Ces champs sont écrits dans le JSONL mais **ne doivent pas être chargés en mémoire** lors des traitements globaux (analyse des sujets, déduplication). `loadEmailsFromHandle` crée un objet allégé sans ces champs. Seul `getEmailsForSubjectOptimized` les lit lorsque l'utilisateur sélectionne un sujet spécifique — et même là, ils peuvent être ignorés si seul `bodyText` est exploité.

> **Champs utilisés par `reply.js`** : `threadId`, `messageId`, `references`, `from`, `to`, `cc`, `subject`. Ces champs doivent être présents dans l'objet email passé à `showReplyForm`.

---

## Architecture technique

- **Frontend** : HTML + JavaScript ES6 modules + D3.js pour visualisation
- **Backend** : Node.js + Express
- **Stockage** : IndexedDB (handles) + FileSystem API (fichiers JSONL + metadata JSON) — aucune base de données SQL
- **Analyse** : 100% côté client avec `emailAnalyzer_browser.js`
- **Authentification** : OAuth2 Gmail (googleapis) + Outlook (MSAL + Microsoft Graph) avec sessions Express
- **Streaming** : Server-Sent Events (SSE) pour le téléchargement progressif
- **Sync** : Incrémentale par date + déduplication par IDs + bootstrap automatique

---

## Workflow complet

1. **Connexion** : OAuth Gmail ou Outlook → tokens stockés en session Express
2. **Configuration dossier** : Sélection dossier → Stockage handle dans IndexedDB
3. **Récupération IDs** : `GET /gmail/emails` → liste des IDs de messages
4. **Téléchargement initial** : `POST /gmail/download-chunks` → SSE → écriture JSONL → création `gmail_sync_metadata.json`
5. **Polling** : `GET /gmail/count?afterDate=...` toutes les 5 min → badge mis à jour
6. **Mise à jour** : Clic "Mettre à jour" → `syncEmails()` → append JSONL → metadata mise à jour
7. **Analyse** : Lecture JSONL par chunks → extraction des sujets (min. 3 emails)
8. **Visualisation** : Sélection sujet → arbre temporel D3.js

---

## Logique de sync incrémentale — détail

### Premier chargement (aucun fichier)
```
syncEmails() → pas de metadata → pas de JSONL → return false
→ L'utilisateur doit cliquer "Télécharger les emails" manuellement
→ downloadEmails() crée JSONL + gmail_sync_metadata.json
```

### Premier chargement avec JSONL existant (migration)
```
syncEmails() → pas de metadata → JSONL existant détecté
→ bootstrapSyncMetadata() :
   - Lit le JSONL en streaming
   - Trouve le max(internalDate) parmi tous les emails
   - Compte le total
   - Écrit gmail_sync_metadata.json avec { bootstrapped: true }
→ Reprend la sync avec lastInternalDate du JSONL
→ Télécharge uniquement les emails postérieurs en mode append
```

### Sync normale (metadata présente, filtres inchangés)
```
syncEmails() → lit metadata → filtres identiques
→ afterDate = lastInternalDate, appendMode = true
→ GET /gmail/emails?afterDate=... → IDs depuis cette date
→ Déduplication : retire les IDs déjà dans le JSONL
→ downloadEmails(newIds, ..., { appendMode: true, silent: true })
→ Écriture à la fin du JSONL (seek + keepExistingData: true)
→ Mise à jour metadata
```

### Sync avec changement de filtres (mode strict)
```
syncEmails() → lit metadata → filtres DIFFÉRENTS de filtersUsed
→ afterDate = null, appendMode = false
→ Re-téléchargement complet avec les nouveaux filtres
→ Réécriture du JSONL (mode overwrite)
→ Mise à jour metadata avec les nouveaux filtres
```

---

## Routes API Gmail

| Méthode | Route | Fonction | Description |
|---|---|---|---|
| `GET` | `/gmail` | `initAuth` | Démarre OAuth |
| `GET` | `/gmail/callback` | `handleCallback` | Callback OAuth → session |
| `GET` | `/gmail/emails` | `getEmails` | IDs + 20 emails display. Params: `?filters=`, `?afterDate=` |
| `GET` | `/gmail/count` | `getEmailCount` | Nombre de nouveaux emails (polling léger). Params: `?filters=`, `?afterDate=` |
| `POST` | `/gmail/download-chunks` | `downloadEmailsInChunks` | Téléchargement SSE par tranches de 500 |
| `POST` | `/gmail/reply` | `sendReply` | Envoie une réponse dans un thread Gmail existant. Body : `{ to, cc?, subject, body, threadId, messageId, references? }` |

---

## Routes API Outlook

| Méthode | Route | Fonction | Description |
|---|---|---|---|
| `GET` | `/outlook` | `initAuth` | Démarre OAuth Microsoft |
| `GET` | `/outlook/callback` | `handleCallback` | Callback OAuth → `req.session.tokens` |
| `GET` | `/outlook/emails` | `getEmails` | IDs + 20 emails display. Params: `?filters=`, `?afterDate=`. Interroge `inbox` + `sentitems` avec pagination `@odata.nextLink`. |
| `GET` | `/outlook/email/:messageId` | `getEmailDetail` | Détail complet d'un email au format JSONL unifié |
| `GET` | `/outlook/count` | `getEmailCount` | Nombre de nouveaux emails (polling léger). Appels parallèles inbox + sentitems, `$select=id` uniquement. |
| `POST` | `/outlook/download-chunks` | `downloadEmailsInChunks` | Téléchargement SSE par tranches de 500 — format identique à Gmail |
| `POST` | `/outlook/reply` | `sendReply` | Envoie une réponse via `POST /me/messages/{id}/reply`. Body : `{ to, cc?, subject, body, id, threadId, messageId }`. Retourne HTTP 202 Accepted. |

---

## Problèmes résolus

### 1. Récupération des emails par sujet (RÉSOLU)
**Problème** : `getEmailsForSubjectOptimized` ne trouvait aucun email malgré des chunks valides.
**Cause** : Incohérence dans le comptage des chunks entre plusieurs streams FileSystem.
**Solution** : Simplification — lecture complète du fichier + filtrage en mémoire.

### 2. IndexedDB (RÉSOLU)
**Problème** : Les handles n'étaient pas correctement stockés/récupérés.
**Cause** : Utilisation incorrecte des IDBRequest (traitement synchrone au lieu des callbacks).
**Solution** : Utilisation systématique des callbacks `onsuccess` / `onerror`.

### 3. Import ES6 (RÉSOLU)
**Problème** : Erreur 404 lors de l'import de `emailAnalyzer_browser.js`.
**Cause** : Chemin relatif incorrect + serveur non configuré pour servir `/services`.
**Solution** : `app.use('/services', express.static(...))` + chemin absolu dans l'import.

### 4. ReferenceError afterDate dans syncEmails (RÉSOLU)
**Problème** : `ReferenceError: afterDate is not defined` au clic sur "Mettre à jour".
**Cause** : Les variables `afterDate` et `appendMode` étaient assignées dans un bloc `if/else` sans avoir été déclarées avec `let` au préalable. En mode strict ES6, cela lève une erreur.
**Solution** : Ajout de `let afterDate = null; let appendMode = false;` avant le bloc conditionnel.

### 5. Out of Memory lors de la sync incrémentale (RÉSOLU)
**Problème** : Crash navigateur "Out of Memory" lors du clic sur "Mettre à jour", notamment sur les collections de 2 000+ emails.
**Cause** : Trois accumulations mémoire simultanées lors de la séquence `syncEmails()` → `autoAnalyzeConversations()` :
1. `analyzeEmailFile` chargeait le JSONL entier en string (`file.text()`), en tableau de lignes (`split('\n')`), puis en tableau d'objets complets avec `bodyHtml` + `originalPayload` (~560 Mo pour 5 000 emails)
2. `loadEmailsFromHandle` créait l'objet complet (~80 Ko) puis utilisait `delete` — la mémoire allouée n'était pas libérée immédiatement par le GC
3. `loadSubjectsFromHandleChunkedOptimized` maintenait deux tableaux simultanément : `emails` bruts et `emailsClean`, avec `bodyText` inutilement copié

**Solutions** :
- `analyzeEmailFile` (`folders.js`) : réécriture en streaming — seul l'`id` est extrait, le tableau `emails` est supprimé. Pic mémoire : 2 Mo au lieu de 560 Mo.
- `loadEmailsFromHandle` (`emailAnalyzer_browser.js`) : création d'un objet allégé directement à partir du `full` parsé — `full` sort de portée immédiatement. Pic : 15 Ko/email au lieu de 80 Ko.
- `loadSubjectsFromHandleChunkedOptimized` (`analysis.js`) : `emails.length = 0` après le `map` + `emailsClean.forEach(e => { e.bodyText = ''; })` — `bodyText` non nécessaire pour l'extraction des sujets, rechargé à la demande lors de la sélection.

---

## Problèmes connus / Points d'attention

### 1. Outlook — téléchargement par chunks
**Statut** : ✅ Implémenté (Mars 2026)
**Description** : `outlookService.downloadEmailsInChunks` implémente le workflow SSE → JSONL → metadata → sync incrémentale identique à Gmail. Les emails Outlook sont normalisés via `formatOutlookEmail()` en format JSONL identique à Gmail.

### 2. `getEmailDetail` Outlook
**Statut** : ✅ Corrigé (Mars 2026)
**Description** : La fonction lisait `req.session?.outlookTokens?.accessToken` (inexistant). Corrigé en `req.session?.tokens?.access_token`. Route `GET /outlook/email/:messageId` opérationnelle.

### 3. Routes serveur legacy (`/analyze/subjects`, `/analyze/tree`)
**Statut** : Code mort
**Description** : Ces routes dans `app.js` utilisent `emailAnalyzer.js` (version serveur). Inutilisées car l'analyse est entièrement côté client. Peuvent être supprimées.

### 4. Streams FileSystem
**Attention** : Ne pas ouvrir plusieurs streams simultanés sur le même fichier — problèmes de synchronisation connus.

### 5. Polling Gmail et Outlook
**Statut** : ✅ Implémenté pour les deux providers (Mars 2026)
**Description** : `checkForNewEmails` appelle `/${provider}/count` dynamiquement. La route `/outlook/count` existe et retourne `{ newCount }`. Le polling est actif pour les deux providers.

---

## État actuel du projet (Mars 2026)

### Fonctionnalités opérationnelles
- [x] Sélection et persistance des dossiers avec IndexedDB
- [x] Téléchargement d'emails Gmail par chunks avec streaming SSE
- [x] Filtres Gmail (expéditeurs, sujets, notifications, promotions)
- [x] Analyse des sujets par chunks (optimisé, 500 emails/chunk)
- [x] Récupération des emails par sujet (lecture complète + filtrage mémoire)
- [x] Génération d'arbres de conversation (logique groupes de participants)
- [x] Visualisation D3.js des arbres
- [x] Interface utilisateur 3 panneaux avec CSS modulaire
- [x] Authentification Gmail et Outlook (OAuth2) — les deux providers complets
- [x] Sync incrémentale Gmail (append + metadata)
- [x] Bootstrap automatique de la metadata depuis JSONL existant
- [x] Polling léger toutes les 5 min avec badge "nouveaux emails"
- [x] Bouton "Mettre à jour" avec reset du badge après sync
- [x] Affichage du champ CC dans la modal de détail email
- [x] **Réponse aux emails Gmail** (Répondre / Répondre à tous) depuis la modal
- [x] Optimisations mémoire : `analyzeEmailFile` streaming, `loadEmailsFromHandle` objets allégés, libération anticipée dans le pipeline d'analyse
- [x] **Outlook complet** : téléchargement SSE par chunks (`POST /outlook/download-chunks`), sync incrémentale, polling badge (`GET /outlook/count`), détail email (`GET /outlook/email/:id`), réponse (`POST /outlook/reply`)
- [x] Format JSONL unifié Gmail/Outlook : `formatOutlookEmail()` produit le même format que `formatGmailEmail()`, tout le pipeline client est réutilisé sans modification

### Non implémenté / Incomplet
- [x] Téléchargement Outlook par chunks (SSE + écriture JSONL + sync incrémentale) — ✅ Fait
- [x] Détail email Outlook (`getEmailDetail`) — ✅ Bug corrigé, route opérationnelle
- [x] Route `/outlook/count` pour le polling Outlook — ✅ Fait
- [x] Réponse aux emails Outlook — ✅ Implémenté via `POST /outlook/reply` + Microsoft Graph
- [ ] Indexation par position dans le fichier pour recherche optimisée
- [ ] Cache des résultats d'analyse (éviter les re-calculs)
- [ ] Tests unitaires

### Fichiers à nettoyer
- [ ] `src/services/folderManagerService.js` — inutilisé, peut être supprimé
- [ ] Routes `/analyze/subjects` et `/analyze/tree` dans `src/app.js` — legacy
- [ ] `src/services/emailAnalyzer.js` — uniquement utilisé par les routes legacy ci-dessus

---

## Points d'attention pour les développeurs

1. **FileSystem Handle** : Ne peut pas être passé au serveur → toute lecture du JSONL doit se faire côté client
2. **Streams FileSystem** : Ne pas ouvrir plusieurs streams simultanés sur le même fichier
3. **IndexedDB** : Toujours utiliser les callbacks `onsuccess`/`onerror`, jamais de traitement synchrone
4. **Modules ES6** : Utiliser des chemins absolus pour les imports côté client (`/services/...`)
5. **Session Express** : La clé des tokens est `req.session.tokens` (pas `req.session.gmailTokens` ni `req.session.outlookTokens`)
6. **Deux analyseurs** : `emailAnalyzer_browser.js` (client, ES6 `export default`) ≠ `emailAnalyzer.js` (serveur, `module.exports`) — ne pas les confondre
7. **afterDate** : C'est un `internalDate` Gmail en **millisecondes** (string). Ne pas confondre avec un timestamp en secondes. Toujours parser avec `parseInt()`.
8. **Sync incrémentale** : L'`appendMode` utilise `createWritable({ keepExistingData: true })` + `seek(file.size)`. Un seul stream ouvert à la fois sur le fichier.
9. **Filtres stricts** : Si les filtres changent entre deux syncs, `syncEmails()` force un re-téléchargement complet (mode overwrite) pour garantir la cohérence du JSONL.
10. **Mémoire — ne jamais charger le JSONL en entier en string** : `file.text()` sur un JSONL de plusieurs milliers d'emails peut dépasser 100 Mo d'un coup. Toujours utiliser `file.stream()` + traitement ligne par ligne. Voir `analyzeEmailFile` et `loadEmailsFromHandle` pour les patterns corrects.
11. **Scope OAuth `gmail.send`** : Requis pour `POST /gmail/reply`. Si les scopes OAuth sont modifiés dans `initAuth`, les utilisateurs existants doivent se déconnecter et se reconnecter pour obtenir les nouveaux tokens.
12. **`analyzeEmailFile` ne retourne plus `emails`** : Le tableau complet d'emails a été supprimé du retour pour des raisons mémoire. Si une autre fonction en avait besoin, elle doit utiliser `loadEmailsFromHandle` directement.

---

## Prochaines étapes suggérées

1. **Outlook complet** : Implémenter `downloadEmailsInChunks` + `getEmailCount` pour Outlook sur le modèle Gmail, puis activer la sync incrémentale et le polling
2. **Réponse Outlook** : Porter `reply.js` et `sendReply` pour Outlook (Microsoft Graph `POST /messages/{id}/reply`) une fois le téléchargement Outlook stabilisé
3. **Corriger le bug Outlook** : Harmoniser la clé de session (`req.session.tokens`)
4. **Nettoyage** : Supprimer `folderManagerService.js`, routes legacy `/analyze/*`, `emailAnalyzer.js`
5. **Optimisation lecture** : Indexation par position octet dans le fichier pour éviter la lecture complète à chaque sélection de sujet
6. **Cache analyse** : Mettre en cache les sujets analysés pour éviter de relire le fichier à chaque fois
