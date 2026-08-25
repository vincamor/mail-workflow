# Attachment Support — Technical Research

Research only. No design decisions are made here — this document exists so a later
design spec can be built on verified facts instead of assumptions. Every claim below
is either cited to an official source, marked "inferred from code" (grounded in this
repo), or listed in the **Unverified** section.

Code was read from this repo's current `main` working tree on 2026-08-25:
`src/services/gmailService.js`, `src/services/outlookService.js`,
`src/services/emailUtils.js`, `src/public/js/emails.js`,
`src/public/js/email-detail.js`, `src/app.js`.
`package.json` pins `googleapis: ^153.0.0` and `@azure/msal-node: ^3.6.3`.

---

## Top 5 findings that most constrain the design

1. **The current Gmail fetch (`format: 'full'`) already returns everything needed
   to build a free attachment index** — filename, mimeType, size, and
   `attachmentId` are all present in the `messages.get` payload parts at no extra
   API/quota cost. Listing attachments requires zero new Gmail calls; only
   downloading the bytes needs a second call per attachment.
2. **Downloading attachment bytes is exactly as expensive, quota-wise, as
   downloading the message itself**: `messages.attachments.get` costs 20 quota
   units, identical to `messages.get` (source: Gmail API quota docs). Bulk
   attachment download roughly **doubles** Gmail quota consumption for any
   message that has attachments.
