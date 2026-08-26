# Architecture

**Who this is for:** anyone about to change the code. Read it whole before
touching anything; the sections on cross-module wiring (§7), fragile areas (§9)
and conventions (§10) are the ones that save you an afternoon.

This document replaces the former project-overview notes, re-verified against
the code as it stands. Where it disagrees with your memory of the old file,
trust this one.

---

## 1. What the app is

An email visualisation tool for project work. You connect a Gmail or Outlook
account, download your mail to a local folder, and read each discussion as an
interactive conversation tree.

Three principles shape everything else:

- **Analysis and rendering happen 100% in the browser.** The server is an OAuth
  proxy and a download pipe. It parses nothing, decides nothing, and stores
  nothing.
- **Data lives on the user's disk**, through the File System Access API. No SQL
  database, no server-side storage, no cache.
- **No build step.** The front end is vanilla ES modules served as-is. There is
  no bundler, no transpiler, and no front-end dependency to install — the tree
  renderer draws raw SVG.

---

## 2. Overall shape

```
┌──────────────────────────────────────────────────────────┐
│                        BROWSER                            │
│                                                           │
│  index.html ─── js/app.js (orchestrator)                  │
│                    │                                      │
│   ┌───────────┬────┴───────┬───────────┬──────────────┐   │
│   ▼           ▼            ▼           ▼              ▼   │
│ auth.js   folders.js   emails.js   analysis.js   aiPanel  │
│ (OAuth)   (FS Access   (download,  (subjects,    aiChat*  │
│            handles)     sync,       tree)        aiFilter*│
│               │         polling)        │                 │
│         storage.js   folderResolver  emailAnalyzer_       │
│         (IndexedDB)      .js           browser.js         │
│                                          │                │
│                                    treeRenderer.js        │
│                                    (native SVG)           │
│                                                           │
│  UI modules: ui.js, panels.js, filterUI.js, emailFilters, │
│              email-detail.js, toast.js, themeManager.js   │
│  Reply: reply.js   Groups: groups.js, groupContextMenu.js │
│  Demo: demo.js                                            │
└───────────────────────┬──────────────────────────────────┘
                        │ HTTP (OAuth, SSE, AI proxy)
┌───────────────────────▼──────────────────────────────────┐
│                 BACKEND — Node.js / Express               │
│                                                           │
│  app.js ── routes/gmail.js  ── services/gmailService.js   │
│         ├─ routes/outlook.js ─ services/outlookService.js │
│         └─ routes/ai.js      ─ services/aiService.js      │
│            shared: emailUtils.js, quoteStripper.js        │
└──────────────────────────────────────────────────────────┘
```

---

## 3. File map

### Backend (`src/`)

