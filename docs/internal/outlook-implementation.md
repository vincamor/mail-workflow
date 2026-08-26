# Outlook implementation

**Who this is for:** contributors touching Outlook support, or wondering why
Outlook behaves subtly differently from Gmail in one specific place.

Outlook is feature-complete: it behaves like Gmail in the interface — same
pipeline, same local files, same visualisation.

| Capability                                              | File(s)                                  |
| ------------------------------------------------------- | ---------------------------------------- |
| OAuth + session tokens + automatic refresh              | `outlookService.js`, `routes/outlook.js` |
| `formatOutlookEmail()` — the unified JSONL shape        | `outlookService.js`                      |
| `GET /outlook/emails` — ids + 20 display emails         | `routes/outlook.js`, `outlookService.js` |
| `GET /outlook/email/:messageId` — single-message detail | `routes/outlook.js`, `outlookService.js` |
| `POST /outlook/download-chunks` — chunked SSE download  | `routes/outlook.js`, `outlookService.js` |
| `GET /outlook/count` — badge polling                    | `routes/outlook.js`, `outlookService.js` |
| `POST /outlook/reply` — reply through Graph             | `routes/outlook.js`, `outlookService.js` |
| Dynamic `/${provider}/…` URLs on the client             | `emails.js`, `reply.js`                  |

---

## The organising principle

The client code — `emails.js`, `analysis.js`, `groups.js`, `treeRenderer.js`,
`reply.js` — is **entirely generic**. It receives a `provider` parameter
(`"gmail"` or `"outlook"`) and derives URLs and filenames from it. Outlook needs
**no client-side logic of its own**.

Everything Outlook-specific lives in two files:

- `src/services/outlookService.js` — OAuth plus Microsoft Graph calls
- `src/routes/outlook.js` — the Express routes

That is only sustainable because `formatOutlookEmail()` produces exactly the same
record shape as `formatGmailEmail()`. Preserving that equivalence is the single
most important rule in this document.

---

## Routes

| Method | Route                       | Handler                  | Description                                                     |
| ------ | --------------------------- | ------------------------ | --------------------------------------------------------------- |
| `GET`  | `/outlook`                  | `initAuth`               | Starts Microsoft OAuth                                          |
| `GET`  | `/outlook/callback`         | `handleCallback`         | OAuth callback → stores tokens in `req.session.tokens`          |
| `GET`  | `/outlook/emails`           | `getEmails`              | Ids + 20 display emails. Params: `?filters=`, `?afterDate=`     |
| `GET`  | `/outlook/email/:messageId` | `getEmailDetail`         | Full detail of one message, in the unified JSONL shape          |
| `GET`  | `/outlook/count`            | `getEmailCount`          | New-email count for polling. Params: `?filters=`, `?afterDate=` |
| `POST` | `/outlook/download-chunks`  | `downloadEmailsInChunks` | SSE download in batches of 500                                  |
| `POST` | `/outlook/reply`            | `sendReply`              | Replies via `POST /me/messages/{id}/reply`                      |

Everything past the OAuth entry points requires `requireAuth`, and the same rate
limiters apply as for Gmail: OAuth 5/min, download 3/min, count 30/min.

---

## Key functions in `outlookService.js`

### `OUTLOOK_TENANT`

`oauthConfig.outlook.tenantId || 'common'`, interpolated into all three OAuth
endpoints (authorize redirect, token exchange, token refresh). Set
`OUTLOOK_TENANT_ID` to your tenant GUID for a single-tenant Entra registration,
or leave it at `common` for personal and multi-tenant accounts.

> This variable used to be documented but **ignored** — it built an MSAL
> `ConfidentialClientApplication` that was never used again while the real calls
> hard-coded `/common/`, so a single-tenant user was silently sent to the wrong
> authority. That is fixed, and the unused `@azure/msal-node` dependency is gone
> with it. The app now talks to Graph through plain `fetch`.

### `OUTLOOK_SELECT_FIELDS`

