# File System handles: the local-storage workflow

**Who this is for:** contributors working on folder selection, downloading,
syncing, or anything that reads and writes the local JSONL. It traces the call
chains end to end.

The *format* of what lands on disk is documented separately, for users as well
as contributors: [guides/data-format.md](../guides/data-format.md). This
document is about the *mechanics* — handles, permissions, streams, and the order
in which things happen.

---

## 1. Step by step

### 1.1 Picking a folder (first time)

```
User clicks "Choose folder"
→ changeFolderBtn.onclick()              (folders.js → initFolderHandlers)
→ window.showDirectoryPicker()
→ storeFolderHandle(userId, handle)      (storage.js)
→ handle persisted in IndexedDB
→ updateFolderStatus() + showStep2() + showStep3()
```

### 1.2 Reloading the page

```
Page loads
→ DOMContentLoaded                       (js/app.js → initApp)
→ browser check (skipped in demo mode)
→ fetchEmails()                          → provider message ids + badge count
→ restoreFolder(userId)                  (folders.js)
→ restoreFolderHandle(userId)            (storage.js)
→ handle.queryPermission() / handle.requestPermission()
→ granted   : currentFolderHandle = handle
→ otherwise : the UI falls back to "no folder selected"
→ startEmailPolling(provider, userId)    → immediate check, then every 5 min
→ autoAnalyzeConversations()             → analyses the existing local JSONL
```

A directory handle survives a reload, but the **permission** may not. That is why
`restoreFolder` queries first and requests second, and why the UI has a distinct
"needs re-authorisation" state (`updateFolderStatusNeedsReauth`) rather than
pretending no folder was ever chosen.

### 1.3 Fetching message ids

```
User authenticated via OAuth
→ GET /<provider>/emails                 (routes → service.getEmails)
→ optional query params:
   - filters   : active filters, JSON-encoded
   - afterDate : internalDate of the newest stored email (incremental sync)
→ buildGmailQuery / buildOutlookQuery
→ Gmail   : getAllMessages() over INBOX + SENT + ALL MAIL, paginated
  Outlook : getAllMessagesFromFolder() over inbox + sentitems,
            paginated through @odata.nextLink
→ deduplicated by id
→ returns 20 fully formatted emails (for display) + the complete id list
```

### 1.4 Full download

```
User clicks "Download emails"
→ downloadEmails(messageIds, provider, userId, { appendMode: false })  (emails.js)
→ POST /<provider>/download-chunks                                     (SSE)
→ server: streamEmailChunks() in emailUtils.js
   → batches of 500
   → filters applied (query + shouldExcludeEmail)
   → SSE events: 'start' → 'emails' → 'progress' → 'complete' (or 'error')
→ client: reads the stream and writes as it goes
   → main records to <file>.temp, then copied over <provider>_emails.jsonl
   → bodyHtml to <html file>.temp, then copied over <provider>_emails_html.jsonl
→ writeSyncMetadata() → <provider>_sync_metadata.json
```

### 1.5 Incremental sync

```
User clicks "Update" (or syncEmails() is called)
→ syncEmails(provider, userId)                     (emails.js)
→ read <provider>_sync_metadata.json
   ├─ no metadata + a JSONL exists
   │   → bootstrapSyncMetadata()   → builds metadata from the existing JSONL
   │   → continues with the incremental sync
   ├─ no metadata + no JSONL
   │   → return false (a manual first download is required)
   ├─ filters differ from filtersUsed in the metadata
   │   → afterDate = null, appendMode = false  → full re-download
   └─ filters identical
       → afterDate = lastInternalDate, appendMode = true
→ GET /<provider>/emails?afterDate=…&filters=…     → ids since that date
→ deduplicate: drop ids already present in the JSONL
→ downloadEmails(newIds, …, { appendMode: true, silent: true })
   → createWritable({ keepExistingData: true }) + seek(file.size)
→ writeSyncMetadata()
```

### 1.6 Lightweight polling (the "new emails" badge)

```
On load: startEmailPolling(provider, userId)
  → checkForNewEmails() immediately
  → setInterval(checkForNewEmails, 5 min)

checkForNewEmails():
→ read <provider>_sync_metadata.json → lastInternalDate + filtersUsed
→ GET /<provider>/count?afterDate=…&filters=…
   → Gmail  : three parallel id-only listings (INBOX, SENT, ALL MAIL),
              deduplicated → { newCount }
   → Outlook: parallel inbox + sentitems with $select=id → { newCount }
→ updateNewEmailsBadge(newCount)
   → the "Update" button shows the count when > 0 and gets the
     "has-updates" class for highlighting
```

The count endpoints exist so the badge never costs a download. They are
rate-limited separately (30/min) from the download routes (3/min).

