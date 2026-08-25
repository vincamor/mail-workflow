# Implémentation Outlook — Documentation de référence

*À destination d'une IA ou d'un développeur prenant ce projet en main.*
*Dernière mise à jour : Mars 2026 — v2 (implémentation complète)*

---

## Statut global : ✅ Implémentation terminée

Toutes les fonctionnalités Outlook sont opérationnelles et testées. Outlook se comporte comme Gmail dans l'interface — même pipeline, mêmes fichiers locaux, mêmes visualisations.

| Fonctionnalité | Fichier(s) | Statut |
|---|---|---|
| OAuth + tokens session | `outlookService.js`, `routes/outlook.js` | ✅ |
| `formatOutlookEmail()` — format JSONL unifié | `outlookService.js` | ✅ |
| `GET /outlook/emails` — IDs + 20 emails display | `routes/outlook.js` + `outlookService.js` | ✅ |
| `GET /outlook/email/:id` — détail email | `routes/outlook.js` + `outlookService.js` | ✅ |
| `POST /outlook/download-chunks` — SSE chunked | `routes/outlook.js` + `outlookService.js` | ✅ |
| `GET /outlook/count` — polling badge | `routes/outlook.js` + `outlookService.js` | ✅ |
| `POST /outlook/reply` — répondre via Graph | `routes/outlook.js` + `outlookService.js` | ✅ |
| URLs dynamiques `/${provider}/...` côté client | `emails.js`, `reply.js` | ✅ |
| Analyse auto après téléchargement | `app.js` | ✅ |

---

## Architecture

### Principe fondamental

Le code client (`emails.js`, `analysis.js`, `groups.js`, `treeVisualization.js`, `reply.js`) est **entièrement générique** — il reçoit un paramètre `provider` (`"gmail"` ou `"outlook"`) et construit les URLs et noms de fichiers dynamiquement. Outlook ne nécessite **aucune logique spécifique côté client**.

Tout le travail Outlook se passe dans :
- `src/services/outlookService.js` — logique OAuth + appels Microsoft Graph
- `src/routes/outlook.js` — routes Express

### Routes Outlook

| Méthode | Route | Fonction | Description |
|---|---|---|---|
| `GET` | `/outlook` | `initAuth` | Démarre OAuth Microsoft |
| `GET` | `/outlook/callback` | `handleCallback` | Callback OAuth → stocke tokens dans `req.session.tokens` |
| `GET` | `/outlook/emails` | `getEmails` | IDs + 20 emails display. Params: `?filters=`, `?afterDate=` |
| `GET` | `/outlook/email/:messageId` | `getEmailDetail` | Détail complet d'un email (format JSONL unifié) |
| `GET` | `/outlook/count` | `getEmailCount` | Nombre de nouveaux emails (polling léger). Params: `?filters=`, `?afterDate=` |
| `POST` | `/outlook/download-chunks` | `downloadEmailsInChunks` | Téléchargement SSE par tranches de 500 |
| `POST` | `/outlook/reply` | `sendReply` | Envoie une réponse via `POST /me/messages/{id}/reply` |

---

## Fonctions clés dans `outlookService.js`

### Constante `OUTLOOK_SELECT_FIELDS`
Liste des champs demandés à Microsoft Graph dans chaque requête. Inclut `internetMessageHeaders` (obligatoire pour `inReplyTo` et `references`).

### `formatOutlookEmail(message)`
Transforme un objet Microsoft Graph en format JSONL **identique** à `formatGmailEmail()`. C'est la fonction centrale — tout le reste du pipeline client en dépend.

Mapping clé :

| Champ JSONL | Source Graph | Notes |
|---|---|---|
| `id` | `message.id` | ID interne Outlook (`AAMkADAwATM0...`) |
| `threadId` | `message.conversationId` | |
| `internalDate` | `message.sentDateTime` | `new Date(sentDateTime).getTime().toString()` — **ms en string** |
| `messageId` | `message.internetMessageId` | RFC Message-ID (`<...@...>`) |
| `inReplyTo` | `internetMessageHeaders["In-Reply-To"]` | Absent si headers non disponibles |
| `references` | `internetMessageHeaders["References"]` | Idem |
| `from` | `message.from.emailAddress` | Formaté `"Nom <email>"` |
| `to` / `cc` | `toRecipients[]` / `ccRecipients[]` | Tableau → chaîne `", "` |
| `bodyText` | `message.body.content` | HTML strippé si `contentType == "html"` |