The `$select` field list requested on every Graph query. It includes
`internetMessageHeaders`, which is mandatory for `inReplyTo` and `references`.

### `formatOutlookEmail(message)`

Turns a Microsoft Graph message into the JSONL record. This is the central
function — the whole client pipeline depends on its output matching
`formatGmailEmail()`.

| JSONL field      | Graph source                                                         | Notes                                                                                  |
| ---------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `id`             | `message.id`                                                         | Outlook internal id (`AAMkADAwATM0…`)                                                  |
| `threadId`       | `message.conversationId`                                             |                                                                                        |
| `snippet`        | `message.bodyPreview`                                                |                                                                                        |
| `subject`        | `message.subject`                                                    |                                                                                        |
| `internalDate`   | `sentDateTime`, falling back to `receivedDateTime`                   | `new Date(…).getTime().toString()` — **milliseconds in a string**                      |
| `date`           | the same source string, unconverted                                  | ISO 8601 here, where Gmail gives RFC 2822                                              |
| `messageId`      | `message.internetMessageId`, falling back to the `Message-ID` header | RFC Message-ID (`<…@…>`)                                                               |
| `inReplyTo`      | `internetMessageHeaders["In-Reply-To"]`                              | Empty when the headers are unavailable                                                 |
| `references`     | `internetMessageHeaders["References"]`                               | Same                                                                                   |
| `from`           | `message.from.emailAddress`                                          | Formatted `"Name <email>"`                                                             |
| `to` / `cc`      | `toRecipients[]` / `ccRecipients[]`                                  | Arrays joined with `", "`                                                              |
| `hasAttachments` | `message.hasAttachments`                                             |                                                                                        |
| `bodyText`       | `message.body.content`                                               | HTML stripped when `contentType == "html"`, then quote-stripped by `stripQuotedText()` |
| `bodyHtml`       | `message.body.content`                                               | Only when `contentType == "html"`. Split into the HTML companion file at write time    |

> **Watch out:** `internalDate` is a millisecond timestamp **as a string**.
> Always `parseInt()` before comparing. It is the reference for incremental sync.

### `buildOutlookQuery(filters, afterDate)`

Builds the OData filter. Only `afterDate` becomes a server-side filter
(`receivedDateTime gt {iso}`). Keyword and sender filters are applied afterwards
by `shouldExcludeEmail()` from `emailUtils.js`, because Graph's OData text
filtering is too limited to express them.

### `getAllMessagesFromFolder(accessToken, folder, filterQuery)`

Automatic pagination through `@odata.nextLink`. Walks an Outlook folder (`inbox`,
`sentitems`) page by page with `$top=50`, requesting only
`OUTLOOK_SELECT_FIELDS`.

### `getEmailCount(req, res)`

The lightweight polling endpoint. Parallel calls on `inbox` and `sentitems` with
`$select=id` only, deduplicated, returning `{ newCount }`.

### `downloadEmailsInChunks(req, res)`

SSE streaming, delegating to the shared `streamEmailChunks()` in
`emailUtils.js` — so the event sequence is identical to Gmail's:
`start` → `emails` → `progress` → `complete` (or `error`). For each id it calls
`GET /me/messages/{id}` and then `formatOutlookEmail()`.

### `getValidAccessToken(session)` / `refreshOutlookAccessToken(session)`

Outlook access tokens expire after 3,600 seconds. `getValidAccessToken` checks
`expires_at` with a one-minute margin and refreshes when needed. **Every Outlook
route calls `await getValidAccessToken(req.session)`** rather than reading
`access_token` directly; that is why there is no forced sign-out after an hour.

### `sendReply(req, res)`

Calls `POST https://graph.microsoft.com/v1.0/me/messages/{id}/reply` with:

- `comment` — the reply's text body
- `message.toRecipients` / `message.ccRecipients` — recipients parsed from the
  text strings

Graph answers **202 Accepted with no body** on success, unlike Gmail's
`{ success: true, messageId }`.

---

## Outlook vs Gmail