| File | Role | Notes |
|---|---|---|
| `src/app.js` | Express entry point | Async start-up. Helmet, CORS pinned to `APP_ORIGIN`, session store in Redis when `REDIS_URL` is set and in memory otherwise, `POST /auth/logout`, `GET /health`, static serving of `public/` and of `/services/emailAnalyzer_browser.js` |
| `src/config/oauth.js` | Reads the OAuth environment variables | Gmail and Outlook client id/secret, redirect URIs, `OUTLOOK_TENANT_ID` |
| `src/middleware/authMiddleware.js` | `requireAuth` | Rejects requests without OAuth tokens in the session |
| `src/routes/gmail.js` | Gmail routes + rate limiters | OAuth 5/min, download 3/min, count 30/min |
| `src/routes/outlook.js` | Outlook routes + the same limiters | Adds `GET /outlook/email/:messageId`, which has no Gmail equivalent |
| `src/routes/ai.js` | AI proxy routes | `POST /api/ai/model-info`, `/health`, `/chat` — all behind `requireAuth` and rate-limited |
| `src/services/gmailService.js` | Gmail OAuth + Gmail API | `formatGmailEmail`, `buildGmailQuery`, `getEmails`, `getEmailCount`, `downloadEmailsInChunks`, `sendReply`. Requests the `gmail.send` scope alongside `gmail.readonly` |
| `src/services/outlookService.js` | Outlook OAuth + Microsoft Graph | Automatic token refresh (`getValidAccessToken`), `formatOutlookEmail`, `buildOutlookQuery`, `getAllMessagesFromFolder`, `downloadEmailsInChunks`, `getEmailCount`, `getEmailDetail`, `sendReply`. See [outlook-implementation.md](outlook-implementation.md) |
| `src/services/emailUtils.js` | Shared provider-agnostic logic | `streamEmailChunks` (the SSE engine used by both providers), `shouldExcludeEmail`, `normalizeSubject`, `isSenderRepetitive` (auto-exclusion), `parseFiltersFromRequest`, `isTokenError`, `isRateLimitError` |
| `src/services/aiService.js` | Multi-provider AI request building | `assertSafeProviderUrl` — the anti-SSRF `baseUrl` validation — plus `buildProviderRequest` and `sendToProvider` |
| `src/services/quoteStripper.js` | `stripQuotedText` | Shared by the back end (before writing `bodyText`) and the front end (AI context) |
| `src/services/emailAnalyzer_browser.js` | **Client-side** analyser, served to the browser | Lives under `src/services/` but never runs on the server. ES module, `export default`. Must have **no imports** — `tests/frontend/demoMode.test.js` asserts that |

### Front end (`src/public/js/`)