3. **Outlook attachments over 3 MB cannot use the simple `contentBytes` /
   single-GET path** — they require Microsoft Graph's chunked upload-session
   mechanism for *uploading*, and for *downloading* large attachments Microsoft's
   own guidance is to avoid base64 `contentBytes` (which "affects API
   performance") and use the raw `/$value` endpoint instead.
4. **Files written via `showDirectoryPicker()` to a real user-selected folder are
   NOT subject to the browser's storage quota** (unlike OPFS/IndexedDB) — per
   MDN, this is explicitly called out as a way a site "can fill up a user's disk
   without being limited by quota." No disk-budget signal is available from the
   browser; any budget feature must be self-built (e.g., summing file sizes
   before write).
5. **The email-detail iframe's sandbox (`allow-same-origin`, no `src`, filled via
   `document.write`) inherits the parent page's CSP** — including its `img-src`
   directive — because it has no independent origin-delivery mechanism (CSP spec:
   local-scheme / no-src documents inherit the embedding document's policy). The
   current CSP is `img-src 'self' data: https:` (`src/app.js`), which does **not**
   include `blob:`. A `blob:` URL used as `<img src>` inside that iframe would
   currently be **blocked by CSP**, unless the directive is widened.

---

## Gmail (googleapis Node client)

### 1. Fetching attachment bytes

- **Endpoint**: `GET https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{messageId}/attachments/{id}`
  via the Node client: `gmail.users.messages.attachments.get({ userId, messageId, id })`.
- **Path params**: `userId` (`me` for the authenticated user), `messageId`, `id` (the attachment ID).
- **Response**: a `MessagePartBody` object with fields:
  - `attachmentId` (string) — only relevant on the message-part side, not on this response.
  - `size` (integer) — "Number of bytes for the message part data (encoding notwithstanding)."
  - `data` (string, bytes) — "The body data of a MIME message part as a base64url encoded string."
- **Encoding is base64url**, same alphabet as the rest of Gmail API bodies — matches this
  repo's existing `decodeBase64Data()` in `gmailService.js` which already does
  `.replace(/-/g,'+').replace(/_/g,'/')` before `Buffer.from(..., 'base64')`. That
  same decode helper is directly reusable for attachment bytes.
- **Where `attachmentId` comes from**: it is a field on `MessagePartBody` *within the
  message payload itself* — `part.body.attachmentId`. Per the Gmail API docs: "When
  present, contains the ID of an external attachment that can be retrieved in a
  separate `messages.attachments.get` request. When not present, the entire content
  of the message part body is contained in the `data` field."
- Sources:
  [users.messages.attachments.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments/get),
  [users.messages.attachments (MessagePartBody schema)](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments)

### 2. Size limits

- Gmail's own outbound/inbound message limits (not an API-specific limit, but the
  ceiling on what can exist to fetch): attachments up to **25 MB** per file for
  standard accounts (up to 50 MB for Workspace Enterprise Plus as of a 2026 rollout),
  with the total MIME-encoded message capped around **35 MB** to account for base64
  inflation (~33% overhead). These are Gmail product limits, not something the
  `messages.attachments.get` API documents as *its own* ceiling.
  Source: [Google Workspace Update — 50MB attachments for Enterprise Plus](https://workspaceupdates.googleblog.com/2026/02/ending-larger-attachments-in-gmail-new-50MB-limit-for-Enterprise-Plus.html) (secondary/product-blog source, not the API reference — treat as directional, see Unverified).
- The API reference itself documents no separate response-size ceiling for
  `messages.attachments.get` beyond "the response is a `MessagePartBody`" — no
  documented pagination or chunking mechanism for this endpoint, meaning a very
  large attachment is returned as one large JSON response with the entire base64
  payload in `data`. This has practical implications (large single HTTP responses,
  large single writes) even though Google does not publish an explicit byte ceiling
  for the endpoint response itself.

### 3. Quota cost

Per the [Gmail API usage limits](https://developers.google.com/workspace/gmail/api/reference/quota):

| Method | Quota units |
|---|---|
| `users.messages.list` | 5 |
| `users.messages.get` | 20 |
| `users.messages.attachments.get` | 20 |
| `users.messages.import` | 25 |
| `users.messages.send` | 100 |

Project-wide limit: 1,200,000 units/minute. Per-user limit: 6,000 units/minute.

**Consequence**: a message with, say, 3 attachments would cost `20` (message) +
`3 × 20` (attachments) = `80` units instead of `20` — a 4x increase for that
message. For a bulk download of thousands of messages (this app's existing use
case — `downloadEmailsInChunks` / `streamEmailChunks`), attachment-heavy mailboxes
could hit the 6,000-units/minute per-user ceiling meaningfully faster than
today's message-only download.

### 4. Inline images (`cid:` references)

- Inline images are ordinary MIME parts inside a `multipart/related` container,
  distinguished by:
  - `Content-Disposition: inline` header (or absence of `Content-Disposition`
    entirely, in some senders' MIME output), and
  - a `Content-ID` header of the form `<some-id>` on that part.
- The HTML body references it as `<img src="cid:some-id">` — i.e., the `cid:`
  value is the `Content-ID` header value **with the surrounding `<` `>` angle
  brackets stripped**.
- In Gmail API terms, this `Content-ID` header would appear in that MIME part's
  `headers[]` array (the same array `extractEmailContent`'s `processPart()` in
  `gmailService.js` already walks, currently only reading `mimeType` and
  `body.data`) — the part itself still carries `filename`, `body.attachmentId`,
  and `body.size` exactly like a regular attachment part; nothing in the Gmail
  API schema distinguishes "inline image" from "attachment" except the
  `Content-Disposition`/`Content-ID` headers and (usually) an empty/absent
  `filename`.
- Source (Content-ID / cid mechanics, general MIME — Gmail API does not have a
  dedicated inline-image guide page): [MIME — Wikipedia](https://en.wikipedia.org/wiki/MIME)
  cross-checked against the Gmail `MessagePart` schema fields (`headers`,
  `filename`, `body.attachmentId`) on
  [users.messages.get](https://developers.google.com/gmail/api/reference/rest/v1/users.messages/get).
  The exact "strip `Content-Disposition: inline` + read `Content-ID`" mechanism
  for Gmail specifically is not spelled out in a single official Google page in
  the material retrieved — see Unverified.

### 5. Does the current `format` already return an attachment index for free?

**Yes — precisely, and this is a key finding.** Read from
`src/services/gmailService.js`:

```js
const msgData = await gmail.users.messages.get({ userId: 'me', id: msgId, format: 'full' });
```

The Gmail `format` enum (per [the Format reference](https://developers.google.com/gmail/api/reference/rest/v1/Format)):

| Value | Returns |
|---|---|
| `minimal` | ID and labels only — no headers, body, or payload |
| `metadata` | ID, labels, and headers only |
| `full` | Full payload, parsed into `payload` (what this repo uses) |
| `raw` | Full raw RFC 2822 message as one base64url blob in `raw`, `payload` unused |

With `format: 'full'` (this repo's choice), the `payload.parts[]` tree is fully
present, and each part's `MessagePart` object already includes `filename`,
`mimeType`, `body.size`, and `body.attachmentId` (when the data isn't inlined).
**No second API call is needed to enumerate what attachments exist, their names,
MIME types, and sizes** — that's already inside the exact response this app's
`extractEmailContent()` / `checkForAttachments()` functions in `gmailService.js`
already receive and partially discard (today only `part.filename` truthiness is
read, via `checkForAttachments`, to set the `hasAttachments` boolean — `mimeType`,
`body.size`, and `body.attachmentId` are read for nothing and thrown away).
Building an attachment index (name/type/size/attachmentId per email) is a
**pure code change on data already being fetched — free of any additional Gmail
API cost.** Only fetching the *bytes* requires the extra `messages.attachments.get`
call per file (see §2/§3 above).

---

## Microsoft Graph (Outlook)

### 1. Endpoints to list and download attachments

- **List**: `GET /me/messages/{id}/attachments` (or nested under `/mailFolders/{id}/...`) —
  returns a collection of `attachment` objects (base type; each item carries an
  `@odata.type` discriminator: `#microsoft.graph.fileAttachment`,
  `#microsoft.graph.itemAttachment`, or `#microsoft.graph.referenceAttachment`).
  Source: [List attachments](https://learn.microsoft.com/en-us/graph/api/message-list-attachments?view=graph-rest-1.0)
- **Get one / download**: `GET /me/messages/{id}/attachments/{attachmentId}` returns
  metadata + (for `fileAttachment`) `contentBytes` inline as base64. For raw bytes
  without base64 overhead: `GET /me/messages/{id}/attachments/{attachmentId}/$value`.
  Source: [Attach large files — Step 4](https://learn.microsoft.com/en-us/graph/outlook-large-attachments)
- **Base resource properties** (all three types inherit): `contentType`, `id`,
  `isInline`, `lastModifiedDateTime`, `name`, `size`.
  Source: [attachment resource type](https://learn.microsoft.com/en-us/graph/api/resources/attachment?view=graph-rest-1.0)

- **`fileAttachment`** (the common case — actual file bytes) adds:
  `contentBytes` (base64), `contentId` ("The ID of the attachment in the
  Exchange store" — this is distinct from the MIME `Content-ID` used for `cid:`
  mapping, see §4 below), `contentLocation` (documented as **"Don't use this
  property as it isn't supported"**).
  Source: [fileAttachment resource type](https://learn.microsoft.com/en-us/graph/api/resources/fileattachment?view=graph-rest-1.0)

- **`itemAttachment`** — an attached Outlook *item* (a contact, event, or another
  email message), not a file. A downloader must special-case this: there are no
  bytes to save to disk in the normal sense; the "content" is itself a Graph
  resource (e.g. another `message`). This repo's design needs to explicitly
  decide whether to support this type at all (out of scope for research; noted
  as a decision point).

- **`referenceAttachment`** — a *link* to a file on OneDrive/SharePoint/other
  cloud storage, not embedded bytes. Its `size` property is explicitly documented
  as **not** the size of the actual file: "The size of the metadata that is
  stored on the message for the attachment in bytes. This value doesn't indicate
  the size of the actual file." There is no `contentBytes` on this type in the
  documented property list retrieved. A downloader would need the (undocumented
  in the fetched pages) `sourceUrl`/provider fields to even attempt a fetch, and
  that fetch would be against an entirely different API/auth surface (OneDrive/SharePoint),
  not Graph mail endpoints.
  Source: [referenceAttachment resource type](https://learn.microsoft.com/en-us/graph/api/resources/referenceattachment?view=graph-rest-1.0)
  — note: this page's retrieved property table did not include `sourceUrl` or
  `providerType`, which some third-party material references; **not verified
  from an official page in this session** (see Unverified).

### 2. `contentBytes` vs. `/$value`, and size thresholds

- **Uploading** (attaching a *new* file, not relevant to a downloader but useful
  context): files **under 3 MB** can be attached in a single POST with
  `contentBytes`; files **between 3 MB and 150 MB** require the chunked
  `createUploadSession` / iterative `PUT` mechanism. 150 MB is the documented max
  attachable file size.
  Source: [Attach large files to Outlook messages or events](https://learn.microsoft.com/en-us/graph/outlook-large-attachments)
- **Downloading** (relevant to this app): Microsoft's own text is explicit —
  "getting an attachment from an Outlook item is **not technically limited by
  attachment size**. However, getting a large file attachment in base64-encoded
  format **affects API performance**." Their documented alternative for large
  attachments is to fetch the raw bytes via the `/$value` suffix instead of
  reading `contentBytes`, and/or use `$select` to exclude `contentBytes` when
  only metadata is needed.
  Source: same as above, "Step 4: Get the file attachment from the Outlook item."
- There is **no separate hard byte threshold documented** at which `contentBytes`
  stops being returned on GET (unlike the 3 MB upload threshold) — Microsoft's
  guidance is a performance recommendation, not a hard cutoff, per the material
  retrieved in this session.

### 3. Expanding attachments in the same request (`$expand=attachments`)

- Confirmed to exist and work as: `GET /me/messages/{id}?$expand=attachments`
  (documented example uses the `beta` endpoint in the material found, but
  `$expand` is a standard OData query parameter supported per Graph's general
  [query parameters](https://learn.microsoft.com/en-us/graph/query-parameters) documentation).
- **No official page in the material retrieved documents a specific hard limit**
  (row count, byte size, or throttling multiplier) for `$expand=attachments`
  specifically. The only related guidance found is the same general "excluding
  `contentBytes` via `$select` helps performance for large attachments" advice
  as in §2. Treat any claim of a hard `$expand` limit as **unverified** — see
  below.

### 4. Inline images — `isInline` / `contentId` mapping to `cid:`

- `isInline` (Boolean, on the base `attachment` type): "`true` if the attachment
  is an inline attachment."
  Source: [attachment resource type](https://learn.microsoft.com/en-us/graph/api/resources/attachment?view=graph-rest-1.0)
- `contentId` (String, on `fileAttachment` specifically): documented only as
  "The ID of the attachment in the Exchange store." **The official property
  description retrieved in this session does not explicitly state that this
  field equals the MIME `Content-ID` used in `cid:` references** — this is the
  commonly-understood behavior (and matches the equivalent Gmail MIME mechanism
  in the underlying email format Graph is built on), but the exact wording
  "maps 1:1 to `cid:` in body HTML" was not found verified in an official Graph
  page in this session. Flagging as **inferred, not verified** — see Unverified.

### 5. Throttling limits

- A hard, well-documented Outlook-specific limit found via multiple corroborating
  (Microsoft Q&A / community, not the primary throttling-limits reference table)
  sources: **Microsoft Graph enforces a maximum of 4 concurrent requests per
  mailbox per application** ("MailboxConcurrency" limit) — described as a fixed
  service limit with no path to increase it.
  Source: [Increasing Microsoft Graph Per-Mailbox Throttling Limits — Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/5853334/increasing-microsoft-graph-per-mailbox-throttling)
  and corroborating community post
  [MailboxConcurrency Limit — Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/734143/mailboxconcurrency-limit-throttling-exception).
  **This session could not load the canonical
  [`throttling-limits`](https://learn.microsoft.com/en-us/graph/throttling-limits)
  table row for "Outlook service" specifically** — the page was fetched but the
  Outlook/mailbox-specific row was not present in the content returned (the page
  is very large and appears to be organized by many other services). The 4-concurrent-request
  figure should be treated as **corroborated by secondary/community Microsoft
  sources, not directly confirmed against the primary throttling-limits table in
  this session** — re-verify against the primary table before finalizing a
  design that depends on this exact number.
- **Practical implication regardless of the exact number**: this app currently
  fetches message bodies with unbounded-looking sequential `for` loops inside
  `streamEmailChunks` (`emailUtils.js`) — no explicit concurrency cap is visible
  in the reviewed code (requests happen one at a time per `fetchMessage` call
  inside the chunk loop, so today's Gmail/Outlook code is already serial, not
  parallel — this reduces throttling risk for the *existing* code, but any
  *added* attachment-download step that runs additional per-message HTTP calls
  will roughly double request volume against the same mailbox).

---

## Browser-side storage

### 1. File System Access API — writing binary files into a subdirectory

- Confirmed pattern (used elsewhere in the app already for JSONL/text, e.g.
  `writeSyncMetadata` in `src/public/js/emails.js`):
  `dirHandle.getDirectoryHandle(name, { create: true })` →
  `subDirHandle.getFileHandle(fileName, { create: true })` →
  `fileHandle.createWritable()` → `writable.write(data)` → `writable.close()`.
  `FileSystemWritableFileStream.write()` accepts a `BufferSource` (e.g.
  `ArrayBuffer`/typed array), `Blob`, `string`, or a `WriteParams` object — so
  writing raw attachment bytes (as a `Blob` or `ArrayBuffer`, not just JSON text
  like the current code does) is directly supported by the same API surface
  already in use.
- **No documented per-write or per-file size limit** was found for
  `FileSystemWritableFileStream.write()` itself in the MDN material retrieved —
  the constraint is disk space, not an API-imposed ceiling.
  Source: [MDN — File System API / Origin private file system](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
  (this specific page covers OPFS but its quota-vs-real-folder distinction is
  the load-bearing fact here — see finding below).

### 2. Storage quota — does it apply to a real user-selected folder?

**No.** This is a load-bearing, well-verified finding:

> "Other than files in a bucket file system, files written by this API are not
> subject to storage quota, so websites can fill up a user's disk without being
> limited by quota, which could leave a user's device in a bad state."

This is from the File System Access API's own specification/explainer material
(surfaced via MDN cross-reference). The `navigator.storage.estimate()` /
`StorageManager` quota machinery applies to **origin-partitioned storage**
(IndexedDB, OPFS/"bucket file system", Cache API) — **not** to a directory the
user explicitly picked via `showDirectoryPicker()`, which this app already uses
as its entire storage model (per `CLAUDE.md`: "Emails live only in a local
folder the user picks"). **Consequence**: the browser will not warn the app or
the user as disk fills up from attachment downloads — the app has zero built-in
signal here and would need to build its own (e.g., proactively summing
attachment sizes, or catching the write-time `QuotaExceededError`/disk-full
`NotAllowedError`-family exceptions that the underlying OS file write can still
raise).
Source: [MDN — File System API / Origin private file system](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system),
cross-checked via web search summarizing the same spec language.

### 3. Rendering a locally-stored inline image inside the sandboxed iframe

This is the most consequential and most carefully-verified question in this
document, because it interacts directly with the project's stated
"security-critical" invariant (`CLAUDE.md`: the iframe sandbox must never gain
`allow-scripts`).

**What the current code does** (`src/public/js/email-detail.js`, read directly):

```js
const iframe = document.createElement('iframe');
iframe.sandbox = 'allow-same-origin';   // NO allow-scripts — intentional, commented as critical
...
const doc = iframe.contentDocument || iframe.contentWindow.document;
doc.open();
doc.write(`<!DOCTYPE html>...`);   // body HTML injected here after regex sanitization
doc.close();
```

The iframe has **no `src` and no `srcdoc` attribute** — it is populated via
`document.open()/write()/close()` on an `about:blank` document, with
`sandbox="allow-same-origin"` granting that document the parent's origin
(instead of an opaque one).

**CSP inheritance (verified against the CSP spec's own inheritance model):**
Documents with "local schemes" (`about:`, `blob:`, `data:`, `filesystem:`) or
loaded via `srcdoc`, or — as here — populated via `document.write()` into an
`about:blank` frame, have no HTTP response of their own to carry a
`Content-Security-Policy` header, so **per the CSP specification's inheritance
algorithm, they inherit the CSP of their embedding (parent) document.** This is
long-standing, specified behavior (the CSP3 spec explicitly designed this to
prevent using local-scheme documents as a policy bypass), not an implementation
quirk of one browser. This means: **the `img-src` directive from `src/app.js`'s
helmet config (`"'self' data: https:"`) already applies inside this iframe
today**, and would continue to apply to any new `img` sources added for inline
attachments.
Source: web-search-surfaced CSP spec language (W3C CSP3 editor's draft /
inheritance algorithm discussion); **not independently re-verified against the
live W3C spec text with a direct fetch in this session** — treat the mechanism
as well-established web-platform behavior (this is not a disputed or
browser-specific point in the material found), but see the Unverified section
for the caveat on sourcing depth.

**Consequences for `blob:` and `data:` URIs specifically:**
- **`data:` URIs**: already allowed by the current CSP (`img-src` includes
  `data:`), and `data:` URIs need no origin/permission checks to load as `<img
  src>` — they would work today, inside this sandbox, with no CSP change. The
  cost is base64 inflation (~33%) and holding the whole image as a JS string.
- **`blob:` URIs**: **NOT currently allowed** — the CSP's `img-src` list is
  `'self' data: https:`, which does not include the `blob:` scheme. A `blob:`
  URL created in the parent page (e.g. `URL.createObjectURL(attachmentBlob)`)
  and used as `<img src="blob:...">` inside this iframe would be **blocked by
  the inherited CSP** unless the `img-src` directive is widened to include
  `blob:`. Separately from CSP: because the iframe has `allow-same-origin` (so
  its origin equals the parent's, rather than being opaque/`null`), a
  same-origin `blob:` URL *should* be loadable by that document once CSP
  permits it — blob URLs are origin-scoped and this iframe's effective origin
  matches the origin that created the blob. This origin-matching claim is
  **inferred from how blob URL origin-scoping is generally documented**, not
  independently confirmed for this exact sandboxed/`document.write` combination
  in an authoritative source in this session — see Unverified.
- **`https:` remote images**: already explicitly allowed and is the documented
  reason the current CSP has `img-src` widened at all (see the comment in
  `src/app.js`: "pour que les emails HTML ... affichent leurs images
  distantes").

Sources: [`src/app.js`](../../src/app.js) (read directly, lines ~63-73),
[`src/public/js/email-detail.js`](../../src/public/js/email-detail.js) (read
directly, lines ~302-345), CSP inheritance behavior surfaced via web search of
CSP3 spec discussion threads (see Unverified for sourcing-depth caveat).

### 4. Filename sanitization hazards

Attachment filenames are **fully attacker/sender-controlled** (they come from
the `Content-Disposition: filename=` / `name=` MIME parameter, or Graph's
`name` property — neither provider validates or restricts this string). Concrete
hazards to sanitize against, compiled from Microsoft's own file-naming reference
and independent security write-ups:

- **Forbidden characters (Windows)**: `< > : " / \ | ? *`, plus all
  non-printable control characters `U+0000`–`U+001F`.
  Source: [Naming Files, Paths, and Namespaces — Win32 apps, Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)
- **Reserved device names (Windows)**: `CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`,
  `LPT0`–`LPT9` — case-insensitive, and reserved **even with an extension**
  (e.g. `NUL.txt` is still treated as the reserved device name on older Windows
  behavior). Note: per the same research, **Windows 11 changed this** — path
  normalization no longer special-cases a DOS device name if it has an
  extension (e.g. `con.txt` is fine) or if it isn't the leaf path component,
  **except `NUL`**, which stays special-cased. A sanitizer aimed at broad
  compatibility should still treat the bare reserved names (extension or not)
  as unsafe, since older Windows versions and some tools still choke on them.
  Source: [Naming Files, Paths, and Namespaces — Win32 apps, Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)
- **Trailing dots and spaces**: Windows silently strips trailing `.`/` ` from
  path components; a filename that differs from another only by trailing
  dots/spaces can collide unexpectedly, and some tooling mishandles the
  discrepancy between the name as given and the name as actually stored.
  Source: same Microsoft Learn page, corroborated by community write-ups in
  search results (e.g. Meziantou's blog).
- **Path traversal**: any filename containing `..`, `/`, or `\` must be
  neutralized (stripped/rejected or flattened to a single path segment) before
  being used to construct a path under the app's chosen output directory — this
  is a generic path-traversal concern, not something either the File System
  Access API or the mail providers guard against on the app's behalf. (The File
  System Access API itself operates on directory-relative names one path
  segment at a time — `getFileHandle`/`getDirectoryHandle` do not accept
  multi-segment paths with separators as a single call in the way a raw
  filesystem `open()` would, which incidentally limits *some* traversal vectors
  by construction, but a filename value itself containing `/`/`\` should still
  be sanitized before use, since browser behavior here is not something this
  session found formally specified as "traversal-safe" in an authoritative doc.)
- **Unicode RTL override (`U+202E`) / other bidi control characters**: a
  well-documented spoofing technique (MITRE ATT&CK T1036.002) where inserting
  `U+202E` mid-filename causes everything after it to render reversed — e.g. a
  file physically named `invoice-[U+202E]fdp.exe` displays to a user as
  `invoice-exe.pdf`, disguising the real (executable) extension. Any attachment
  UI that shows filenames to the user must strip or escape bidi control
  characters (`U+202A`–`U+202E`, `U+2066`–`U+2069`) before display, independent
  of what's used for the actual on-disk filename.
  Source: [MITRE ATT&CK T1036.002 — Right-to-Left Override](https://attack.mitre.org/techniques/T1036/002/)
- **macOS/Linux**: far fewer hard restrictions — the only universally forbidden
  byte is `/` (path separator) and the NUL byte `\0`; `:` is historically
  problematic on macOS (legacy HFS+ path-separator role, still surfaced oddly by
  Finder for filenames containing `:`). No reserved device names equivalent to
  Windows exist on these platforms. Since this app is cross-platform (Electron-free
  browser app, but running on user machines that may be Windows/macOS/Linux —
  confirmed Windows in this session's environment, but the app itself is a
  general local-folder tool per `CLAUDE.md`), the safe approach is to sanitize
  against the **union** of all three platforms' restrictions, i.e. effectively
  the Windows rule set (strictest) plus NUL-byte stripping.
  Source: general cross-platform filename constraint knowledge corroborated by
  the same search results (e.g. the "Invalid characters for Windows filenames"
  gist cross-referencing POSIX constraints) — **the macOS/Linux specifics were
  not independently fetched from an authoritative POSIX/Apple source in this
  session**; see Unverified.

---

## Unverified / needs confirmation

These are claims this research could **not** confirm from an official,
directly-fetched primary source, and should be re-verified before the design
spec treats them as load-bearing facts:

1. **Gmail's exact byte threshold for when a message part's `attachmentId` is
   populated vs. `data` being inlined directly.** The Gmail API docs describe
   the *mechanism* (attachmentId present → separate call needed; absent → data
   is inline) but do not publish a specific byte-size cutoff that determines
   which path Gmail's backend chooses for a given part. Real-world behavior
   (widely reported in developer community sources, not confirmed here against
   an official page) suggests a small-message-size cutoff, but no authoritative
   number was found in this session.
2. **Gmail's product-level attachment size limits (25 MB / 35 MB / 50 MB
   Enterprise)** were sourced from Google Workspace product/support pages and a
   2026 product-update blog post, not the Gmail API reference documentation
   itself — treat as directional/product info, not an API contract.
3. **The precise mapping of Gmail's MIME `Content-ID` header to `cid:` URLs**,
   and **whether Gmail's API distinguishes inline images from regular
   attachments via `Content-Disposition` in a documented, guaranteed way** —
   this session relied on general MIME-standard behavior and the Gmail
   `MessagePart` schema's generic `headers[]` array, not a Gmail-specific
   "here's how inline images work" guide page (none was found/loaded).
4. **Microsoft Graph's `contentId` on `fileAttachment` being the same identifier
   used in `cid:` HTML references.** The official property description only
   says "The ID of the attachment in the Exchange store" — the `cid:` mapping is
   the standard real-world behavior but wasn't found spelled out in an official
   Graph page in this session.
5. **`referenceAttachment`'s `sourceUrl`/`providerType`-style properties** —
   the official page fetched in this session only returned the base
   `attachment` properties (`contentType`, `id`, `isInline`, `name`, `size`,
   `lastModifiedDateTime`) for `referenceAttachment`; properties that would
   actually let a downloader locate the linked file were not present in the
   retrieved content and were not separately confirmed.
6. **A specific documented row/number for Outlook mail throttling in the primary
   [`graph/throttling-limits`](https://learn.microsoft.com/en-us/graph/throttling-limits)
   table.** The 4-concurrent-requests-per-mailbox figure is corroborated by
   multiple Microsoft Q&A / community threads but this session did not manage
   to pull the Outlook-specific row directly out of the primary throttling
   table page (the page is large and organized around dozens of unrelated
   services).
7. **Whether `$expand=attachments` on `messages.get`/`messages.list` has a
   documented hard limit** (row count, response size cap, or a throttling
   multiplier). Only general "large `contentBytes` hurts performance" guidance
   was found — no explicit `$expand`-specific limit in an official page.
8. **The CSP-inheritance-for-`document.write`-into-`about:blank`-sandboxed-iframe
   mechanism** was confirmed via search-surfaced summaries of the CSP
   specification's inheritance algorithm and secondary community sources
   discussing `srcdoc`/local-scheme inheritance, but this session did not do a
   direct fetch-and-read of the live W3C CSP spec text itself, nor of MDN's own
   CSP `img-src` inheritance-for-iframes page. The conclusion (parent CSP
   applies inside this specific iframe) is consistent across every source found
   and matches well-established, non-controversial web-platform behavior, but
   flag it for a direct spec re-check before the design spec locks in a
   `blob:` vs `data:` decision on top of it.
9. **Whether a same-origin `blob:` URL (created in the parent document) is
   reliably loadable as `<img src>` inside this specific
   `sandbox="allow-same-origin"`, no-src,
   `document.write()`-populated iframe** across Chrome/Firefox/Safari. General
   `blob:`-in-sandboxed-iframe behavior was found (and one source noted Safari
   has had extra mixed-content-style restrictions on blob URLs in
   iframes/workers), but nothing tested this exact construction
   (`allow-same-origin` without `allow-scripts`, populated via `document.write`,
   no `src`/`srcdoc`) in an authoritative source.
10. **macOS and Linux filename restrictions** were not independently verified
    against an authoritative Apple or POSIX source in this session — the
    `/` and NUL-byte restrictions are extremely well-known and low-risk to state,
    but the macOS `:`/Finder nuance was sourced from secondary material only.

---

## Constraints this imposes on the design

Factual consequences only — no proposed solutions (that belongs in the design
spec, written separately):

1. **Gmail attachment listing is free (already-fetched data); Gmail attachment
   byte download is not** — it costs as much quota per file as fetching an
   entire message. Any design must treat "index what attachments exist" and
   "download attachment bytes" as separable operations with very different
   cost profiles, especially given this app already bulk-downloads thousands of
   messages.
2. **A bulk "download all attachments for all messages" operation would roughly
   double Gmail API quota usage** for any mailbox where a meaningful fraction of
   messages have attachments, and could approach the 6,000-units/minute
   per-user ceiling faster than the current message-only download does.
3. **Outlook attachment downloads need two code paths by size**: small
   attachments can use `contentBytes` inline with the message (or via
   `$expand=attachments`, cost/limits unconfirmed — see Unverified #7); large
   ones should avoid `contentBytes` and use `/$value` per Microsoft's own
   performance guidance, since there is no fully documented hard cutoff and
   Microsoft frames it as a graduated performance concern rather than a bright
   line.
4. **`itemAttachment` and `referenceAttachment` cannot be handled by the same
   "fetch bytes, write file" code path as `fileAttachment`** — one carries no
   file bytes at all (it's an embedded Outlook item), and the other carries a
   link to external cloud storage outside Graph's mail API surface, with
   properties this research could not fully confirm (Unverified #5).
5. **Outlook throttling is a real constraint on any newly-added per-message
   attachment fetch loop**, given the corroborated (if not primarily-sourced)
   4-concurrent-request-per-mailbox ceiling — this app's existing
   `streamEmailChunks` pipeline is already serial per provider, which helps,
   but adding attachment fetches multiplies the number of sequential HTTP calls
   per message.
6. **There is no browser-level disk-space safety net.** Because a real
   user-selected folder is exempt from the Storage API's quota system, the app
   cannot rely on `navigator.storage.estimate()` or a `QuotaExceededError` from
   the File System Access API to protect the user's disk — any overrun
   protection has to be built by the app itself.
7. **Rendering inline images inside the existing sandboxed iframe is constrained
   by the *existing* CSP `img-src` value**, which currently allows `'self'`,
   `data:`, and `https:` but **not** `blob:`. Whatever mechanism the design
   chooses for showing locally-stored inline images must either use a scheme
   already covered by the current CSP (`data:` works today, no CSP change) or
   require widening `img-src` (needed for `blob:`) — and per the project's own
   `CLAUDE.md` security-notes rule ("Colors via CSS variables only... " is
   unrelated, but the sandbox/XSS rule is explicit), any CSP change is a
   security-relevant change to a file the project's own docs call out as
   containing "SÉCURITÉ CRITIQUE" comments, and should be reviewed with that
   weight.
8. **Attachment filenames must be sanitized before being used as on-disk
   filenames AND before being displayed to the user** — these are two separate
   sanitization needs (path/OS-safety vs. visual-spoofing safety) that do not
   fully overlap: RTL-override characters are a display-spoofing concern even
   in filenames that are otherwise perfectly valid on every filesystem.