| Aspect                      | Gmail                                                 | Outlook                                                          |
| --------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| Mail API                    | Google APIs (`googleapis`)                            | Microsoft Graph, via plain `fetch`                               |
| Auth                        | OAuth2 through `google.auth.OAuth2`                   | OAuth2 by direct code exchange with `fetch`                      |
| Token lifetime              | Long-lived, with a refresh token                      | Access token expires after 1 h; refreshed automatically          |
| Pagination                  | `nextPageToken` in the response                       | `@odata.nextLink` in the response                                |
| Filtering                   | Gmail query string (`after:2025/01/01 -from:noreply`) | OData filter (`receivedDateTime gt 2025-01-01T00:00:00Z`)        |
| Folders queried             | INBOX + SENT + ALL MAIL                               | `inbox` + `sentitems`                                            |
| Threading headers           | Always present                                        | `internetMessageHeaders` sometimes missing — see below           |
| Sending a reply             | RFC 2822 MIME + base64url                             | `POST /me/messages/{id}/reply` with JSON                         |
| Success response            | `{ success: true, messageId }`                        | HTTP 202 Accepted, no body                                       |
| Internal id                 | `email.id` = Gmail id (`17abc…`)                      | `email.id` = Outlook id (`AAMkADAwATM0…`)                        |
| RFC Message-ID              | `email.messageId` = `<…@gmail.com>`                   | `email.messageId` = `<…@outlook.com>` when headers are available |
| Single-message detail route | none — detail comes from the local JSONL              | `GET /outlook/email/:messageId`                                  |

---

## Known limitations

### 1. `internetMessageHeaders` is missing on some messages

Microsoft Graph does not always return `internetMessageHeaders`, even with an
explicit `$select`. This affects messages created natively inside
Exchange/Outlook: Teams notifications, calendar invitations, internal Exchange
mail.

**Impact:** `inReplyTo` and `references` are empty for those messages. The
conversation tree still builds — it falls back to subject, chronology and
participant sets — but those messages are not linked by MIME header.

**Behaviour:** the server logs a warning
(`formatOutlookEmail: internetMessageHeaders absent…`). This is expected, not a
bug.

### 2. Gmail and Outlook share one session

`req.session.tokens` is used by both providers. Signing into Outlook while
signed into Gmail (or the reverse) overwrites the first provider's tokens.

**Impact:** no simultaneous dual connection. One provider per session.

**Hard rule:** never create `req.session.gmailTokens` or
`req.session.outlookTokens`. The one key is `req.session.tokens`, for everything.

### 3. Three-email minimum per subject

`getSubjectsWithMinEmails(emailsClean, 3, userEmail)` in `analysis.js` requires
at least three messages sharing a subject before it appears in the list. On a
quiet Outlook account, or with aggressive filters, the list can come back empty.

**Workaround:** relax the filters before downloading, or lower the threshold at
the call site in `analysis.js`.

---

## Rules for future changes

1. **`req.session.tokens`** — one session key for all providers. No variants.
2. **The JSONL shape** — `formatOutlookEmail()` must emit exactly the same fields
   as `formatGmailEmail()`. Any field change has to land in both functions, and
   the on-disk contract is documented in
   [guides/data-format.md](../guides/data-format.md).
3. **`internalDate`** — always a millisecond timestamp in a string. `parseInt()`
   before any operation.
4. **`email.id` vs `email.messageId`** — for Outlook, `id` is the internal Graph
   id used for every API action; `messageId` is the RFC Message-ID used in MIME
   headers and in tree threading. Do not conflate them.
5. **One File System stream at a time**, `outlook_emails.jsonl` included.
6. **Always go through `getValidAccessToken(req.session)`** in a new Outlook
   route. Reading `access_token` directly reintroduces the one-hour sign-out.
7. **`analysisLaunched` in `app.js`** must be reset to `false` before calling
   `autoAnalyzeConversations()` and set back to `true` afterwards. See the
   "Download" and "Update" button handlers.
