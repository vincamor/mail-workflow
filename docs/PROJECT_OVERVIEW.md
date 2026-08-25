# Documentation générale du projet — MailProjetJul

*À destination d'une IA ou d'un développeur prenant le projet en main.*
*Dernière mise à jour : Mars 2026 — v5 (Phase 1–2 SaaS : refresh token Outlook, Redis sessions, rate limiting, détection navigateur, suppression dead code, buttons opt-in, audit window.*)*

---

## Sommaire

1. [Vue d'ensemble](#1-vue-densemble)
2. [Architecture générale](#2-architecture-générale)
3. [Carte des fichiers et responsabilités](#3-carte-des-fichiers-et-responsabilités)
4. [Flux de données principal](#4-flux-de-données-principal)
5. [Système de stockage local (FileSystem + IndexedDB)](#5-système-de-stockage-local-filesystem--indexeddb)
6. [Pipeline d'analyse et de visualisation](#6-pipeline-danalyse-et-de-visualisation)
7. [Module de visualisation D3.js — points critiques](#7-module-de-visualisation-d3js--points-critiques)
8. [Couplages implicites et pièges à éviter](#8-couplages-implicites-et-pièges-à-éviter)
9. [Variables globales et état partagé](#9-variables-globales-et-état-partagé)
10. [État du projet et ce qui est fragile](#10-état-du-projet-et-ce-qui-est-fragile)
11. [Ce qui n'est pas implémenté](#11-ce-qui-nest-pas-implémenté)
12. [Règles et conventions à respecter](#12-règles-et-conventions-à-respecter)
13. [Feature : Groupes de sujets et Favoris](#13-feature--groupes-de-sujets-et-favoris)
14. [Feature : Réponse aux emails Gmail](#14-feature--réponse-aux-emails-gmail)

---

## 1. Vue d'ensemble

**Objectif** : outil de visualisation de mails pour la gestion de projet. L'utilisateur connecte son compte Gmail ou Outlook, télécharge ses emails localement, puis visualise ses conversations sous forme d'arbres chronologiques interactifs en D3.js.

**Philosophie du projet** :
- Tout ce qui est analyse et visualisation se passe **100 % côté client** (navigateur). Le serveur ne fait que proxy OAuth + téléchargement via l'API Gmail.
- Les données sont stockées **sur le disque de l'utilisateur** via l'API FileSystem du navigateur. Aucune base de données SQL, aucun stockage serveur.
- L'architecture est **fragile par endroits** : beaucoup de modules sont imbriqués, les streams FileSystem sont sensibles, et la chaîne de dimensionnement D3 repose sur des timings précis.

---

## 2. Architecture générale

```
┌─────────────────────────────────────────────────────┐
│                    NAVIGATEUR                        │
│                                                      │
│  index.html ─── app.js (orchestrateur)              │
│                     │                                │
│    ┌────────────┬────┴────────┬────────────┐         │
│    ▼            ▼             ▼            ▼         │
│  auth.js    folders.js    emails.js    analysis.js   │
│  (OAuth)   (FileSystem   (download,   (sujets,       │
│            Handle API)    sync, poll)  arbre)        │
│                │                         │           │
│           storage.js             emailAnalyzer_      │
│           (IndexedDB)            browser.js          │
│                                          │           │
│                                  treeVisualization.js│
│                                  (D3.js rendu SVG)   │
│                                                      │
│  Modules UI : ui.js, panels.js, filterUI.js,         │
│               emailFilters.js, email-detail.js       │
│  Module réponse : reply.js                           │
│  Modules groupes : groups.js, groupContextMenu.js    │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP (OAuth + SSE)
┌──────────────────────▼──────────────────────────────┐
│                  BACKEND Node.js/Express             │
│                                                      │
│  app.js ── routes/gmail.js ── gmailService.js        │
│         └─ routes/outlook.js ─ outlookService.js     │
└─────────────────────────────────────────────────────┘
```

**Le backend est minimal** : son seul travail est OAuth2, téléchargement SSE et envoi de réponses via l'API Gmail. Il ne stocke rien, il ne fait pas d'analyse.

---

## 3. Carte des fichiers et responsabilités

### Backend (`src/`)

| Fichier | Rôle | Notes |
|---|---|---|
| `src/app.js` | Serveur Express, montage des routes | Démarrage async ; session store Redis (si `REDIS_URL`) ou mémoire. Plus de routes `/analyze/*`. |
| `src/routes/gmail.js` | Routes OAuth + téléchargement + réponse Gmail | Rate limit : OAuth 5 req/min, download 3/min, count 30/min. `GET /gmail/emails`, `GET /gmail/count`, `POST /gmail/download-chunks`, `POST /gmail/reply` |
| `src/routes/outlook.js` | Routes OAuth + téléchargement + réponse Outlook | Mêmes limiteurs. `GET /outlook/emails`, `GET /outlook/email/:id`, `GET /outlook/count`, `POST /outlook/download-chunks`, `POST /outlook/reply` |
| `src/services/gmailService.js` | Logique OAuth Gmail + API Gmail | SSE, chunking 500, `buildGmailQuery`, `getEmailCount`, `sendReply` — scope OAuth `gmail.send` requis |
| `src/services/outlookService.js` | Logique OAuth Outlook + Microsoft Graph | Refresh token automatique (`getValidAccessToken`). `formatOutlookEmail`, `downloadEmailsInChunks`, `getEmailCount`, `sendReply`. Voir `OUTLOOK_IMPLEMENTATION.md`. |

### Frontend (`src/public/js/`)

| Fichier | Rôle | Dépendances entrantes | Dépendances sortantes |
|---|---|---|---|
| `app.js` | **Point d'entrée unique**, orchestrateur | `index.html` (type=module) | Tous les autres modules |
| `auth.js` | Boutons OAuth, intercepteur fetch (401) | `app.js` | — |
| `folders.js` | FileSystem Handle API, `currentFolderHandle` | `app.js`, `analysis.js`, `emails.js` | `storage.js`, `ui.js` |
| `storage.js` | Persistance IndexedDB du handle | `folders.js` | — |
| `emails.js` | Téléchargement SSE, sync incrémentale, polling | `app.js` | `folders.js`, `ui.js`, `filterUI.js`, `emailFilters.js` |
| `analysis.js` | Orchestration analyse + affichage sujets, groupes, favoris | `app.js` | `folders.js`, `ui.js`, `emailAnalyzer_browser.js`, `treeVisualization.js`, `groups.js` |
| `groups.js` | CRUD groupes de sujets, favoris (sujets + groupes), couleurs — lecture/écriture `{provider}_groups.json` | `analysis.js`, `groupContextMenu.js` | `folders.js` (via `getUserFolderHandle`) |
| `groupContextMenu.js` | Menu contextuel clic droit sur sujets et groupes (créer/renommer/supprimer groupe, couleur, membership) | `app.js` (`initGroupContextMenu`) | `groups.js`, `analysis.js` (`saveGroupsData`, `refreshSubjectsDisplay`) |
| `email-detail.js` | Modal détail d'un email + boutons Répondre/Répondre à tous | chargé par `app.js` | `window.getEmailById` (exposé par `app.js`), `reply.js` |
| `reply.js` | Formulaire de réponse Gmail — pré-remplissage destinataires, envoi `POST /gmail/reply`, feedback | `email-detail.js` | — |
| `filterUI.js` | UI des filtres (checkboxes, keywords) | `app.js`, `emails.js` | — |
| `emailFilters.js` | Logique de filtrage (shouldExcludeEmail) | `emails.js` | — |
| `panels.js` | Resizer des 3 panneaux | `app.js` | — |
| `ui.js` | Overlays, animations, barre de progression | plusieurs modules | — |

### Services frontend (`src/services/`)

| Fichier | Rôle | Notes |
|---|---|---|
| `emailAnalyzer_browser.js` | **Analyseur client** — lecture JSONL, nettoyage emails, extraction sujets, construction arbre | Export ES6 `export default`. **NE PAS confondre avec `emailAnalyzer.js` (serveur)** |
| `treeVisualization.js` | Rendu D3.js, auto-fit, zoom, timelines | Export ES6 `export default { createCompleteVisualization }`. Expose aussi des fonctions `window.*` |
| `tree-visualization.css` | Styles SVG / D3 | Chargé directement depuis `index.html` |
| `styles/components/groups.css` | Styles groupes, étoile favoris, filtre favoris, menu contextuel, icône SVG colorée | Lié depuis `index.html`. **Ne pas ajouter de styles de bouton génériques ici** — voir §8.10 |
| `styles/components/buttons.css` | Styles boutons — **opt-in** : style primaire (bleu) via `.btn-primary` uniquement | Nouveau bouton bleu → ajouter la classe `btn-primary`. Voir §12 règle 10. |

---

## 4. Flux de données principal

### Séquence de démarrage (connexion Gmail)

```
1. URL → ?provider=gmail&email=user@gmail.com
2. app.js → initConnectedInterface(provider, email)
3.   → fetchEmails()              // GET /gmail/emails → 20 emails display + liste IDs
4.   → initFolderHandlers()       // Bouton "Choisir dossier"
5.   → initDownloadHandler()      // Bouton "Télécharger" + "Mettre à jour"
6.   → initFilterUI()             // Chargement des filtres
7.   → restoreFolder(userId)      // Restauration handle depuis IndexedDB
8.   → startEmailPolling()        // Check toutes les 5 min (badge)
9.   → autoAnalyzeConversations() // Lecture JSONL local → affichage sujets
```

### Téléchargement complet

```
Clic "Télécharger"
→ downloadEmails(messageIds, provider, userId, { appendMode: false })
→ POST /gmail/download-chunks (SSE)
→ Écriture streaming : .temp → copie vers gmail_emails.jsonl
→ writeSyncMetadata() → gmail_sync_metadata.json
```

### Sync incrémentale

```
Clic "Mettre à jour"
→ syncEmails(provider, userId)
→ Lit gmail_sync_metadata.json
→ GET /gmail/emails?afterDate={lastInternalDate}
→ Déduplication IDs
→ downloadEmails(newIds, ..., { appendMode: true, silent: true })
   → createWritable({ keepExistingData: true }) + seek(file.size)
→ writeSyncMetadata() mise à jour
→ autoAnalyzeConversations() relancé
```

### Sélection d'un sujet → arbre

```
Clic sujet dans le panneau gauche
→ window.selectSubject(subject)        // exposé par app.js
→ analysisSelectSubject(...)           // dans analysis.js
→ getEmailFileHandle()                 // via folders.js → currentFolderHandle
→ emailAnalyzer.getEmailsForSubjectOptimized(fileHandle, subjectInfo)
→ emailAnalyzer.cleanEmail() × N
→ emailAnalyzer.createTemporalGroupTree(emailsClean, subject)
→ treeVisualization.createCompleteVisualization(tree)
   → HTML injecté dans #treeContainer
   → tryRender() après 200ms → renderTree() → D3.js
```

---

## 5. Système de stockage local (FileSystem + IndexedDB)

### Structure des fichiers sur disque

```
[DossierChoisi]/
  EmailWorkflow/
    {userId}/                          ← userId = adresse email de l'utilisateur
      gmail_emails.jsonl               ← 1 JSON par ligne (format ci-dessous)
      gmail_sync_metadata.json         ← date de sync, filtres utilisés, total
      gmail_groups.json                ← groupes de sujets + favoris (voir §13)
      outlook_emails.jsonl             ← futur
      outlook_sync_metadata.json       ← futur
      outlook_groups.json              ← futur
```

### Format d'un email dans le JSONL

```json
{
  "id": "...",
  "threadId": "...",
  "labelIds": [...],
  "snippet": "...",
  "subject": "...",
  "from": "Nom <email@domain.com>",
  "to": "...",
  "cc": "...",
  "date": "...",
  "messageId": "...",
  "inReplyTo": "...",
  "references": "...",
  "internalDate": "1740218400000",    ← timestamp ms (string) — RÉFÉRENCE de sync
  "bodyText": "...",
  "bodyHtml": "...",
  "originalPayload": { ... }
}
```

**Point critique** : `internalDate` est un **timestamp en millisecondes** sous forme de **string**. Toujours utiliser `parseInt()` avant comparaison. Ne pas confondre avec un timestamp en secondes.

### IndexedDB

- **Nom DB** : `EmailWorkflowDB`
- **ObjectStore** : `folderHandles`
- **Clé** : `userId` (adresse email)
- **Valeur** : `FileSystemDirectoryHandle`

**Règle impérative** : utiliser uniquement les callbacks `onsuccess` / `onerror`. Tout traitement synchrone sur un `IDBRequest` échoue silencieusement.

### Variable `currentFolderHandle`

C'est **la variable la plus centrale du projet**. Elle est déclarée et détenue par `folders.js` (module-level `let`). Tous les accès au fichier JSONL passent par elle.

- Exposée via `getCurrentFolderHandle()` et `setCurrentFolderHandle()`
- Peuplée soit par `restoreFolder()` au chargement, soit par `initFolderHandlers()` (clic utilisateur)
- Si `null` → aucun accès possible aux fichiers → `getEmailFileHandle()` retourne `null` → les fonctions d'analyse retournent sans rien faire

---

## 6. Pipeline d'analyse et de visualisation

### `emailAnalyzer_browser.js` (service client)

Fichier : `src/services/emailAnalyzer_browser.js`
Export : `export default { loadEmailsFromHandle, cleanEmail, getSubjectsWithMinEmails, getEmailsForSubjectOptimized, createTemporalGroupTree }`

**Fonctions clés** :

| Fonction | Entrée | Sortie | Notes |
|---|---|---|---|
| `loadEmailsFromHandle(fileHandle, chunkSize)` | FileHandle, taille chunk (défaut 500) | `Array<email>` avec `_chunkIndex` | Lecture streaming par chunks, parse JSONL ligne par ligne |
| `cleanEmail(email)` | email brut | email normalisé | Extrait subject, from, date, bodyText de manière unifiée |
| `getSubjectsWithMinEmails(emails, minCount)` | emails nettoyés, seuil (3) | `Array<subjectInfo>` | Regroupe par sujet normalisé, garde seulement ceux avec ≥ minCount emails |
| `getEmailsForSubjectOptimized(fileHandle, subjectInfo)` | FileHandle, subjectInfo | `Array<email>` | Lit tout le fichier + filtre en mémoire (pas de multi-stream) |
| `createTemporalGroupTree(emails, subject)` | emails nettoyés, sujet string | `{ nodes, links, subject, metadata }` | Ordre chronologique + regroupement par participants |

**Structure d'un node** dans l'arbre :
```js
{
  index,            // position chronologique (0 = premier mail)
  participantsGroup, // Set d'adresses (from + to + cc)
  messageId,
  from, to, date,
  bodyText,
  children,
  // yLevel ajouté par calculateYLevels() dans treeVisualization.js
}
```

### `analysis.js` — orchestrateur côté UI

- Tient en mémoire `currentSubjects` (liste des sujets analysés) et `currentEmailsMap` (Map id → email pour `email-detail.js`)
- Affiche **max 10 sujets** dans la liste
- Expose `getEmailById()` qui est consommé via `window.getEmailById` (exposé dans `app.js`)
- `toggleSubjectDrawer()` appelle `window.selectSubject()` (défini dans `app.js`, qui appelle `analysisSelectSubject()` dans `analysis.js`)

---

## 7. Module de visualisation D3.js — points critiques

Fichier : `src/services/treeVisualization.js`

### Deux espaces de coordonnées — ne jamais les mélanger

| Espace | Où | Calcul |
|---|---|---|
| **"Monde"** (grille fixe) | Dans `dataGroup` (groupe SVG) | `x = index * 420`, `y = yLevel * 110` — ne dépend pas de l'écran |
| **"Écran"** (coordonnées SVG) | Sur le SVG lui-même | Dérivé de la transform `translate(centerX, centerY) scale(k)` appliquée au `dataGroup` |

Les **nodes et liens** sont dans l'espace monde (dans `dataGroup`).
Les **timelines** (lignes verticales de date) sont dans l'espace écran (dans `linesGroup`, groupe séparé sans transform). Elles doivent être recalculées à chaque zoom/pan ET à l'auto-fit.

### Séquence de rendu et timing (fragile)

```
createCompleteVisualization(tree)
  → génère HTML avec div#tree-container-{id}
  → HTML injecté dans #treeContainer par analysis.js
  → setTimeout(200ms) + requestAnimationFrame loop : attend que clientWidth > 0
  → renderD3Tree(containerId)
    → renderTree(treeData, containerId)
      → setupSVGStructure()    // lit clientWidth/Height → taille du SVG
      → calculateNodePositions()
      → createNodes(), createLinks(), createTimeline()
      → setupZoomBehavior()
      → initializeAutoFit()   // rAF → rAF → setTimeout(100ms) → autoFitTree()
        → getBBox() du dataGroup
        → calculateAutoFitTransform()  // scale + translate pour centrer
        → updateTimelineElementsForAutoFit()
```

**Si le layout flex n'a pas encore donné de taille au container** au moment de la lecture, le SVG est créé en 100×100 (valeur de secours), puis `autoFitTree()` le redimensionne correctement une fois les vraies dimensions disponibles.

### Règle de cohérence auto-fit / zoom (critique)

Il existe **deux paires de fonctions** qui calculent les positions des timelines :
- `calculateAutoFitTimelineX` / `calculateAutoFitLabelX` — appelées au rendu initial
- `calculateTimelineX` / `calculateLabelX` — appelées lors du zoom/pan

Ces deux paires **doivent produire exactement le même résultat** pour un même `transform`. Une divergence provoque un saut visuel au premier rendu (avant toute interaction). Ce bug a déjà été corrigé une fois — **ne pas réintroduire de différence entre elles**.

Formule commune pour les lignes :
```
nodeVisualX = node.x * transform.k + transform.x
x_ligne = nodeVisualX + (TIMELINE_LINE_OFFSET * transform.k)
```

Formule commune pour les labels :
```
nodeRealX  = node.x + CONTAINER_MARGIN.left   // +100
nodeVisualX = nodeRealX * transform.k + transform.x
x_label = nodeVisualX + (TIMELINE_LABEL_OFFSET * transform.k)
```

### Constantes de dimensionnement

```js
NODE_WIDTH = 320          // largeur d'un node
NODE_HEIGHT = 85          // hauteur d'un node
NODE_SPACING_X = 420      // espacement horizontal (axe temps)
NODE_SPACING_Y = 110      // espacement vertical (axe groupes)
CONTAINER_MARGIN = { top: 40, right: 100, bottom: 40, left: 100 }
DATA_GROUP_OFFSET = 140   // offset X initial du dataGroup
DEFAULT_SCALE_FACTOR = 1  // multiplicateur de l'échelle auto-fit (1 = fit exact)
CONTAINER_PADDING = 30    // marge de sécurité dans le calcul d'échelle
TIMELINE_LINE_OFFSET = -15
TIMELINE_LABEL_OFFSET = -80
```

### Identifiant SVG

Chaque arbre a un ID SVG dérivé du containerId : `tree-svg-{containerId sanitized}`. Les fonctions globales `window.autoFitTree`, `window.toggleTimelinesD3`, `window.renderD3Tree` s'appuient sur `currentTreeContainerId` (variable module-level dans `treeVisualization.js`) pour cibler le bon SVG.

---

## 8. Couplages implicites et pièges à éviter

### 8.1 — La fonction `window.selectSubject` (couplage app.js ↔ analysis.js)

`analysis.js` appelle `window.selectSubject(subject)` (ligne 290 de `analysis.js`). Cette fonction est définie dans `app.js`. C'est un **couplage via l'objet global `window`**, intentionnel pour casser la circularité d'imports. **Ne pas déplacer cette définition** sans mettre à jour analysis.js.

### 8.2 — `window.getEmailById` (couplage app.js ↔ email-detail.js)

`email-detail.js` appelle `window.getEmailById(id)`. Cette fonction est exposée dans `app.js` depuis `analysis.js`. Si on refactorise `analysis.js`, s'assurer que `getEmailById` reste accessible globalement.

### 8.3 — `window.positionedNodes` (couplage treeVisualization.js interne)

Dans `treeVisualization.js`, `renderTree()` stocke les nodes positionnés dans `window.positionedNodes`. Les fonctions `calculateAutoFitTimelineX` et `calculateAutoFitLabelX` accèdent à `window.positionedNodes` directement. Si on rend plusieurs arbres, cette variable globale est **écrasée** à chaque appel de `renderTree()`.

### 8.4 — `currentTreeContainerId` (variable de module dans treeVisualization.js)

Variable module-level qui pointe vers le dernier containerId rendu. Les boutons "auto-fit", "toggle timelines" utilisent ce curseur pour savoir quel SVG cibler. Ne s'applique qu'à **un seul arbre actif à la fois**.

### 8.5 — `analysisLaunched` dans app.js

Flag booléen qui empêche `autoAnalyzeConversations()` d'être lancé deux fois. Il est remis à `false` après chaque sync réussie (dans le handler du bouton "Mettre à jour"). Si on ajoute un nouveau déclencheur d'analyse, penser à gérer ce flag.

### 8.6 — Le `userId` est l'adresse email

`userId` dans tout le code = adresse email de l'utilisateur (ex. `user@gmail.com`). C'est la clé IndexedDB, le nom de dossier sur disque, et le paramètre URL `?email=`. Toute logique basée sur des IDs numériques serait incompatible.

### 8.7 — La clé de session Express pour les tokens

Les tokens OAuth sont stockés dans **`req.session.tokens`** (ni `gmailTokens`, ni `outlookTokens`). Ce bug a été corrigé dans `outlookService.js` — toutes les fonctions lisent `req.session?.tokens?.access_token`. Ne pas créer de nouvelle clé de session.

### 8.8 — Analyseur email (client uniquement)

L'analyse des emails est faite **uniquement côté client** par `src/services/emailAnalyzer_browser.js` (ES6 `export default`). Il n'existe plus d'analyseur serveur ; les routes `/analyze/*` et les fichiers `emailAnalyzer.js` / `folderManagerService.js` ont été supprimés (Phase 2).

### 8.9 — Imports ES6 côté client : toujours des chemins absolus

Le serveur expose `/services/...` via `express.static`. Les imports dans les modules frontend doivent utiliser des chemins absolus :
```js
import emailAnalyzer from "/services/emailAnalyzer_browser.js";  // ✅
import emailAnalyzer from "../services/emailAnalyzer_browser.js"; // ❌ (404)
```

### 8.10 — `saveGroupsData` / `refreshSubjectsDisplay` (couplage analysis.js ↔ groupContextMenu.js)

`groupContextMenu.js` importe `saveGroupsData` et `refreshSubjectsDisplay` depuis `analysis.js`. Ces deux fonctions sont le point de synchronisation entre une action du menu contextuel et l'affichage de la liste. Ne pas les supprimer ni les renommer sans mettre à jour `groupContextMenu.js`.

### 8.11 — `window.toggleFavoritesFilter` (couplage app.js ↔ index.html)

Le bouton `#favoritesFilterBtn` dans `index.html` appelle `window.toggleFavoritesFilter` via un `onclick` inline. Cette fonction est exportée depuis `analysis.js` et exposée dans `app.js`. Si on refactorise `app.js`, s'assurer que ce `window.*` reste défini.

### 8.12 — `buttons.css` : style primaire en opt-in

Le style bleu primaire s'applique **uniquement** aux boutons avec la classe `.btn-primary`. Tout nouveau bouton qui doit avoir ce style doit explicitement ajouter `btn-primary`. Les boutons avec des classes dédiées (`.btn-folder-select`, `.filter-button`, `.user-dropdown-disconnect`, etc.) gardent leur propre style.

---

## 9. Variables globales et état partagé

| Variable | Définie dans | Accessible via | Description |
|---|---|---|---|
| `currentFolderHandle` | `folders.js` (module) | `getCurrentFolderHandle()` | Handle FileSystem actif — **la plus critique** |
| `currentSubjects` | `analysis.js` (module) | `getCurrentSubjects()` | Sujets analysés, utilisés pour le filtrage recherche |
| `currentEmailsMap` | `analysis.js` (module) | `getEmailById()` → `window.getEmailById` | Map id → email pour la modal de détail |
| `currentGroupsData` | `analysis.js` (module) | `getCurrentGroupsData()` | Données groupes/favoris chargées depuis `{provider}_groups.json` — `null` si pas de dossier |
| `currentFavoritesOnly` | `analysis.js` (module) | `toggleFavoritesFilter()` → `window.toggleFavoritesFilter` | Flag booléen — filtre la liste de sujets sur les favoris uniquement |
| `groupsProvider` | `analysis.js` (module) | interne | Provider actif pour la gestion des groupes (`'gmail'` etc.) |
| `groupsUserId` | `analysis.js` (module) | interne | userId actif pour la gestion des groupes — **doit être passé explicitement**, ne pas lire `currentEmail` global |
| `currentTreeContainerId` | `treeVisualization.js` (module) | `window.getCurrentTreeContainerId()` | ID du container SVG actif |
| `window.positionedNodes` | `treeVisualization.js` → `renderTree()` | directement | Nodes avec positions x,y — écrasé à chaque rendu |
| `window.defaultTransform` | `treeVisualization.js` → `autoFitTree()` | directement | Transform de référence pour le zoom |
| `lastFetchedEmails` | `app.js` (module) | local | 20 emails pour affichage (pas pour analyse) |
| `availableMessageIds` | `app.js` (module) | local | IDs disponibles pour téléchargement |
| `analysisLaunched` | `app.js` (module) | local | Garde contre double lancement de l'analyse |
| `zoom` (D3) | `treeVisualization.js` (module) | interne | Instance D3 zoom — une seule instance |
| `isInitialAutoFit` | `treeVisualization.js` (module) | interne | Empêche le zoom de surcharger l'auto-fit initial |

---

## 10. État du projet et ce qui est fragile

### Fonctionnel et stable

- Authentification Gmail et Outlook OAuth2 (les deux providers)
- Téléchargement SSE par chunks de 500 emails
- Écriture streaming JSONL (mode overwrite)
- Sync incrémentale Gmail (append + metadata)
- Bootstrap automatique de metadata depuis JSONL existant
- Polling badge "nouveaux emails" toutes les 5 min
- Analyse des sujets (≥ 3 emails) par lecture chunked
- Sélection de sujet → lecture + filtrage en mémoire
- Génération d'arbre temporel par groupes de participants
- Visualisation D3.js avec zoom, pan, timelines, auto-fit
- Interface 3 panneaux redimensionnables
- Modal détail email (avec affichage CC)
- **Réponse aux emails Gmail** depuis la modal (Répondre / Répondre à tous) — voir §14
- Optimisations mémoire : lecture streaming dans `analyzeEmailFile` et `loadEmailsFromHandle`, libération anticipée des tableaux dans le pipeline d'analyse
- **Outlook complet** : téléchargement SSE par chunks, sync incrémentale, polling badge, détail email, réponse via Microsoft Graph
- Format JSONL unifié Gmail/Outlook : `formatOutlookEmail()` produit exactement le même format que `formatGmailEmail()`

### Fragile — toucher avec précaution

**1. Les streams FileSystem**
Ne jamais ouvrir deux streams simultanés sur le même fichier JSONL. En mode append, le `writable` avec `keepExistingData: true` + `seek(file.size)` est le seul pattern valide. Tout autre pattern peut corrompre le fichier.

**2. La chaîne de dimensionnement D3**
La séquence `tryRender()` → `renderTree()` → `initializeAutoFit()` → `autoFitTree()` repose sur des timings (200ms, double rAF, 100ms setTimeout). Si un ancêtre de `#tree-container-xxx` n'a pas de hauteur définie en CSS, `clientHeight = 0` et l'arbre reste invisible ou 100×100.

**3. La cohérence auto-fit / zoom des timelines**
Les deux paires de fonctions de calcul de position doivent rester strictement identiques (voir §7). Ne pas en modifier une sans l'autre.

**4. Le flag `analysisLaunched`**
Sans ce flag, `autoAnalyzeConversations()` peut être lancé plusieurs fois simultanément (au chargement + callback dossier + fin de sync). Cela génère plusieurs streams de lecture simultanés sur le fichier, ce qui peut provoquer des comportements indéterminés.

**5. La gestion des filtres dans la sync**
Si les filtres changent entre deux syncs, `syncEmails()` force un **re-téléchargement complet** (mode overwrite). C'est intentionnel pour garantir la cohérence du JSONL. Ne pas contourner cette logique.

**6. Le scope OAuth `gmail.send`**
La fonctionnalité de réponse requiert le scope `https://www.googleapis.com/auth/gmail.send` en plus de `gmail.readonly`. Si ce scope est ajouté/modifié dans `gmailService.js`, les utilisateurs existants **doivent se déconnecter et se reconnecter** pour obtenir les nouveaux tokens. Sans ça, l'API Gmail retourne 403 à l'envoi.

---

## 11. Ce qui n'est pas implémenté

| Fonctionnalité | État | Impact si on l'ajoute |
|---|---|---|
| Téléchargement Outlook par SSE | ✅ Implémenté | `downloadEmailsInChunks` dans `outlookService.js` + route `POST /outlook/download-chunks` |
| Sync incrémentale Outlook | ✅ Implémentée | `syncEmails("outlook", userId)` fonctionne — URLs dynamiques via `/${provider}/...` |
| Route `/outlook/count` pour polling | ✅ Implémenté | `checkForNewEmails()` appelle `/${provider}/count` ; polling actif pour Gmail et Outlook. |
| Bug détail email Outlook | ✅ Corrigé | `req.session?.tokens?.access_token` — route `GET /outlook/email/:messageId` opérationnelle |
| Refresh token Outlook | ✅ Implémenté | `getValidAccessToken` / `refreshOutlookAccessToken` dans `outlookService.js` — plus de déconnexion après 1h. |
| Indexation par position octet | Non implémenté | Actuellement, `getEmailsForSubjectOptimized` lit tout le fichier à chaque sélection de sujet. Une indexation byte-offset éviterait ça. |
| Cache des sujets analysés | Non implémenté | `autoAnalyzeConversations` relit tout le fichier à chaque appel |
| Nettoyage routes legacy | ✅ Fait (Phase 2) | Routes `/analyze/*` et fichiers `emailAnalyzer.js`, `folderManagerService.js` supprimés. |

---

## 12. Règles et conventions à respecter

1. **Un seul stream FileSystem ouvert à la fois** sur un fichier donné — aucune exception.

2. **`internalDate`** est un timestamp millisecondes sous forme de string Gmail. Toujours `parseInt()` avant opération arithmétique. Jamais confondre avec des secondes.

3. **La clé de session Express** pour tous les tokens OAuth est `req.session.tokens`. Ne pas créer de `req.session.gmailTokens` ou `req.session.outlookTokens`. La fonction `sendReply` utilise la même clé.

4. **IndexedDB** : toujours utiliser `onsuccess` / `onerror`, jamais de traitement synchrone sur un `IDBRequest`.

5. **Imports ES6 côté client** : chemins absolus uniquement (`/services/...`, `/js/...`), jamais relatifs.

6. **`emailAnalyzer_browser.js`** : seul analyseur d'emails (côté client, ES6). Plus d'analyseur serveur.

7. **`window.selectSubject`** est le point d'entrée pour charger un arbre depuis l'UI. Ne pas l'appeler directement depuis `treeVisualization.js` (pas d'import circulaire).

8. **`userId`** = adresse email. C'est la clé de tout : IndexedDB, structure de dossier, URL. Ne jamais introduire un autre système d'identifiant sans migrer les trois.

9. **Modifier `treeVisualization.js`** : toute modification des positions des timelines doit être appliquée **en parallèle** dans les deux paires de fonctions (auto-fit et zoom).

10. **Hauteur CSS du panneau central** : si on change la structure HTML/CSS des panneaux, s'assurer que `#treeContainer` et ses ancêtres ont une hauteur explicite (flex ou fixe), sinon l'arbre D3 ne s'affiche pas.

11. **Bouton style primaire (bleu)** : ajouter la classe `btn-primary`. `buttons.css` est en opt-in (plus de sélecteur large `:not(...)`).

12. **`groupsProvider` / `groupsUserId` dans `analysis.js`** : ces deux variables doivent être alimentées par les paramètres **explicitement passés** à `autoAnalyzeConversations(provider, userId)`. Ne jamais lire une variable globale `currentProvider` ou `currentEmail` — elles n'existent pas dans ce scope. Le bug a déjà été rencontré une fois.

13. **Production** : `SESSION_SECRET` obligatoire si `NODE_ENV=production`. Sessions : Redis recommandé (`REDIS_URL`). Voir `docs/ENV_AUDIT.md`.

---

## 13. Feature : Groupes de sujets et Favoris

### Structure de données — `{provider}_groups.json`

Fichier stocké dans `EmailWorkflow/{userId}/gmail_groups.json`, géré par `groups.js`.

```json
{
  "version": 1,
  "groups": [
    { "id": "grp_xxx", "name": "Mon groupe", "parentId": null, "order": 0, "color": "#ef4444" }
  ],
  "subjectMemberships": [
    { "subjectKey": "sujet normalisé", "groupId": "grp_xxx" }
  ],
  "favoriteSubjects": ["sujet normalisé 1", "sujet normalisé 2"],
  "favoriteGroups": ["grp_xxx"]
}
```

**Points importants** :
- Un sujet peut appartenir à **plusieurs groupes** (`subjectMemberships` peut avoir plusieurs entrées avec le même `subjectKey`)
- `parentId: null` = groupe racine ; `parentId: "grp_xxx"` = sous-groupe (max 2 niveaux d'UI)
- `color` est `null` par défaut — si non null, l'icône dossier SVG prend cette couleur
- `subjectKey` = sujet normalisé (lowercase, sans "Re:"/"Fwd:") — cohérent avec `emailAnalyzer_browser.js`

### `groups.js` — fonctions exportées

| Fonction | Description |
|---|---|
| `readGroups(folderHandle, provider)` | Lit `{provider}_groups.json` ou retourne structure vide |
| `writeGroups(folderHandle, provider, data)` | Écrit le JSON sur disque |
| `getUserFolderHandle(userId)` | Retourne le handle du dossier `{userId}/` via `currentFolderHandle` |
| `createGroup(data, name, parentId)` | Crée un groupe avec ID unique `grp_{timestamp}` |
| `renameGroup(data, groupId, newName)` | Renomme un groupe existant |
| `deleteGroup(data, groupId)` | Supprime groupe + tous ses enfants + toutes les memberships associées |
| `addSubjectToGroup(data, subjectKey, groupId)` | Ajoute une membership (déduplique) |
| `removeSubjectFromGroup(data, subjectKey, groupId)` | Retire une membership spécifique |
| `getChildGroups(data, parentId)` | Retourne les groupes enfants d'un parent |
| `getSubjectsInGroup(data, groupId)` | Retourne les `subjectKey` membres d'un groupe |
| `isSubjectGrouped(data, subjectKey)` | `true` si le sujet est dans au moins un groupe |
| `toggleFavoriteSubject(data, subjectKey)` | Bascule l'état favori d'un sujet |
| `toggleFavoriteGroup(data, groupId)` | Bascule l'état favori d'un groupe |
| `isSubjectFavorite(data, subjectKey)` | `true` si le sujet est favori |
| `isGroupFavorite(data, groupId)` | `true` si le groupe est favori |
| `setGroupColor(data, groupId, color)` | Définit la couleur d'un groupe (`null` = reset) |

### `analysis.js` — rendu des groupes

Quatre fonctions de rendu principales :

| Fonction | Quand utilisée |
|---|---|
| `renderGroupedSubjectsList(container, subjects, groups, ...)` | Mode normal avec groupes actifs |
| `renderFlatSubjectsList(container, subjects, ...)` | Mode normal sans groupes |
| `renderSearchGroupedSubjectsList(container, subjects, allSubjects, groups, ...)` | Recherche active avec groupes |
| `renderGroupItemHtml(group, ...)` | HTML d'un groupe (récursif pour les sous-groupes) |

**Comportement recherche + groupes** :
- Si le nom du groupe correspond au terme → groupe affiché avec **tous ses sujets**
- Si un sujet du groupe correspond → groupe affiché avec **seulement les sujets correspondants**
- Les groupes correspondants sont **auto-ouverts**

**Groupes vides** :
- En mode normal : affichés avec le placeholder `"Aucun sujet — clic droit sur un sujet pour l'ajouter"`
- En mode favoris uniquement (`currentFavoritesOnly = true`) : groupes vides **masqués**

### Icône dossier SVG colorable

L'icône des groupes est un SVG inline avec `fill="currentColor"`. La couleur est appliquée via `style="color: {group.color || '#94a3b8'}"` sur le `<span>` parent. Cela permet de changer la couleur sans remplacer l'icône.

```html
<span class="group-folder-icon" style="color: #ef4444">
  <svg width="15" height="13" viewBox="0 0 20 16" fill="currentColor">
    <path d="M0 2C0 .9.9 0 2 0h5l2 2h9c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2H2c-1.1 0-2-.9-2-2V2z"/>
  </svg>
</span>
```

**Ne pas revenir à un emoji 📁** — les emojis ne sont pas colorables via CSS `color`.

### Étoile favoris (`.star-btn`)

- `opacity: 0` par défaut, visible au survol du parent (`.subject-drawer:hover` ou `.group-header:hover`)
- Caractère `☆` (outline) quand non favori, `★` (rempli) quand favori
- Classe `.is-favorite` ajoutée sur le bouton quand actif → couleur jaune `#f59e0b`
- **Bouton exclu du style bleu de `buttons.css`** via `:not(.star-btn)` dans les sélecteurs

### Filtre favoris

- Bouton `#favoritesFilterBtn` à côté de la barre de recherche
- Appelle `window.toggleFavoritesFilter()` → bascule `currentFavoritesOnly`
- Quand actif : seuls les sujets favoris + groupes favoris (avec leurs sujets) s'affichent

---

## 14. Feature : Réponse aux emails Gmail

### Fichiers impliqués

| Fichier | Rôle |
|---|---|
| `src/routes/gmail.js` | Route `POST /gmail/reply` |
| `src/services/gmailService.js` | `sendReply(req, res)` — formatage MIME + appel API Gmail |
| `src/public/js/reply.js` | Module frontend — formulaire, pré-remplissage, envoi, feedback |
| `src/public/js/email-detail.js` | Boutons "Répondre" / "Répondre à tous" + variable `currentEmailData` |

### Flux de réponse

```
Clic "Répondre" (ou "Répondre à tous") dans la modal
→ email-detail.js : lit currentEmailData (email affiché)
→ reply.js : showReplyForm(emailData, replyType)
   → calcule To / CC selon replyType
   → crée/met à jour le formulaire dans la modal
   → Clic "Envoyer"
→ reply.js : doSendReply(emailData, section)
   → POST /gmail/reply { to, cc, subject, body, threadId, messageId, references }
→ gmailService.js : sendReply()
   → construit RFC 2822 (headers + body texte)
   → encode en base64url
   → gmail.users.messages.send({ raw, threadId })
→ feedback dans la modal (succès vert / erreur rouge)
```

### Logique des destinataires

- **Répondre** : `To` = `from` de l'email original (ou `to` original si c'est un email envoyé par l'utilisateur)
- **Répondre à tous** : `To` = `from` de l'email original ; `Cc` = tous les `to` + `cc` de l'email original, **moins l'adresse de l'utilisateur courant** (`userId` lu depuis l'URL `?email=`)

### Points critiques

- **Scope OAuth** : `gmail.send` doit être accordé. Ajouté dans `initAuth` de `gmailService.js`. Tout changement de scope oblige les utilisateurs à se reconnecter.
- **Headers MIME** : `In-Reply-To: <messageId>` et `References: <references> <messageId>` sont obligatoires pour que Gmail rattache la réponse au bon thread.
- **Sujet** : préfixé `Re:` uniquement si absent (regex `/^re\s*:/i`).
- **Boutons CSS** : classes `btn-reply-action`, `btn-reply-send`, `btn-reply-cancel` — toutes contiennent `btn-` et sont donc **exclues** du sélecteur large de `buttons.css`.
- **`currentEmailData`** : variable module-level dans `email-detail.js`. Elle est mise à jour à chaque ouverture de la modal (`populateEmailDetail`). Le formulaire de réponse précédent est masqué à chaque ouverture.
- **Gmail uniquement** : Outlook non implémenté. La route `/gmail/reply` est protégée par `requireAuth`. Ne pas appeler cette route depuis un contexte Outlook.

### Optimisations mémoire (Mars 2026)

Trois fonctions ont été modifiées pour éliminer les crashs "Out of Memory" sur les grandes collections d'emails :

**`analyzeEmailFile` (`folders.js`)** — ancienne implémentation :
- `file.text()` chargeait tout le JSONL en une seule string (~80 Mo)
- `.split('\n')` créait un tableau de toutes les lignes (~80 Mo)
- `emails.push(email)` accumulait tous les emails complets avec `bodyHtml` et `originalPayload` (~400 Mo)
- **Total : ~560 Mo juste pour récupérer des IDs**

Nouvelle implémentation : lecture streaming par chunks, extraction de l'`id` uniquement, objet complet éligible au GC immédiatement. **Consommation : ~1-2 Mo** (un `Set` de strings).

**`loadEmailsFromHandle` (`emailAnalyzer_browser.js`)** — ancienne implémentation :
- `JSON.parse(line)` créait l'objet complet (~80 Ko) puis `delete` retirait des champs sans libérer la mémoire allouée immédiatement.

Nouvelle implémentation : création d'un objet allégé directement (`id`, `threadId`, `subject`, `from`, `to`, `cc`, `date`, `messageId`, `inReplyTo`, `references`, `internalDate`, `bodyText`, `snippet`, `labelIds`). L'objet complet `full` sort de portée à la fin du bloc et est libéré par le GC dès le prochain cycle.

**Pipeline d'analyse des sujets (`analysis.js`)** — après `loadEmailsFromHandle` :
- `emails.length = 0` : libère le tableau brut immédiatement après la création de `emailsClean`
- `emailsClean.forEach(e => { e.bodyText = ''; })` : `getSubjectsWithMinEmails` n'utilise pas `bodyText` (uniquement `subject`, `from`, `date`, `_chunkIndex`) — il est rechargé à la demande lors de la sélection d'un sujet

**Bilan mémoire pour une collection de 5 000 emails** :

| Opération | Avant | Après |
|---|---|---|
| `analyzeEmailFile` (déduplication sync) | ~560 Mo | ~2 Mo |
| `loadEmailsFromHandle` (pic par email) | ~80 Ko/email | ~15 Ko/email |
| Deux tableaux simultanés dans l'analyse | ~2 × 75 Mo | ~37 Mo + 0 (brut libéré) |
| `bodyText` pendant extraction sujets | ~25 Mo (inutilement) | 0 |

---

*Ce document est conçu pour être lu en entier avant d'intervenir sur le projet. Les §8 (couplages), §10 (fragile), §13 (feature groupes) et §14 (feature réponse + optimisations mémoire) sont particulièrement importants avant toute modification.*