### 1.7 Analysing conversations

```
Automatically after load (or on demand)
→ autoAnalyzeConversations()                       (analysis.js)
→ getEmailFileHandle(userId, provider)             (folders.js)
→ emailAnalyzer.loadEmailsFromHandle(fileHandle)
   → file.stream() → chunked read → JSONL parsed line by line
→ emailAnalyzer.cleanEmail()
→ emailAnalyzer.getSubjectsWithMinEmails(emailsClean, 3, userEmail)
→ displaySubjects()   → 10 subjects, expandable to all
```

### 1.8 Selecting a subject

```
User clicks a subject
→ toggleSubjectDrawer()                            (analysis.js)
→ notifySubjectSelected(subject, subjectInfo)      → pub/sub subscribers
→ _selectSubjectHandler(subject)                   → injected by app.js
→ selectSubject(...)                               (analysis.js)
→ getEmailFileHandle()
→ emailAnalyzer.getEmailsForSubjectOptimized(fileHandle, subjectInfo)
   → loadEmailsFromHandle() + in-memory filtering by subject
→ emailAnalyzer.cleanEmail() on each
→ emailAnalyzer.createTemporalGroupTree(emailsClean, subject)
→ treeRenderer.createCompleteVisualization(tree)   → container HTML
→ injected into #treeContainer, then renderTree()  → native SVG
```

---

## 2. What ends up on disk

```
<picked folder>/
  EmailWorkflow/
    <userId>/
      gmail_emails.jsonl            main store, one JSON object per line
      gmail_emails_html.jsonl       HTML bodies, {id, bodyHtml} per line
      gmail_sync_metadata.json      sync date, filters, total
      gmail_groups.json             subject groups + favourites
      outlook_emails.jsonl          identical set for Outlook
      outlook_emails_html.jsonl
      outlook_sync_metadata.json
      outlook_groups.json
```

Every reader and writer resolves this directory through
`resolveUserFolderHandle()` in `folderResolver.js`, which accepts the root, the
`EmailWorkflow` folder, or the account folder itself. Readers pass
`{ create: false }`; only the download path passes `{ create: true }`. Field
schemas and write semantics: [guides/data-format.md](../guides/data-format.md).

---

## 3. Why handles rather than paths

- **No path typing.** The user never enters a filesystem path.
- **Persistence.** The handle is restored from IndexedDB on reload.
- **Explicit permissions.** The browser mediates access, and the app checks and
  re-requests rather than assuming.
- **Analysis stays local.** A handle cannot be serialised and sent to a server,
  which structurally guarantees that all JSONL reading happens client-side.
- **Chunked reads and streaming writes.** Large files are processed
  progressively; downloads never hold the mailbox in memory.

---

## 4. IndexedDB