> **Attention** : `internalDate` est un timestamp ms sous forme de **string**. Toujours `parseInt()` avant comparaison. C'est la référence de date pour la sync incrémentale.

### `buildOutlookQuery(filters, afterDate)`
Construit le filtre OData pour Microsoft Graph. Seul `afterDate` est traduit en filtre OData (`receivedDateTime gt {iso}`). Les filtres textuels (notifications, promotions) sont appliqués côté serveur via `shouldExcludeEmail()`.

### `getAllMessagesFromFolder(accessToken, folder, filterQuery)`
Pagination automatique via `@odata.nextLink`. Interroge un dossier Outlook (ex. `inbox`, `sentitems`) page par page jusqu'à épuisement. Utilise `$top=50` et ne charge que les champs définis dans `OUTLOOK_SELECT_FIELDS`.

### `getEmailCount(req, res)`
Endpoint léger pour le polling. Appels parallèles sur `inbox` et `sentitems` avec `$select=id` uniquement. Déduplication + retourne `{ newCount }`.

### `downloadEmailsInChunks(req, res)`
SSE streaming — format identique à `gmailService.downloadEmailsInChunks`. Événements : `start` → `emails` → `progress` → `complete` (ou `error`). Pour chaque ID, appelle `GET /me/messages/{id}` puis `formatOutlookEmail()`.

### `sendReply(req, res)`
Appelle `POST https://graph.microsoft.com/v1.0/me/messages/{id}/reply` avec :
- `comment` : corps texte de la réponse
- `message.toRecipients` / `message.ccRecipients` : destinataires parsés depuis les chaînes texte

Microsoft Graph retourne **202 Accepted** (sans corps) en cas de succès — différent de Gmail qui retourne `{ success: true, messageId }`.

---

## Différences importantes Outlook vs Gmail

| Point | Gmail | Outlook |
|---|---|---|
| API de messagerie | Google APIs (`googleapis`) | Microsoft Graph (`fetch` direct) |
| Authentification | OAuth2 via `google.auth.OAuth2` | OAuth2 via échange de code + `fetch` |
| Expiration tokens | Tokens longs (refresh token) | Access token expire au bout d'**1h** |
| Pagination | `nextPageToken` dans la réponse | `@odata.nextLink` dans la réponse |
| Filtres | Query string Gmail (`after:2025/01/01 -from:noreply`) | Filtre OData (`receivedDateTime gt 2025-01-01T00:00:00Z`) |
| Threading (In-Reply-To) | Toujours présent dans les headers | `internetMessageHeaders` parfois absent (voir ci-dessous) |
| Envoi de réponse | Build MIME RFC 2822 + base64url | `POST /me/messages/{id}/reply` avec JSON |
| Réponse succès envoi | `{ success: true, messageId }` | HTTP 202 Accepted (pas de corps) |
| ID interne | `email.id` = ID Gmail (`17abc...`) | `email.id` = ID Outlook (`AAMkADAwATM0...`) |
| ID RFC Message-ID | `email.messageId` = `<...@gmail.com>` | `email.messageId` = `<...@outlook.com>` (si headers dispo) |

---

## Limitations connues

### 1. `internetMessageHeaders` absent sur certains messages
**Description** : Microsoft Graph ne retourne pas toujours `internetMessageHeaders`, même avec `$select` explicite. Cela concerne les emails créés nativement dans Exchange/Outlook (notifications Teams, invitations calendrier, emails internes Exchange).

**Impact** : `inReplyTo` et `references` seront vides pour ces messages. L'arbre de conversation se construit en se basant sur le sujet et les participants, mais sans lier les fils de réponse par header MIME.