| File | Role |
|---|---|
| `app.js` | Single entry point (`type="module"` from `index.html`); orchestrates every other module |
| `auth.js` | OAuth buttons, fetch interceptor that catches 401s |
| `folders.js` | File System Access API, owns `currentFolderHandle`, `getEmailFileHandle`, `analyzeEmailFile`, `restoreFolder` |
| `folderResolver.js` | Pure function resolving the data folder from whichever level the user picked — see [data-format.md](../guides/data-format.md#tolerant-folder-resolution) |
| `storage.js` | IndexedDB persistence of directory handles (`EmailWorkflowDB` → `folderHandles`) |
| `emails.js` | SSE download, incremental sync, sync metadata, polling, JSONL cleanup and migration, lazy HTML body loading |
| `analysis.js` | Analysis orchestration and the subject list: groups, favourites, search, incremental analysis, tree loading |
| `groups.js` | Subject groups and favourites — reads/writes `<provider>_groups.json` |
| `groupContextMenu.js` | Right-click menu on subjects and groups |
| `treeRenderer.js` | The conversation tree: native SVG, layout, zoom/pan, timelines, auto-fit |
| `email-detail.js` | Email detail modal, sandboxed body iframe, reply buttons |
| `reply.js` | Reply form: recipient pre-fill, send, feedback |
| `filterUI.js` / `emailFilters.js` | Filter UI and filter logic (`shouldExcludeEmail`, client side) |
| `aiConfig.js` | AI provider/model/key configuration, persisted in `localStorage` |
| `aiPanel.js` / `aiChatUI.js` | AI panel and chat surface |
| `aiChat.js` | Per-subject chat: context building, streaming, persistence |
| `aiChatStore.js` | IndexedDB store for chats (`AIChatsDB` → `chats`, keyed by `subjectKey`) |
| `aiFilter.js` / `aiFilterReport.js` | Clean-up: code pre-filter, two AI passes, interactive report |
| `themeManager.js` | Theme switching, restored before first paint |
| `panels.js` | Three-panel resizer |
| `ui.js` | Overlays, animations, progress bar |
| `toast.js` | Transient notifications |
| `demo.js` | Demo mode: fake file handles over a bundled fixture |
| `package.json` | `{"type":"module"}` — **load-bearing**. It marks these files as ES modules for Node and Jest resolution. It looks like junk; do not delete it |

### Styles (`src/public/styles/`, plus `src/public/tree-visualization.css`)

`base/variables.css` holds the design tokens; every colour in the app resolves
through a CSS variable so themes apply everywhere. `tree-visualization.css` is
linked directly from `index.html` and styles the tree SVG.
`components/buttons.css` is **opt-in**: the primary blue style applies only to
`.btn-primary`, so a new button gets it by asking for it.

---

## 4. The main flows

### Start-up (connected)

```
1. URL → ?provider=gmail&email=user@gmail.com
2. app.js → initConnectedInterface(provider, email)
3.   → fetchEmails()              // GET /gmail/emails → 20 display emails + id list
4.   → initFolderHandlers()       // "Choose folder" button
5.   → initDownloadHandler()      // "Download" + "Update" buttons
6.   → initFilterUI()
7.   → restoreFolder(userId)      // handle restored from IndexedDB
8.   → startEmailPolling()        // immediate check, then every 5 min
9.   → autoAnalyzeConversations() // reads the local JSONL → subject list
```

### Full download

```
Click "Download"
→ downloadEmails(messageIds, provider, userId, { appendMode: false })
→ POST /<provider>/download-chunks (SSE)
→ streaming write: <file>.temp, then copied over <provider>_emails.jsonl
  (bodyHtml is split out into <provider>_emails_html.jsonl at the same time)
→ writeSyncMetadata() → <provider>_sync_metadata.json
```

### Incremental sync

```
Click "Update"
→ syncEmails(provider, userId)
→ read <provider>_sync_metadata.json
→ GET /<provider>/emails?afterDate={lastInternalDate}
→ deduplicate ids against what is already on disk
→ downloadEmails(newIds, …, { appendMode: true, silent: true })
   → createWritable({ keepExistingData: true }) + seek(file.size)
→ writeSyncMetadata()
→ analysis re-runs
```

### Selecting a subject

```
Click a subject in the left panel
→ toggleSubjectDrawer()                     (analysis.js)
→ notifySubjectSelected(...)                // pub/sub — the AI panel listens
→ _selectSubjectHandler(subject)            // callback injected by app.js
→ analysis.selectSubject(...)
→ getEmailFileHandle()                      // folders.js → currentFolderHandle
→ emailAnalyzer.getEmailsForSubjectOptimized(fileHandle, subjectInfo)
→ emailAnalyzer.cleanEmail() × N
→ emailAnalyzer.createTemporalGroupTree(emailsClean, subject)
→ treeRenderer.createCompleteVisualization(tree)   // returns the container HTML
→ injected into #treeContainer, then renderTree() draws the SVG
```

The on-disk formats these flows produce are documented for users in
[guides/data-format.md](../guides/data-format.md); the handle lifecycle and the
step-by-step call chains are in [filesystem-handles.md](filesystem-handles.md).

---

## 5. Local storage

The full layout, record schema and write semantics live in
[guides/data-format.md](../guides/data-format.md). The essentials for a
contributor:

- Files land in `<picked folder>/EmailWorkflow/<userId>/`, where `userId` is the
  user's email address.
- Four files per provider: `_emails.jsonl`, `_emails_html.jsonl`,
  `_sync_metadata.json`, `_groups.json`.
- `internalDate` is a **millisecond timestamp stored as a string**. Always
  `parseInt()` before comparing. It is the incremental-sync reference.
- Every reader and writer resolves its folder through
  `resolveUserFolderHandle()` so they all agree on one directory even when the
  user picked a different level.

### IndexedDB

- Database `EmailWorkflowDB`, object store `folderHandles`, key = `userId`,
  value = `FileSystemDirectoryHandle`.
- Separately, `AIChatsDB` → `chats` holds AI conversations keyed by
  `subjectKey`.
- **Always use `onsuccess` / `onerror` callbacks.** Synchronous handling of an
  `IDBRequest` fails silently.

### `currentFolderHandle`

The most central piece of state in the project. Declared as a module-level `let`
in `folders.js` and reached through `getCurrentFolderHandle()` /
`setCurrentFolderHandle()`. It is populated either by `restoreFolder()` at load
or by the user picking a folder. When it is `null`, no file access is possible —
`getEmailFileHandle()` returns `null` and the analysis functions return without
doing anything.

---

## 6. Analysis and rendering pipeline

### `emailAnalyzer_browser.js`

Default-exports `{ loadEmailsFromHandle, cleanEmail, getSubjectsWithMinEmails,
getEmailsForSubjectOptimized, createTemporalGroupTree }`.

| Function | In | Out | Notes |
|---|---|---|---|
| `loadEmailsFromHandle(fileHandle)` | file handle | `Array<email>` with `_chunkIndex` | Streams the JSONL and builds a **trimmed** object per line, so the fully parsed record goes out of scope immediately |
| `cleanEmail(email)` | raw email | normalised email | Unifies subject, from, date, bodyText |
| `getSubjectsWithMinEmails(emailsClean, minCount = 3, userEmail)` | cleaned emails | `Array<subjectInfo>` | Groups by normalised subject and keeps those with at least `minCount` messages. Also computes participants, recipients, date range, `hasAttachments`, `userReplied` / `userInTo` / `userInCcOnly`, and a heuristic `isNewsletter` score |
| `getEmailsForSubjectOptimized(fileHandle, subjectInfo)` | file handle, subject | `Array<email>` | Reads the whole file and filters in memory — deliberately one stream, not several |
| `createTemporalGroupTree(emails, subject)` | cleaned emails, subject | `{ subject, nodes, links, metadata }` | Chronological order plus participant-group parenting |

A node looks like:

```js
{
  id, index,                 // index = chronological position (0 = first mail)
  messageId, inReplyTo,
  from, to, cc, date, timestamp, subject,
  bodyText,                  // truncated to 200 chars for the tree
  participantsGroup,         // array of addresses (from + to + cc)
  hasAttachments,
  children,                  // array of child messageIds
  isRoot
  // yLevel is added later by the renderer's layout pass
}
```

**Do not break the `{nodes, links}` shape.** The entire visualisation depends on
it, and it is the project's least-covered critical path — see
[ROADMAP.md](../../ROADMAP.md).

### `analysis.js`

Holds `currentSubjects`, `currentEmailsMap` (id → email, for the detail modal),
`currentGroupsData`, and the filter flags. It shows the top **10** subjects and
appends a "+N" control that re-renders the full list when clicked
(`showAllSubjects`). It exposes `getEmailById()`, `saveGroupsData()` and
`refreshSubjectsDisplay()` as normal ES exports.

---

## 7. The tree renderer

`src/public/js/treeRenderer.js` — native SVG. It replaced a D3.js
implementation; there is no D3 in the project any more, and no
`treeVisualization.js`.

Its invariants are load-bearing enough that they are also in `CLAUDE.md`:

1. **Uniform node height.** `nodeHeightFor()` returns one constant (100) for
   every node. Horizontal variance via `nodeWidthFor()` is fine; vertical
   variance is forbidden, because arrow anchors are `cy = node.y + h/2` and
   arrows visibly step if `h` varies within a lane.
2. **The root is distinguished by width and border**, never by height.
3. **The trunk is the longest path from the root** (`longestPath` inside
   `calculateYLevels`), starting at `nodes[0]` — not a participant sort, not
   pure chronology.
4. **Branches alternate ±1, ±2** per participant group, ordered by group size.
5. **Auto-fit never scales a small tree above natural size** (`MAX_FIT_SCALE = 1`).
   Without that ceiling a three-message thread is blown up to fill the viewport.

Any change that seems to need per-node height variance must use width, border,
glow or node type instead.

### Two coordinate spaces — never mix them

| Space | Where | How |
|---|---|---|
| **World** (fixed grid) | inside `dataGroup` | `x = index * NODE_SPACING_X`, `y = yLevel * NODE_SPACING_Y` — independent of the viewport |
| **Screen** | on the SVG itself | derived from `translate(viewState.x, viewState.y) scale(viewState.scale)` applied to `dataGroup` |

Nodes and links live in world space. Timeline lines and labels live in screen
space, in a separate `linesGroup` with no transform, so they must be recomputed
on every zoom and pan.

An old defect here is worth knowing about because it is easy to reintroduce: the
D3 version had **two** pairs of timeline-position functions, one for the initial
auto-fit and one for zoom/pan, and any divergence between them produced a visual
jump on first render. The current renderer has a **single** pair,
`calcTimelineX` / `calcLabelX`, used by both paths, keyed off a
`timelineNodeByDate` index built once per render. Keep it that way.

### Layout constants

```js
NODE_SPACING_X = 420          // horizontal step (time axis)
NODE_SPACING_Y = 130          // vertical step (branch lanes)
CONTAINER_MARGIN = { top: 40, right: 100, bottom: 40, left: 100 }
DATA_GROUP_OFFSET = 140
ZOOM_SCALE_EXTENT = [0.1, 3]
CONTAINER_PADDING = 80        // safety margin in the fit computation
MAX_FIT_SCALE = 1
TIMELINE_LINE_OFFSET = -15
TIMELINE_LABEL_OFFSET = -80
```

Node dimensions are **not** constants: `nodeWidthFor(d)` returns 360 for the
root and 300 or 320 otherwise; `nodeHeightFor()` returns 100 for everything.

### Module state

`currentContainerId`, `positionedNodes`, `viewState`, `parentIndex`,
`timelineNodeByDate` and a `treeDataStore` Map are module-level — one tree is
displayed at a time and the previous entry is purged before each render. The
older implementation kept these on `window` (`window.positionedNodes`,
`window['treeData_*']`), which leaked one key per subject selection. Do not put
them back.

---

## 8. Cross-module wiring

The front end deliberately avoids `window.*` globals. Coupling is done in two
ways:

**Callback injection** — the consumer registers a function, the producer calls
it:

| Setter | Registered in | Called from |
|---|---|---|
| `setNodeClickHandler(showEmailDetail)` | `app.js` | `treeRenderer.js`, on node click |
| `setSelectSubjectHandler(fn)` | `app.js` | `analysis.js`, when a subject drawer opens |
| `setOnFiltersSaved(fn)` / `setOnSubjectRestored(fn)` | `app.js` | `filterUI.js` |

**Pub/sub** — `onSubjectSelected(callback)` in `analysis.js`, notified by
`notifySubjectSelected()`. The AI panel subscribes to it.

This is what breaks the import cycles that would otherwise exist between
`app.js`, `analysis.js`, `treeRenderer.js` and `email-detail.js`. If you
refactor one of these modules, keep the injection point rather than reaching for
a global.

Direct ES imports carry the rest, including
`groupContextMenu.js` → `analysis.js` (`saveGroupsData`,
`refreshSubjectsDisplay`), which is the synchronisation point between a
context-menu action and the subject list re-rendering.

Other things that are quietly load-bearing:

- **`userId` is the email address.** It is the IndexedDB key, the on-disk folder
  name and the `?email=` URL parameter. Introducing a numeric id would mean
  migrating all three.
- **The Express session key for OAuth tokens is `req.session.tokens`** — for
  both providers. Never create `gmailTokens` or `outlookTokens`; that exact bug
  has been fixed once already.
- **`analysisLaunched` in `app.js`** guards against launching
  `autoAnalyzeConversations()` twice, which would open concurrent read streams
  on the same file. A new analysis trigger must manage this flag.
- **Client-side ES imports use absolute paths.** The server exposes
  `/services/emailAnalyzer_browser.js` explicitly; a relative path 404s.
  ```js
  import emailAnalyzer from "/services/emailAnalyzer_browser.js";   // correct
  import emailAnalyzer from "../services/emailAnalyzer_browser.js"; // 404
  ```

---

## 9. What is solid, and what is fragile

### Solid

Gmail and Outlook OAuth; SSE download in chunks of 500; streaming JSONL writes;
incremental sync with metadata for both providers; metadata bootstrap from an
existing JSONL; the five-minute new-mail badge; subject extraction; tree
generation and rendering; the resizable three-panel UI; the email detail modal;
replying on both providers; the AI clean-up and per-subject chat; demo mode;
themes.

### Fragile — handle with care

1. **File System streams.** Never open two writable streams on the same file.
   In append mode, `createWritable({ keepExistingData: true })` followed by
   `seek(file.size)` is the only valid pattern.
2. **Container sizing.** If an ancestor of the tree container has no resolved
   height in CSS, `clientHeight` is 0 and the tree renders invisible. A
   `ResizeObserver` recovers once real dimensions arrive, but the CSS
   requirement stands.
3. **Timeline position consistency.** One pair of functions, used by both the
   initial fit and zoom/pan — see §7.
4. **The `analysisLaunched` flag.** Without it, analysis can start several times
   at once (page load, folder callback, end of sync) and read the same file
   concurrently.
5. **Filter handling during sync.** If the filters change between two syncs,
   `syncEmails()` forces a full re-download in overwrite mode. This is
   deliberate — it keeps the JSONL explainable. Do not route around it.
6. **The `gmail.send` OAuth scope.** Replying needs
   `https://www.googleapis.com/auth/gmail.send` in addition to
   `gmail.readonly`. If the scope list in `gmailService.initAuth` changes,
   existing users **must** sign out and back in; otherwise the Gmail API returns
   403 on send.
7. **Memory.** Never load the JSONL into a single string. See §13.

---

## 10. Rules and conventions

1. **One File System stream at a time** per file. No exceptions.
2. **`internalDate` is a millisecond timestamp in a string.** `parseInt()`
   before any arithmetic; never treat it as seconds.
3. **`req.session.tokens`** is the one session key for OAuth tokens, all
   providers, including `sendReply`.
4. **IndexedDB via `onsuccess` / `onerror`** only.
5. **Absolute paths for client-side ES imports** (`/services/…`, `./…` within
   `js/`), never `../services/…`.
6. **`emailAnalyzer_browser.js` is the only analyser**, it runs client-side, and
   it must have **no imports** — a test asserts this, because demo mode loads it
   by reading the file.
7. **Preserve existing HTML ids** (`#subjectsList`, `#treeVisualization`, …) and
   the DOM structure. Adding is fine; removing is not.
8. **`userId` is the email address** — IndexedDB key, folder name, URL
   parameter.
9. **Colours through CSS variables only.** No hardcoded colour in CSS or JS, so
   every theme applies everywhere.
10. **Primary button style is opt-in**: add `.btn-primary`.
11. **Callback injection over `window.*`** for cross-module coupling (§7).
12. **The email body iframe is sandboxed WITHOUT `allow-scripts`.** This is the
    critical XSS guard. The regex sanitiser alone is not sufficient. Never add
    `allow-scripts`.
13. **Production requires `SESSION_SECRET`.** `src/app.js` refuses to start
    without it when `NODE_ENV=production`. Redis is recommended for sessions;
    without `REDIS_URL` they are in memory and lost on restart. See
    `.env.example` and [guides/deployment.md](../guides/deployment.md).
14. **Keep `npm test` and `npm run lint` green** before every commit.

---

## 11. Feature: subject groups and favourites

Stored in `<provider>_groups.json`, managed by `groups.js`. The file schema is
documented in [data-format.md](../guides/data-format.md#provider_groupsjson).

`groups.js` exports pure-ish helpers that mutate a `data` object in place:
`readGroups` / `writeGroups` / `getUserFolderHandle`, then `createGroup`,
`renameGroup`, `deleteGroup`, `addSubjectToGroup`, `removeSubjectFromGroup`,
`getGroupsForSubject`, `getSubjectsInGroup`, `getChildGroups`,
`isSubjectGrouped`, `setGroupColor`, `toggleFavoriteSubject`,
`toggleFavoriteGroup`, `isSubjectFavorite`, `isGroupFavorite`.

`deleteGroup` removes the group, all of its children, and every membership that
pointed at any of them.

### Rendering, in `analysis.js`

| Function | When |
|---|---|
| `renderGroupedSubjectsList` | normal mode, groups exist |
| `renderFlatSubjectsList` | normal mode, no groups |
| `renderSearchGroupedSubjectsList` | search active, groups exist |
| `renderGroupItemHtml` | one group, recursive for sub-groups |

Search behaviour: a group whose **name** matches shows all of its subjects; a
group with a **matching subject** shows only the matching ones; matching groups
auto-expand. Empty groups show a placeholder in normal mode and are hidden in
favourites-only mode.

### Two small things that are easy to break

- The group icon is an inline SVG with `fill="currentColor"`, tinted by
  `style="color: …"` on the parent span. **Do not replace it with a folder
  emoji** — an emoji cannot be recoloured through CSS `color`.
- The favourite star is `opacity: 0` until the row is hovered, `☆` when unset
  and `★` with `.is-favorite` when set.

---

## 12. Feature: replying

| File | Role |
|---|---|
| `src/routes/gmail.js` / `src/routes/outlook.js` | `POST /<provider>/reply` |
| `src/services/gmailService.js` | `sendReply` — builds RFC 2822 MIME, base64url, `gmail.users.messages.send({ raw, threadId })` |
| `src/services/outlookService.js` | `sendReply` — `POST /me/messages/{id}/reply` on Graph |
| `src/public/js/reply.js` | The form: pre-fill, send, feedback |
| `src/public/js/email-detail.js` | "Reply" / "Reply all" buttons and `currentEmailData` |

Recipient logic:

- **Reply** — `To` = the original `from` (or the original `to` when the message
  was sent by the user).
- **Reply all** — `To` = the original `from`; `Cc` = every original `to` and
  `cc`, minus the current user's own address.

Critical points:

- **MIME headers.** `In-Reply-To: <messageId>` and
  `References: <references> <messageId>` are what make the provider attach the
  reply to the right thread.
- **Subject** gets an `Re:` prefix only when it does not already have one.
- **Success shapes differ**: Gmail returns `{ success: true, messageId }`,
  Microsoft Graph returns HTTP 202 with no body.
- **`currentEmailData`** is module-level in `email-detail.js` and is refreshed
  every time the modal opens; the previous reply form is hidden at the same
  moment.

---

## 13. Memory: why the code looks the way it does

Large mailboxes used to crash the tab with out-of-memory errors. Three changes
fixed it, and each looks like a pointless contortion until you know why.

**`analyzeEmailFile` (`folders.js`)** used to call `file.text()` (the whole JSONL
as one string), then `split('\n')` (an array of every line), then accumulate
complete email objects including `bodyHtml` — roughly 560 MB for 5,000 emails,
just to obtain a list of ids. It now streams, extracts only `id`, and lets each
parsed object become garbage immediately. It returns
`{ exists, emailCount, emailIds }` and **no longer returns the emails array** —
anything that needs the emails must call `loadEmailsFromHandle`.

**`loadEmailsFromHandle` (`emailAnalyzer_browser.js`)** used to parse the full
record and then `delete` unwanted fields, which does not return the allocation
promptly. It now builds a trimmed object directly from the parsed line and lets
the full one fall out of scope.

**The subject pipeline (`analysis.js`)** sets `emails.length = 0` as soon as the
cleaned array exists, and blanks `bodyText` on the cleaned copies — subject
extraction only needs `subject`, `from`, `date` and `_chunkIndex`, and bodies are
reloaded on demand when a subject is opened.

| Operation, 5,000 emails | Before | After |
|---|---|---|
| `analyzeEmailFile` (sync deduplication) | ~560 MB | ~2 MB |
| `loadEmailsFromHandle` (peak per email) | ~80 KB | ~15 KB |
| Two simultaneous arrays during analysis | ~2 × 75 MB | ~37 MB |
| `bodyText` retained during subject extraction | ~25 MB | 0 |

Splitting `bodyHtml` into its own file (see
[data-format.md](../guides/data-format.md)) is part of the same campaign.

**The rule that follows:** never read the JSONL with `file.text()`. Always
`file.stream()` and handle it line by line.

---

## 14. The AI assistant

Two features share one proxy:

- **Clean-up** (`aiFilter.js`, `aiFilterReport.js`) — a code-based pre-filter of
  regex patterns first, then two AI passes: pass 1 sorts by subject line alone,
  pass 2 examines the uncertain ones with message content. The result is an
  interactive report (exclude / keep / unsure) the user edits before applying.
- **Per-subject chat** (`aiChat.js`, `aiChatUI.js`, `aiChatStore.js`) — the
  thread is injected as context, capped at 20 emails and 3,000 characters of
  body each, and the conversation is persisted per subject in IndexedDB.

The server side is `routes/ai.js` + `services/aiService.js`, and its security
properties are not optional:

- Every `/api/ai/*` route **requires an authenticated session** and is
  rate-limited.
- `baseUrl` is validated by `assertSafeProviderUrl` before any outbound request:
  private, loopback, link-local and cloud-metadata addresses are refused —
  including IPv6 and IPv4-mapped IPv6 forms — and redirects are refused. This is
  what stops the proxy being an SSRF gadget. `ALLOW_LOCAL_AI` opens a narrow,
  explicitly configured hole for a local Ollama; it has no business being set in
  production.
- The user's API key is **never logged and never persisted server-side**. It
  lives in the browser's `localStorage` and travels only to the provider the
  user configured.

---

## 15. Demo mode

`?demo=1`, or `npm run demo`, runs the entire app against a fabricated fixture
in `src/public/demo/`. The graft is deliberately tiny: `demo.js` duck-types a
file handle over a `fetch()`ed Blob, and two early returns — in `folders.js`
(`getEmailFileHandle`) and in `emails.js` (`loadBodyHtmlForEmail`) — hand that
fake handle to the ordinary read path. Nothing in the analyser, the renderer or
the detail modal knows the difference, and no tree invariant is approached.

Consequences worth knowing:

- **Demo mode does not need the File System Access API**, so the browser check
  in `app.js` is skipped for it and the demo works on Firefox, Safari and
  mobile.
- Download, sync, delete and reply are **hidden** (a dead button is worse than
  an absent one), the AI assistant is **disabled** (`/api/ai/*` would 401), and
  IndexedDB is **never written**.
- `scripts/demo.js` forces `NODE_ENV=development` before loading `src/app.js`,
  so the demo runs **with no `.env` at all**. The Node launcher exists because
  the inline `NODE_ENV=x node …` form fails on PowerShell and `cmd`, and
  `cross-env` has no place in a project that claims no build step.
- `tests/frontend/demoMode.test.js` loads the fixture through the **real**
  analyser. That is the guard against the demo silently drifting from the
  product — and, incidentally, the first genuine test coverage of
  `emailAnalyzer_browser.js`.

---

## 16. Where to go next

- On-disk formats, for users and for code that reads them:
  [guides/data-format.md](../guides/data-format.md)
- Handle lifecycle, permissions, sync logic step by step:
  [filesystem-handles.md](filesystem-handles.md)
- Everything Outlook-specific: [outlook-implementation.md](outlook-implementation.md)
- Open work and known defects: [ROADMAP.md](../../ROADMAP.md)
- Why the repository is shaped the way it is:
  [specs/2026-08-25-oss-repo-design.md](../specs/2026-08-25-oss-repo-design.md)