- Database: `EmailWorkflowDB`
- Object store: `folderHandles`
- Key: `userId` (the user's email address)
- Value: `FileSystemDirectoryHandle`

**Rule:** always use the `onsuccess` / `onerror` callbacks. Treating an
`IDBRequest` synchronously fails silently — this has already cost the project
one debugging session.

A second, unrelated database, `AIChatsDB` → `chats`, holds AI conversations
keyed by `subjectKey`.

---

## 5. Function reference

### IndexedDB — `storage.js`

- `openDB()` — opens/creates the database
- `storeFolderHandle(userId, handle)` — stores a handle
- `restoreFolderHandle(userId)` — restores a handle, handling permissions
- `deleteFolderHandle(userId)` — removes a handle

### File system — `folders.js`

- `getCurrentFolderHandle()` / `setCurrentFolderHandle(handle)` — accessors for
  the module-level `currentFolderHandle`
- `getEmailFileHandle(userId, provider)` — the JSONL file handle (and the demo
  mode graft point)
- `analyzeEmailFile(fileHandle)` — streams the JSONL and returns
  `{ exists, emailCount, emailIds }`. It extracts only the `id` of each line, so
  the parsed object is collectable immediately. It **no longer returns the full
  emails array** — that was removed to stop out-of-memory crashes. Anything
  needing the emails calls `loadEmailsFromHandle` instead
- `getEmailStats(emails)` — date statistics over a list of emails
- `restoreFolder(userId)` — restores the handle on page load
- `initFolderHandlers(userId, callback)` — wires the folder-selection button
- `updateFolderStatus` / `updateFolderStatusNeedsReauth` / `showStep2` /
  `showStep3` / `enableDownloadButton` — the folder-setup UI states

### Folder resolution — `folderResolver.js`

- `resolveUserFolderHandle(rootHandle, userId, { create })` — the single source
  of truth for "which directory are we working in". Pure: the root handle is a
  parameter, so it is unit-tested without a DOM
  (`tests/frontend/folderResolver.test.js`)

### Download and sync — `emails.js`

- `downloadEmails(messageIds, provider, userId, options)` — downloads and writes
  the JSONL and its HTML companion
  - `options.appendMode` — `true` appends to the existing files, `false`
    rewrites through a temp file
  - `options.silent` — `true` suppresses the confirmation dialog (automatic sync)
  - `options.existingEmailCount` — already-present count, for the metadata total
  - `options.onMilestone` / `options.milestoneInterval` — progressive analysis
    callbacks during a long download
- `syncEmails(provider, userId)` — the whole incremental sync
- `bootstrapSyncMetadata(userFolderHandle, provider, filters)` — builds metadata
  from an existing JSONL without re-downloading
- `readSyncMetadata` / `writeSyncMetadata(userFolderHandle, provider, …)`
- `startEmailPolling(provider, userId, intervalMs = 5 min)` / `stopEmailPolling()`
- `checkForNewEmails(provider, userId)` / `updateNewEmailsBadge(count)`
- `cleanupExcludedSubjectFromJSONL(provider, userId, subject)` and the batch form
  `cleanupExcludedSubjectsFromJSONL(...)` — remove a subject's emails by
  rewriting through a temp file, then do the same pass over the HTML companion
- `loadBodyHtmlForEmail(provider, userId, emailId)` — streams the HTML companion
  and stops at the first matching id
- `redownloadMissingEmails(provider, userId)` — re-fetches records missing from
  the local file
- `migrateJsonlIfNeeded(provider, userId)` — converts an old single-file JSONL
  (with `bodyHtml` inline) into the split format

### Provider services — `gmailService.js` / `outlookService.js`

- `buildGmailQuery(filters, afterDate)` / `buildOutlookQuery(filters, afterDate)`
- `getEmails(req, res)` — ids + 20 display emails; accepts `?afterDate=` and
  `?filters=`
- `downloadEmailsInChunks(req, res)` — SSE download, both delegating to
  `streamEmailChunks` in `emailUtils.js`
- `getEmailCount(req, res)` — returns `{ newCount }` only, for polling
- `sendReply(req, res)`
- `getEmailDetail(req, res)` — Outlook only

### Analysis — `emailAnalyzer_browser.js`

- `loadEmailsFromHandle(fileHandle)` — streams the file and builds a **trimmed**
  object per line (`id`, `threadId`, `subject`, `from`, `to`, `cc`, `date`,
  `messageId`, `inReplyTo`, `references`, `internalDate`, `bodyText`, `snippet`,
  `hasAttachments`, plus a vestigial `labelIds` that is always `undefined`
  because the writer strips it). The fully parsed line goes out of scope
  immediately, which is what cut the peak from roughly 80 KB to 15 KB per email
- `cleanEmail(email)` — normalises one record
- `getSubjectsWithMinEmails(emailsClean, minCount, userEmail)` — subjects with at
  least `minCount` messages (default 3), with participants, date range and
  newsletter heuristics
- `getEmailsForSubjectOptimized(fileHandle, subjectInfo)` — one full read,
  filtered in memory
- `createTemporalGroupTree(emails, subject)` — builds `{nodes, links}`
- `extractSubject` / `extractFrom` / `extractDate` / `extractBodyContent`

---

## 6. Incremental sync, case by case

### First run, nothing on disk

```
syncEmails() → no metadata → no JSONL → return false
→ the user must click "Download emails"
→ downloadEmails() creates the JSONL, the HTML companion and the metadata
```

### First run with an existing JSONL (migration from an older install)

```
syncEmails() → no metadata → a JSONL is found
→ bootstrapSyncMetadata():
   - streams the JSONL
   - finds max(internalDate)
   - counts the lines
   - writes the metadata with { bootstrapped: true }
→ resumes the sync from that lastInternalDate
→ downloads only what came after, in append mode
```

### Normal sync (metadata present, filters unchanged)

```
afterDate = lastInternalDate, appendMode = true
→ GET /<provider>/emails?afterDate=… → ids since that date
→ deduplicate against the ids already in the JSONL
→ append: createWritable({ keepExistingData: true }) + seek(file.size)
→ metadata updated
```

### Sync after a filter change (strict mode)

```
filters differ from filtersUsed
→ afterDate = null, appendMode = false
→ full re-download with the new filters
→ JSONL rewritten through a temp file
→ metadata updated with the new filters
```

This is deliberate. A file half-downloaded under one filter set and half under
another cannot be reasoned about, and the cost of being wrong (silently missing
mail) is higher than the cost of a re-download.

---

## 7. API routes

### Gmail

| Method | Route | Handler | Description |
|---|---|---|---|
| `GET` | `/gmail` | `initAuth` | Starts OAuth |
| `GET` | `/gmail/callback` | `handleCallback` | OAuth callback → session |
| `GET` | `/gmail/emails` | `getEmails` | Ids + 20 display emails. Params: `?filters=`, `?afterDate=` |
| `GET` | `/gmail/count` | `getEmailCount` | New-email count for polling. Params: `?filters=`, `?afterDate=` |
| `POST` | `/gmail/download-chunks` | `downloadEmailsInChunks` | SSE download in batches of 500 |
| `POST` | `/gmail/reply` | `sendReply` | Replies inside an existing thread. Body: `{ to, cc?, subject, body, threadId, messageId, references? }` |

There is no `/gmail/email/:id` — the Gmail detail view is served from the local
JSONL.

### Outlook

| Method | Route | Handler | Description |
|---|---|---|---|
| `GET` | `/outlook` | `initAuth` | Starts Microsoft OAuth |
| `GET` | `/outlook/callback` | `handleCallback` | OAuth callback → `req.session.tokens` |
| `GET` | `/outlook/emails` | `getEmails` | Ids + 20 display emails; queries `inbox` + `sentitems`, paginated via `@odata.nextLink` |
| `GET` | `/outlook/email/:messageId` | `getEmailDetail` | Full detail of one message, in the unified JSONL shape |
| `GET` | `/outlook/count` | `getEmailCount` | New-email count; parallel inbox + sentitems, `$select=id` only |
| `POST` | `/outlook/download-chunks` | `downloadEmailsInChunks` | SSE download, same event shape as Gmail |
| `POST` | `/outlook/reply` | `sendReply` | Replies via `POST /me/messages/{id}/reply`. Returns HTTP 202 |

All routes except the OAuth entry points are behind `requireAuth`, and all are
rate-limited (OAuth 5/min, download 3/min, count 30/min).

---

## 8. Problems already solved — do not reintroduce them

**Fetching emails by subject.** `getEmailsForSubjectOptimized` used to find
nothing despite valid chunk indexes, because chunk counting diverged between
several concurrent File System streams. Fixed by reading the file once and
filtering in memory. The chunk index is still carried on subjects, but it is a
hint, not a seek.

**IndexedDB handles.** Handles were not reliably stored or retrieved, because
`IDBRequest` results were read synchronously. Fixed by using `onsuccess` /
`onerror` everywhere.

**ES module 404.** Importing `emailAnalyzer_browser.js` failed because the path
was relative and the server did not serve `/services`. Fixed by an explicit
static route in `src/app.js` plus absolute import paths.

**`ReferenceError: afterDate is not defined`.** `afterDate` and `appendMode` were
assigned inside an `if/else` without being declared first. Fixed by declaring
both with `let` before the branch.

**Out of memory during sync.** Three simultaneous accumulations in the
`syncEmails()` → `autoAnalyzeConversations()` sequence: `analyzeEmailFile`
loading the whole JSONL as a string then as an array of complete objects
(~560 MB for 5,000 emails), `loadEmailsFromHandle` parsing the full record before
`delete`-ing fields, and the subject pipeline holding two arrays with `bodyText`
duplicated in both. All three were rewritten; the numbers and the reasoning are
in [architecture.md](architecture.md#13-memory-why-the-code-looks-the-way-it-does).
Splitting `bodyHtml` into its own file came out of the same work.

---

## 9. Standing constraints

1. **A `FileSystemHandle` cannot be sent to the server.** All JSONL reading is
   client-side by construction.
2. **Never two concurrent streams on one file.**
3. **IndexedDB via callbacks**, never synchronously.
4. **Absolute paths for client-side ES imports** (`/services/…`).
5. **`req.session.tokens`** is the single session key for OAuth tokens, both
   providers.
6. **`internalDate` is milliseconds in a string.** `parseInt()` before
   comparing; it is not seconds.
7. **Append mode is `createWritable({ keepExistingData: true })` + `seek(file.size)`.**
8. **A filter change forces a full re-download.** Do not route around it.
9. **Never `file.text()` on the JSONL.** A few thousand emails exceed 100 MB in
   one allocation. Always `file.stream()` and process line by line — see
   `analyzeEmailFile` and `loadEmailsFromHandle` for the correct patterns.
10. **`analyzeEmailFile` does not return `emails`.** Use `loadEmailsFromHandle`
    if you need the records themselves.
11. **The `gmail.send` scope** is required by `POST /gmail/reply`. Changing the
    scope list in `initAuth` forces every existing user to sign out and back in.

Known gaps — subject-cache and byte-offset indexing, both of which would remove
the full-file re-read on each subject selection — are tracked in
[ROADMAP.md](../../ROADMAP.md).