**Comportement** : un warning est loggé côté serveur — `⚠️ formatOutlookEmail: internetMessageHeaders absent pour le message {id}`. C'est attendu, pas un bug.

### 2. Session partagée Gmail / Outlook
**Description** : `req.session.tokens` est utilisé par les deux providers. Si l'utilisateur se connecte à Outlook alors qu'il était connecté à Gmail (ou vice-versa), les tokens du premier provider sont écrasés.

**Impact** : pas de double connexion simultanée possible. L'utilisateur doit choisir un provider par session.

**Règle impérative** : ne jamais créer `req.session.gmailTokens` ou `req.session.outlookTokens` — la clé unique est `req.session.tokens` pour tout.

### 3. Tokens Outlook — refresh automatique (implémenté)
**Description** : les `access_token` Outlook expirent après 3600 secondes. Un **refresh automatique** est implémenté dans `outlookService.js` : `getValidAccessToken(session)` vérifie `expires_at` (marge 1 min) et appelle `refreshOutlookAccessToken(session)` si besoin. Toutes les routes Outlook utilisent `await getValidAccessToken(req.session)` au lieu d'accéder directement à `access_token`. Plus de déconnexion forcée après 1h.

### 4. Seuil minimum 3 emails par sujet
**Description** : `getSubjectsWithMinEmails(emails, 3)` dans `analysis.js` exige au moins 3 emails avec le même sujet pour qu'il apparaisse dans la liste. Avec un compte Outlook peu actif ou des filtres agressifs, la liste peut être vide.

**Solution** : désactiver temporairement les filtres avant de télécharger, ou baisser le seuil à 2 dans `analysis.js` (ligne ~221).

---

## Règles à respecter pour toute modification future

1. **`req.session.tokens`** — clé unique pour tous les providers. Ne pas créer de variante.
2. **Format JSONL** — `formatOutlookEmail()` doit produire exactement les mêmes champs que `formatGmailEmail()`. Toute modification d'un champ doit être répercutée dans les deux fonctions.
3. **`internalDate`** — toujours un timestamp ms sous forme de **string**. Toujours `parseInt()` avant toute opération.
4. **`email.id` vs `email.messageId`** — pour Outlook, `id` est l'ID interne Graph (utilisé pour toutes les actions API), `messageId` est le RFC Message-ID (utilisé pour les headers MIME). Ne pas les confondre.
5. **Un seul stream FileSystem à la fois** — s'applique aussi pour `outlook_emails.jsonl`.
6. **`analysisLaunched`** dans `app.js` — ce flag doit être remis à `false` avant tout appel à `autoAnalyzeConversations()`, puis à `true` après. Voir le handler du bouton "Télécharger" et "Mettre à jour".

---

## Journal des modifications

| Date | Modifications |
|---|---|
| Mars 2026 | **Étapes 0, 1, 2, 3, 7** : bug fix clé session (`outlookTokens` → `tokens`). Création de `formatOutlookEmail()`, `buildOutlookQuery()`, `shouldExcludeEmail()`, `getAllMessagesFromFolder()` (pagination `@odata.nextLink`). Refacto de `getEmails` → `{ displayEmails, messageIds, totalAvailable, metadata }`. Route `GET /outlook/email/:messageId`. |
| Mars 2026 | **Étapes 4, 6** : `downloadEmailsInChunks` + route `POST /outlook/download-chunks`. Correction des URLs hardcodées dans `emails.js` (`/gmail/download-chunks` et `/gmail/emails` → `/${provider}/...`). |
| Mars 2026 | **Étape 5** : `getEmailCount` + route `GET /outlook/count`. Appels parallèles inbox + sentitems, `$select=id` uniquement. |
| Mars 2026 | **Étape 8** : `sendReply` + route `POST /outlook/reply`. `reply.js` : endpoint `/${provider}/reply` + `id: emailData.id` dans le body. Graph retourne 202 Accepted. |
| Mars 2026 | **Fix `app.js`** : `initDownloadHandler` ne relançait pas l'analyse après téléchargement. Ajout `setTimeout(2500ms)` → `autoAnalyzeConversations()`. |
