# Attachment Support — Design Spec

**Date:** 2026-08-26
**Status:** design only — **nothing here is implemented, and nothing should be until §11 is answered**
**Workstream:** C2 (see `docs/specs/2026-08-25-oss-repo-design.md`, §3 wave 2)
**Built on:** `docs/design/attachments-research.md` (workstream C1)

This document exists so the decision to build attachment support can be made on
real information, and so that whoever builds it in six months does not have to
redo the analysis. Where a choice is made, the rejected alternative is named.
Where the research was uncertain, the uncertainty is carried through rather than
laundered into confidence: claims inherited from C1's **Unverified** section are
marked `[U#n]` and refer to the numbered items there.

---

## 0. Reading order and the ten-line summary

1. Attachments are **indexed** (name, type, size, inline flag, provider id) at
   download time. For Gmail this costs nothing — the data is already in the
   response the app fetches and throws away. For Outlook it may cost one extra
   request per attachment-bearing message `[U#7]`.
2. Attachment **bytes** are fetched **on demand**, not during the bulk download,
   because bytes roughly double Gmail quota and there is no browser-level
   protection against filling the user's disk.
3. Bytes land in `attachments/<provider>/<bucket>/<messageKey>/NNN-name.ext`
   under the folder the user already picked, with a JSONL index alongside the
   two existing JSONL files.
4. Inline `cid:` images render as **`data:` URIs** — which the current CSP
   already allows. **No CSP change is required.** The alternative (`blob:`,
   which would need `img-src` widened) is analysed and rejected in §5.
5. The email-body iframe keeps `sandbox="allow-same-origin"` with **no
   `allow-scripts`**. Nothing in this design goes near that.
6. Existing datasets can be backfilled **without re-downloading everything** —
   `hasAttachments` is already on disk, so the backfill targets only the
   messages that need it (§8).
7. Total effort: **13–19 working days across five phases**, each shippable
   alone. Phase 1 (index only, no bytes) is the best value per day.

---

## 1. Scope and non-goals

### 1.1 What "attachment support" means here

| #   | In scope                                                                                                                                                                  | Phase |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| S1  | Enumerate every attachment of every downloaded message: original filename, MIME type, byte size, inline-or-not, and the provider-side identifier needed to fetch it later | 1     |
| S2  | Make `hasAttachments` — and therefore the tree paperclip badge — mean "has a real attachment", not "has any MIME part with a filename"                                    | 1     |
| S3  | Show the attachment list in the email detail view, with per-item state (indexed / on disk / skipped / failed)                                                             | 1     |
| S4  | Download attachment bytes on demand into the user's local folder                                                                                                          | 2     |
| S5  | A self-built disk budget: per-file cutoff, total ceiling, visible usage                                                                                                   | 2     |
| S6  | Render locally stored inline images in the HTML body, replacing today's broken `cid:` references                                                                          | 3     |
| S7  | Let the user save any stored attachment to a location of their choosing                                                                                                   | 2     |
| S8  | Opt-in bulk fetch (per subject, or during download) and backfill of pre-existing datasets                                                                                 | 4     |

### 1.2 Explicit non-goals

Each of these is excluded on purpose, not forgotten.

- **No in-app preview of arbitrary formats.** No PDF viewer, no Office
  rendering, no text/CSV viewer. Rendering a document format inside the app's
  own origin is a script-execution surface (PDF JS actions, SVG, HTML
  attachments) and the project's single strongest security property is that
  untrusted mail content never gets script. The only exception is inline images
  of an allowlisted raster type (§6.3), rendered inside the existing no-script
  iframe.
- **No opening files with the OS.** A web page cannot do it, and the app should
  not acquire the ability by growing a native shell. The user gets "Save a
  copy…", and their file manager does the rest.
- **No editing, no attaching, no forwarding with attachments.** The reply
  feature (`reply.js`, `sendReply`) sends `text/plain` today. Adding attachments
  to outbound mail means MIME multipart construction on the Gmail side and
  upload sessions above 3 MB on the Graph side — a separate feature with its own
  spec.
- **No `itemAttachment` / `referenceAttachment` byte download.** An
  `itemAttachment` is an embedded Outlook item (a message, contact or event),
  not a file; a `referenceAttachment` is a link into OneDrive/SharePoint reached
  through a different API and auth surface, whose locating properties C1 could
  not confirm `[U#5]`. Both are **indexed and displayed** with an explanatory
  state, and neither is fetched.
- **No search inside attachment content**, no OCR, no thumbnails, no text
  extraction feeding the AI assistant. The AI proxy sees what it sees today.
- **No virus or malware scanning**, and therefore no UI element that could be
  read as a safety verdict (§6.4).
- **No deduplication across messages.** The same 4 MB PDF sent to ten people
  stores ten times. Content-hash dedup with a reference count is a real
  optimisation and a real source of "why did deleting one message break
  another"; it is not worth it before anyone has complained about disk use.
- **No server-side storage of attachment bytes.** They transit the Express
  process and are never written to server disk (§6.5).
- **No recovery of attachments already deleted from the mailbox.** Once a
  message is gone upstream, its bytes are unrecoverable if they were never
  fetched. This is a direct consequence of the on-demand default and is called
  out to the user (§8.4).

---

## 2. On-disk format

This is the core decision, because it is the one that is expensive to change
after users have data.

### 2.1 Layout

```
<folder the user picked>/
  EmailWorkflow/<userId>/            ← resolved by folderResolver.js, unchanged
    gmail_emails.jsonl               ← existing
    gmail_emails_html.jsonl          ← existing
    gmail_sync_metadata.json         ← existing, gains an "attachments" block
    gmail_attachments.jsonl          ← NEW — the index
    attachments/                     ← NEW — created lazily, on first byte written
      gmail/
        a3/
          a3f0c1d2e4b57890/          ← messageKey (see §2.2)
            000-invoice-2026-03.pdf
            001-photo.jpg
            002-logo.png             ← inline, same store, flagged in the index
      outlook/
        7b/
          7b19ee04c6a2f331/
            000-Rapport.docx
```

Three properties matter and each is load-bearing:

- **One directory per message.** Deleting a message's attachments is one
  `removeEntry(key, { recursive: true })` instead of a prefix scan over a flat
  directory of 50 000 files. It also means a per-message name collision is the
  _only_ collision that can happen, and §2.3 makes that one impossible by
  construction.
- **A two-hex-character bucket above it.** 256 buckets. Neither NTFS nor ext4
  cares about 50 000 sibling directories, but Explorer, Finder, `ls`, backup
  tools and antivirus scanners all degrade badly — and the user is _expected_ to
  open this folder, because it is their folder. Bucketing keeps any single
  directory browsable.
- **A provider segment.** The two providers use disjoint id spaces and a user
  can have both accounts in one folder. Segmenting lets the GC pass (§2.6)
  reason about one provider at a time.

### 2.2 `messageKey` — why not the message id

Gmail message ids are short and filesystem-safe (16 lowercase hex characters).
Microsoft Graph ids are not: they are ~150-character base64url-ish strings
containing `-`, `_` and sometimes `=`. On Windows,
`<root>\EmailWorkflow\<a long email address>\attachments\outlook\<150 chars>\000-<name>.pdf`
exceeds the 260-character `MAX_PATH` before the filename is even considered, and
long-path support is opt-in per machine.

So directories are named by a **derived key**:

```js
async function messageKey(providerId) {
  const bytes = new TextEncoder().encode(providerId);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(''); // 16 hex chars
}
```

64 bits of a SHA-256 over the message id. Collision probability across a
100 000-message mailbox is ~2.7e-10 — and a collision would not be silent
corruption, because the index (§2.4) stores the full `id` next to the key: a
reader that finds a key whose stored `id` does not match its own treats it as a
miss and re-fetches. `crypto.subtle` is available in every browser that has
`showDirectoryPicker`, so this adds no capability requirement.

**Rejected:** a monotonic counter (`msg-000123`) — not stable across a
re-download, and it makes the directory meaningless without the index.
**Rejected:** the raw id with a length cap — truncation collides, and Graph ids
share long prefixes.

The key is **stored in the index**, not only recomputed, so the derivation can
change later without orphaning everything.

### 2.3 File naming and collisions

Within a message directory, the filename is:

```
<seq padded to 3>-<sanitized base><.ext>
```

`seq` is the item's ordinal within that message's attachment list (0-based,
stable because it derives from the provider's own part/attachment ordering).
This makes collisions **impossible without a probe loop**: two files genuinely
named `report.pdf` in the same message become `000-report.pdf` and
`001-report.pdf`. A probe-and-suffix loop (`report (1).pdf`) was rejected — it
costs an extra `getFileHandle` round trip per candidate, and it is not
idempotent, so re-running a failed fetch can produce a second copy.

The sanitizer that produces `<sanitized base><.ext>` is specified in full in
§6.1. It is deliberately lossy: **the original filename lives in the index, and
the index is what the UI displays.** The on-disk name only has to be safe,
unique and recognisable.

### 2.4 The index: `<provider>_attachments.jsonl`

One JSON object per line, one line per message **that has at least one
attachment**. Messages with none produce no line at all — absence is the common
case and it should cost nothing.

```jsonc
{
  "v": 1, // schema version, per line, so migration can be incremental
  "id": "18f2c9a01b2c3d4e", // the SAME id as in <provider>_emails.jsonl — the join key
  "key": "a3f0c1d2e4b57890", // messageKey; directory under attachments/<provider>/<bucket>/
  "indexedAt": "2026-08-26T09:12:44.120Z",
  "items": [
    {
      "seq": 0,
      "name": "Facture 2026-03.pdf", // ORIGINAL, verbatim, never used as a path
      "file": "000-Facture 2026-03.pdf", // on-disk name, relative to the message directory
      "mime": "application/pdf", // as reported by the provider — advisory only
      "size": 128374, // as reported by the provider — advisory only
      "inline": false,
      "cid": null, // Content-ID with <> stripped, for inline items
      "remoteId": "ANGjdJ8x...", // Gmail attachmentId | Graph attachment id
      "kind": "file", // file | item | reference  (Graph @odata.type)
      "state": "indexed", // indexed|stored|skipped|failed|unsupported|unavailable
      "reason": null, // "too-large" | "budget" | "http-404" | "write-failed"
      "bytes": null, // ACTUAL size on disk once stored — authoritative
      "storedAt": null,
      "attempts": 0,
    },
  ],
}
```

**State machine.** `indexed` → (`stored` | `skipped` | `failed` | `unavailable`).
`unsupported` is terminal and set at index time for `item`/`reference` kinds.
`failed` is retryable and carries `attempts`. Nothing is ever silently dropped.

**Why an index at all, rather than scanning `attachments/`?** Four reasons, any
one of which would be sufficient:

1. **The information is not recoverable from the filesystem.** The original
   filename is sanitized away, the MIME type was never in the name, the
   `Content-ID`→`cid:` mapping has no filesystem representation at all, and the
   provider-side `remoteId` needed to fetch the bytes exists nowhere else.
2. **A directory cannot represent metadata-without-bytes** — which is the entire
   point of the design, since the Gmail index is free and the bytes are not.
   "This message has three attachments totalling 8 MB, none downloaded" is a
   state the filesystem has no way to express.
3. **Read cost.** Rendering one conversation tree touches hundreds of messages.
   Answering "does this message have attachments" by directory scan is hundreds
   of `getDirectoryHandle` + `entries()` round trips through the File System
   Access API's permission layer. The index answers it in one streaming pass
   over one file — exactly the pattern `scanHtmlCompanionForEmail()` already
   uses for bodies.
4. **Accounting.** The disk budget (§4) needs a running byte total. Summing it
   from the index is free; getting it from the filesystem means `getFile()` on
   every file.

**Why JSONL rather than one JSON object?** Consistency with the two files
already in the folder; append-friendliness during the streaming download (the
same `writable.write(JSON.stringify(x) + '\n')` the HTML companion uses); and
the deletion path already knows how to rewrite a JSONL by filtering lines on
`id`. A single JSON document would force a read-modify-write of the whole file
for every message.

**Why not IndexedDB?** Because the index must travel with the data. The
project's premise is a portable folder the user owns; an index in browser
storage desynchronises the moment the user opens the folder on another machine,
and it would be the one piece of the dataset that is not in the folder.

### 2.5 Consistency with the existing JSONL files

- Joined on `email.id`, the same key `<provider>_emails.jsonl` and
  `<provider>_emails_html.jsonl` already use.
- Written by the same loop in `downloadEmails()` (`emails.js`, the
  `data.type === 'emails'` branch), with the same append/overwrite mode and the
  same `.temp` + swap discipline as the other two, so a re-download rewrites all
  three or none.
- Invariant: **the index is authoritative; the directory is a cache.** A file on
  disk with no index entry is an orphan (garbage-collectable). An index entry
  with `state:"stored"` whose file is missing is a repairable miss: the reader
  demotes it to `indexed` and offers to re-fetch.
- The index never duplicates anything from the other two files. In particular it
  does **not** copy `subject` or `date` — those are one join away, and a
  duplicated copy is a copy that can go stale.
- `<provider>_sync_metadata.json` gains one block:
  ```json
  "attachments": { "indexVersion": 1, "totalBytes": 734003200, "fileCount": 412, "lastGcAt": "2026-08-26T09:12:44Z" }
  ```
  Absent means "unknown" — recomputed by one pass over the index, not by a
  filesystem walk.

### 2.6 Deletion paths, and the orphan problem

`cleanupExcludedSubjectFromJSONL()` and `cleanupExcludedSubjectsFromJSONL()`
already build a `removedIds` set and already rewrite both JSONL files through a
`.temp` + swap. The index joins that pattern, and the directories are handled
after it:

```
1. rewrite <provider>_emails.jsonl        (existing)
2. rewrite <provider>_emails_html.jsonl   (existing)
3. rewrite <provider>_attachments.jsonl   (NEW — same filter on removedIds,
                                            accumulating removedBytes from item.bytes)
4. for each removed id: attachments/<provider>/<bucket>/<key>  →  removeEntry(recursive)
5. sync metadata: totalBytes -= removedBytes; fileCount -= removedFiles
```

**Step order is the design decision, and it is deliberate.** Rewriting the index
_before_ deleting the directories means a crash between the two leaves **orphan
files**: bytes on disk that nothing references. The opposite order would leave
**dangling index entries**: the UI says "on disk", the file is gone, every open
fails. Orphans waste space silently; dangling entries break visibly and
repeatedly. Orphans are the cheaper failure, and they are recoverable.

Recovery is `gcOrphanAttachments(provider)`: walk `attachments/<provider>/*/*`,
collect every message key, subtract the keys present in the index, remove what
is left. Three rules:

- It is **manual**, exposed from the storage panel as "Find and remove orphaned
  attachment files (N found, X MB)". An app whose promise is "your data stays
  yours" does not delete files in the user's own folder on a background timer.
- It **reports before it deletes**, and the report lists paths.
- It only ever touches `attachments/<provider>/`. Anything else in the folder,
  including files the user put there, is out of bounds.

A second, pre-existing hazard is worth recording even though it is out of scope:
the swap in `cleanupExcludedSubjectFromJSONL` does `removeEntry(original)` and
_then_ copies temp→final. A crash between those two loses the file. This design
does not fix it, but it must not make it worse — hence the index uses the same
pattern and the directories are only touched once all three files are
consistent.

### 2.7 Backward compatibility

Users already have data on disk with no `attachments/` directory and no index.

- **A missing `<provider>_attachments.jsonl` means "not indexed", never "no
  attachments".** Every reader returns `null`, and the UI distinguishes the two:
  "Attachments not indexed for this dataset — [Index now]" versus "No
  attachments". Conflating them would tell the user their invoice does not
  exist.
- The `attachments/` directory is created with `{ create: true }` only when the
  first byte is about to be written. A user who never downloads an attachment
  never gets an extra directory in their folder.
- `folderResolver.js` is unchanged. Its heuristic `folderHasEmailsJsonl()` keys
  on `*_emails.jsonl`, which the index filename (`*_attachments.jsonl`) does not
  match — so the resolver's behaviour is untouched. **This must be asserted in a
  test**, because `/_emails\.jsonl$/i` against `gmail_attachments.jsonl` is
  exactly the kind of near-miss that a later rename would turn into a bug.
- Old app versions reading a new folder ignore both the index and the directory:
  additive only.
- `docs/guides/data-format.md` (or `DATA_FORMAT.md`, wherever workstream A6's
  docs restructure lands it) must document the index schema and the directory
  layout. If that file does not exist when this is implemented, it must be
  created — an undocumented on-disk format in a folder the user owns is a
  defect.

---

## 3. Fetch pipeline

### 3.1 The two operations have completely different cost profiles

C1's finding #1 is the pivot of this whole design:

| Operation                     | Gmail                                                                                                                                       | Outlook                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Index** (name/type/size/id) | **Free.** Already inside the `messages.get(format:'full')` response the app fetches today and discards. Zero extra calls, zero extra quota. | **Not free.** `OUTLOOK_SELECT_FIELDS` carries only `hasAttachments`. Names/sizes/ids need either `$expand` on the existing GET (unproven, `[U#7]`) or a second GET. |
| **Bytes**                     | 20 quota units per attachment — **identical to fetching an entire message**. A 3-attachment message costs 80 units instead of 20.           | One request per attachment, against a mailbox limited to ~4 concurrent requests `[U#6]`.                                                                            |

Everything below follows from that asymmetry.

### 3.2 Indexing — during the normal download

**Gmail** (`gmailService.js`). Replace `checkForAttachments()` with
`extractAttachmentIndex(payload)`, which walks the same part tree
`extractEmailContent()` already walks and returns the item array of §2.4. Per
part it reads `filename`, `mimeType`, `body.size`, `body.attachmentId`, and —
new — the `headers[]` array for `Content-ID` and `Content-Disposition`. A part is
an attachment candidate when it has a non-empty `filename` **or** a
`Content-ID`; it is `inline: true` when `Content-Disposition` starts with
`inline` **or** a `Content-ID` is present and referenced by the HTML body. It is
skipped when `body.attachmentId` is absent _and_ `body.data` is present — that
is a small part Gmail inlined, with no separate id to fetch `[U#1]`; its bytes
are already in hand, so it is either written out directly or recorded as
`state:"skipped", reason:"inlined-part"`. This edge is under-documented and needs
the Phase 0 experiment (§11 E2).

`hasAttachments` is then derived as
`items.some(i => !i.inline && i.kind === 'file')` — see §7.1 for why this changes
existing behaviour.

**Outlook** (`outlookService.js`). Two candidate strategies:

- **A — `$expand`, zero extra requests.** Add
  `$expand=attachments($select=id,name,contentType,size,isInline,contentId)` to
  the existing per-message GET in `downloadEmailsInChunks`. The `$select` inside
  the expand is what keeps `contentBytes` out of the response, which is the whole
  performance concern Microsoft documents. **C1 could not find a documented limit
  or cost for this `[U#7]`** — no row count, no size cap, no throttling
  multiplier.
- **B — a second GET, gated on `hasAttachments`.**
  `GET /me/messages/{id}/attachments?$select=id,name,contentType,size,isInline,contentId`.
  Documented and predictable; costs one request per attachment-bearing message.

**Decision: implement B, put A behind a flag, measure, then flip if A holds.** B
is the version that certainly works and whose cost is knowable in advance; A is
strictly better if it behaves, and the flag makes that a measurement rather than
a rewrite. The flag is a module constant, not a user setting.

Whichever is used, the Outlook index is **not free**, so it is gated by the
attachments setting (§11 Q4). No such gate exists for Gmail, because there is
nothing to gate.

### 3.3 Fetching bytes — when

**Default: on demand.** Three independent reasons, each sufficient:

- It roughly doubles Gmail quota for attachment-bearing messages against a
  6 000 units/minute per-user ceiling that the existing bulk download already
  approaches.
- It multiplies request volume against Graph's ~4-concurrent-per-mailbox limit
  `[U#6]` on a pipeline that is already serial.
- It writes unbounded bytes into a folder with **no browser quota safety net at
  all** (C1 finding #4). A 50 000-message mailbox with a 10% attachment rate and
  a 1 MB mean is 5 GB written without a single prompt.

Concretely:

- Opening an email detail fetches its **inline images** automatically (they are
  part of reading the message; §5.5), subject to the cutoff and the budget.
- Non-inline attachments are fetched only on an explicit click.
- **Opt-in bulk** (Phase 4): "Download attachments for this subject" — bounded,
  comprehensible, and the size is known from the index and shown before
  confirming — plus a download-time toggle "Also fetch attachments" for users who
  want an archival copy and accept the cost.

The archival argument deserves its due: with on-demand fetching, an attachment
is only retrievable while the message still exists upstream. A user archiving a
mailbox they are about to lose access to genuinely needs the bulk mode. That is
why it exists, and why the UI states the trade-off instead of hiding it (§8.4).

### 3.4 Fetching bytes — how, and why not through `streamEmailChunks`

**`streamEmailChunks` is the wrong pipe for this, and it should not be bent to
fit.** It is a Server-Sent Events stream whose consumer does
`JSON.parse(line.substring(6))` on every `data:` frame. Binary through it means
base64 inside JSON — +33% over the wire, whole attachments materialised as
JavaScript strings on both ends, and a single 25 MB file arriving as one ~34 MB
SSE frame. It is built to stream many small JSON records; an attachment is one
large opaque blob.

Instead, one plain HTTP endpoint per provider:

```
GET /gmail/attachment/:messageId/:attachmentId
GET /outlook/attachment/:messageId/:attachmentId
```

Both `requireAuth`, both returning raw bytes with:

```
Content-Type: application/octet-stream        ← never the provider's MIME type (§6.4)
Content-Disposition: attachment
X-Content-Type-Options: nosniff
Cache-Control: no-store
```

- **Outlook** proxies `GET /me/messages/{id}/attachments/{aid}/$value` and pipes
  the response body straight through. No buffering, no base64 — this is exactly
  the path Microsoft recommends for large attachments.
- **Gmail** has no raw endpoint: `messages.attachments.get` returns base64url
  inside JSON. The server must decode (the `Buffer.from(cleanData, 'base64')`
  path inside `decodeBase64Data` is directly reusable per C1 §1) and write the
  `Buffer`. That means **one attachment transiently resident in server memory** —
  bounded by the per-file cutoff of §4, which is one of the reasons that cutoff
  exists.

On the browser side the response streams to disk without buffering:

```js
const res = await fetch(url);
const writable = await fileHandle.createWritable();
await res.body.pipeTo(writable); // pipeTo closes the writable on success
```

**Reuse from the existing code, honestly stated.** `isRateLimitError()`, the
2-second backoff and the single retry in `streamEmailChunks` are exactly the
policy the attachment route needs. Extract them into
`withRateLimitRetry(fn, { provider, label })` in `emailUtils.js` and have both
call sites use it — that is real shared code. `isTokenError()` is reused as-is.
The SSE machinery, the chunking, the filter pass and the auto-exclusion
heuristics are all irrelevant to attachments and are not touched.

### 3.5 Batching, pacing, retries

Orchestration stays **client-side**, because the client is the only side that
holds the index and the only side that can write files. It walks the work list
with:

- **Concurrency 2 for Outlook.** Under the corroborated-but-not-primary
  4-concurrent-per-mailbox limit `[U#6]`, with headroom for the app's other
  calls. If that number is wrong in either direction, 2 is the safe side.
- **Rate-paced for Gmail**, not concurrency-limited: the constraint is 6 000
  units/minute, 20 units per attachment, i.e. ~300/minute theoretical. Target
  50% headroom → one attachment every 400 ms, concurrency 2. A message download
  running concurrently is already spending from the same budget.
- **Retries:** on 429/503, backoff 2 s, one retry (identical to today's policy).
  On failure, `state:"failed"`, `attempts++`, and the item stays in the index.
  The UI offers "Retry".
- **Cancellation:** an `AbortController` per run; the client-disconnect pattern
  from `streamEmailChunks` (`res.req.on('close', …)`) applies to the proxy route
  so an aborted fetch stops the upstream call rather than paying for bytes
  nobody will keep.

**Rate limiting on the routes.** The existing `downloadLimiter` is 3 requests per
minute — it would kill any bulk attachment run instantly. The attachment routes
need their own limiter: **300 per minute per session**, which still bounds abuse
of the proxy while allowing a paced bulk run. Reusing `downloadLimiter` would be
a silent denial of service against the feature.

---

## 4. Disk budget

### 4.1 The problem

C1 finding #4, well-sourced and load-bearing: files written through
`showDirectoryPicker()` to a real user folder are **exempt from the browser's
storage quota system**. `navigator.storage.estimate()` reports nothing about
them. No `QuotaExceededError` arrives before the disk is full. The spec text
itself acknowledges that a site "can fill up a user's disk without being limited
by quota, which could leave a user's device in a bad state."

There is no safety net. One must be built, and it must be built out of numbers
the app already has: the index knows every size before a single byte is fetched.

### 4.2 The two limits

**Per-attachment cutoff — default 10 MB.**

Justification, in order of weight:

1. It bounds the Gmail server-side path. Gmail returns base64 in JSON, so the
   Express process holds one decoded attachment in memory; 10 MB decoded is
   ~13.4 MB of base64 plus the buffer. Unbounded, a handful of concurrent 25 MB
   fetches is a memory incident on a small Railway instance.
2. The size distribution of real mail attachments is extremely long-tailed:
   PDFs, Office documents and photos — the things people actually want back —
   sit overwhelmingly under 10 MB, while the bytes are dominated by a small
   number of videos and archives. Cutting the tail costs few files and most of
   the volume.
3. It bounds a single mistaken click. 25 MB (Gmail's product ceiling `[U#2]`)
   arriving because the user clicked the wrong row is a worse surprise than a
   dialog.

An item above the cutoff is **not hidden**. It is indexed with
`state:"skipped", reason:"too-large"`, displayed with its real size, and
downloadable through an explicit per-item confirmation ("This file is 24.1 MB,
above your 10 MB limit. Download it anyway?"). The default protects; it never
forbids.

**Total ceiling — default 2 GB per account folder.** Configurable:
250 MB / 1 GB / 2 GB / 5 GB / No limit (with a one-time warning).

Justification: 2 GB is negligible next to any modern disk yet high enough that a
user on the on-demand default will never meet it — reaching it requires
deliberate bulk fetching. And it is the same order of magnitude as the JSONL
corpus the app already produces for a large mailbox, so enabling attachments does
not silently multiply the folder's footprint by ten. "No limit" exists because
the archival user is real, and it warns once rather than nagging.

Both settings live in `localStorage` alongside the AI config and panel state
(`aiConfig.js`, `panels.js` set the precedent), keyed per account. The **usage
counters** live in the folder's sync metadata, because they describe the folder,
not the browser.

### 4.3 Enforcement

**Before every write:** `totalBytes + declaredSize > ceiling` → refuse, do not
start the fetch. The check is free because the index has the size.

**After every write:** read back `(await fileHandle.getFile()).size` and store it
as `item.bytes`, then add _that_ to the running total. Declared sizes are
advisory and can be wrong — Gmail's `size` is the decoded part size "encoding
notwithstanding", and Graph explicitly documents `referenceAttachment.size` as
the size of the _metadata_, not the file. The authoritative number is what the
filesystem reports.

**When the ceiling is hit: stop. Never evict.** The app does not delete a user's
files to make room for other files. A bulk run halts and reports "Stopped: 38 of
412 attachments downloaded, storage limit reached (2.0 GB of 2.0 GB)". An
on-demand fetch shows a dialog with two honest options: raise the ceiling, or
open "Manage attachment storage" — a list sorted by size, with per-item delete,
where the _user_ chooses what goes.

**Write failures still happen.** The browser will not raise `QuotaExceededError`
for a picked folder, but the OS write can fail for disk-full, revoked
permission, path too long, or a name colliding with an existing directory. Every
write is wrapped: on failure the partial file is removed via `removeEntry`, the
item becomes `state:"failed"` with the reason, and the user is told which file
and why. Silent failure here is worse than no feature.

### 4.4 Visibility

Usage is not buried in a settings screen. The folder drawer (`#folderSection`)
already shows the selected folder and the download buttons; it gains one line:

```
Attachments   412 files · 700 MB of 2.0 GB   [████████░░░░░░░░]   Manage…
```

using existing tokens (`--text-tertiary`, `--border-light`, `--primary`) and the
existing progress-bar component pattern. The bar switches to the warning token
above 80%. This is the only place the number needs to be, and it is a place the
user already looks before downloading.

---

## 5. Inline images and the CSP

### 5.1 The constraint chain

1. The body renders in an iframe with `sandbox="allow-same-origin"` and **no
   `allow-scripts`**, populated by `document.write()` on an `about:blank`
   document with no `src` and no `srcdoc` (`email-detail.js`, `loadRichBody`).
2. Such a document has no HTTP response of its own, so per the CSP inheritance
   algorithm it **inherits the parent's policy** `[U#8]` — including
   `img-src 'self' data: https:` from `src/app.js`.
3. The attachment bytes live in a folder reachable only through a
   `FileSystemFileHandle`. **They have no URL.** Something must manufacture one.
4. Whatever manufactures it must not require script inside the iframe, because
   there is none and there never will be.

### 5.2 Option A — `data:` URIs

Read the file, base64 it, rewrite `src="cid:x"` into
`src="data:image/png;base64,…"` in the HTML string _before_ `document.write`.

- **CSP change required: none.** `data:` is already in `img-src` today.
- **Unverified platform behaviour relied upon: none.** `data:` URIs in `<img>`
  need no origin check and work in every browser, sandboxed or not.
- Cost: +33% base64 inflation, and the image is held as a JavaScript string
  inside the document string passed to `document.write`.
- Bound on that cost: **inline images are small by nature.** A `cid:` reference
  exists because a sender embedded something meant to render in a mail client —
  signature logos, inline screenshots, chart images. Typical size 5–200 KB.
  Eight of them at 200 KB is ~2.1 MB of base64 in one `document.write`, which is
  unremarkable. The 25 MB video is an _attachment_, and an attachment needs no
  URL in the iframe at all: it goes to disk through the save flow.

### 5.3 Option B — `blob:` URLs

`URL.createObjectURL(file)` in the parent, rewrite `cid:` to the blob URL.

- **CSP change required: add `blob:` to `img-src`** in `src/app.js` —
  `'img-src': ["'self'", 'data:', 'https:', 'blob:']`. That file carries the
  project's `SÉCURITÉ CRITIQUE` markers and any change to it is a
  security-reviewed change.
- **Security cost of that widening, analysed honestly:** it is small, and
  smaller than intuition suggests. The iframe cannot run script, so
  attacker-authored HTML cannot _create_ a blob URL — `createObjectURL` is a
  script API. The only blob URLs that can appear in that document are ones the
  app itself put there. A malicious mail could hard-code a `blob:` string, but
  blob URLs carry a random UUID and are origin-scoped, so guessing one is
  infeasible, and a hit would only load the victim's own image into a frame where
  the attacker has no script to observe it. The real residual is that `img-src`
  applies to the _parent_ page too, which does run script: a hypothetical XSS in
  the parent gains one more image scheme. That attacker already has `https:` —
  the actual exfiltration channel — so the marginal gain is close to zero.
  Notably, on pure CSP hygiene, **`blob:` is a narrower grant than the `data:`
  already in the policy.**
- **But:** C1 `[U#9]` could not confirm that a same-origin blob URL created in
  the parent reliably loads as `<img>` inside _this exact_ construction —
  `allow-same-origin` without `allow-scripts`, no `src`/`srcdoc`, populated by
  `document.write` — across Chrome, Firefox and Safari, and noted that Safari has
  historically imposed extra restrictions on blob URLs in frames. The app is
  Chrome/Edge-only for real use, which narrows the exposure a great deal but does
  not erase it.
- Benefit: no base64 inflation, revocable, better for large payloads.

### 5.4 Option C — a same-origin HTTP URL (named and rejected)

Serve the image from `'self'` so no CSP change is needed and no inflation
occurs. Two sub-variants, both rejected:

- _Express serves it_ — impossible without sending the bytes to the server. The
  folder handle is browser-only. This would invert the architecture for a
  signature logo.
- _A service worker synthesises `'self'` responses from the local files_ —
  technically the cleanest result, and it needs no CSP change at all. Rejected as
  disproportionate: it introduces a service worker with its own lifecycle, scope,
  update and offline semantics into an application that has **no build step** and
  no service worker today, and it intercepts requests for the entire origin. It
  is recorded here as the fallback if both A and B were somehow blocked.

### 5.5 Recommendation

**Option A — `data:` URIs. No CSP change.**

The reasoning is not that `blob:` is unsafe — §5.3 concludes it is nearly free —
but that its advantages do not apply to this payload class, while its costs do:

- Its benefit (avoiding base64 inflation) matters only for large images, and
  inline images are structurally small.
- Its costs are a security-reviewed change to `src/app.js` and a dependency on
  `[U#9]`, an unverified browser behaviour in an unusual iframe construction.
- Choosing A makes `[U#9]` disappear from the critical path entirely. A design
  that removes one of its own unverified dependencies for a cost measured in
  kilobytes should take that trade.

Guardrails on A, since it is not free:

- Per-image cap **2 MB** decoded; above it the `<img>` is replaced by a
  placeholder box with the sanitized display name and a "Save a copy…" action.
- Per-message cap **10 MB** decoded across all inline images; beyond it the
  remaining images become placeholders.
- MIME allowlist (§6.3) — the `data:` media type is taken from the allowlist
  entry, **never** echoed from the provider's `contentType` string.
- Blob URLs used elsewhere in the app (the "Save a copy…" fallback in the
  _parent_ page) are unaffected: `a[download]` is not governed by `img-src`.

**If a later feature does need `blob:`** — larger inline media, or an in-frame
preview — the change is one line in `src/app.js` plus the security review, and
§5.3 is the analysis that review starts from.

### 5.6 The `cid:` rewrite, concretely

Pure function, no DOM, therefore unit-testable without a browser:

```js
inlineCidImages(html, cidMap) → { html, missing: string[] }
```

- Matches `src` attributes whose value begins with `cid:`, case-insensitively,
  in all three quoting forms (`"…"`, `'…'`, unquoted).
- Strips surrounding `<`/`>` if present, and percent-decodes the value (`%40`
  for `@` occurs in real Content-IDs).
- Lookup order: exact match on `cid` → case-insensitive match → match on
  filename (some senders reference `cid:image001.png`). Each fallback is
  recorded so the Phase 0 experiment can measure how often it is needed.
- Unknown cid → the whole `<img …>` element is replaced by placeholder markup.
  It is **not** left as `cid:`, which renders as a broken-image icon today.
- Must not rewrite: `cid:` appearing in text content, in `href`, or in `srcset`.
  A `srcset` containing a `cid:` candidate is stripped rather than
  half-rewritten, because a partially-rewritten `srcset` fails in a way that is
  hard to diagnose.
- Runs **after** the existing regex sanitizer and **before** `document.write`.
  It adds no new sink: the output is still a string written into a no-script
  iframe.

### 5.7 A privacy note worth making explicit

The app today allows `img-src https:`, so remote images in mail load — which
means read receipts and tracking pixels fire. Locally stored inline images fire
nothing. Rendering inline images from disk is therefore **strictly better for
privacy than the behaviour already shipped**, and it makes a future "block remote
images" option viable without breaking most mail rendering, since the images
that matter would already be local. That is a follow-up, not part of this spec.

### 5.8 What must be verified before implementing §5

jsdom does not enforce CSP and does not implement the File System Access API, so
none of this is provable in Jest. See §11 experiment **E1**.

---

## 6. Security

### 6.1 Filename sanitization — two distinct passes

Attachment filenames are fully sender-controlled. Neither provider validates
them. Two different hazards need two different algorithms, and they do not
overlap: a name can be perfectly valid on every filesystem and still be a
display spoof.

#### Pass 1 — `toDiskName(rawName, seq)` → the on-disk name

```js
function toDiskName(rawName, seq) {
  let s = (rawName ?? '').normalize('NFC');

  // 1. Last path segment only — neutralises "../../x", "a/b", "C:\x"
  s = s.split(/[\\/]/).pop();

  // 2. Control characters (C0 + DEL) — forbidden on Windows, hostile everywhere
  s = s.replace(/[\u0000-\u001F\u007F]/g, '');

  // 3. Bidi and invisible characters — spoofing, and they survive copy-paste
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD]/g, '');

  // 4. Characters Windows forbids in a path component
  s = s.replace(/[<>:"|?*]/g, '_');

  // 5. Whitespace normalisation
  s = s.replace(/\s+/g, ' ').trim();

  // 6. "." and ".." and any all-dots name
  if (/^\.+$/.test(s)) s = '';

  // 7. Split base / extension. An "extension" is <= 10 chars, alphanumeric only.
  //    Anything else stays part of the base — "archive.tar.gz" keeps ".gz",
  //    "report.2026 final" gets no extension.
  let base = s,
    ext = '';
  const dot = s.lastIndexOf('.');
  if (dot > 0 && dot < s.length - 1) {
    const cand = s.slice(dot + 1);
    if (/^[A-Za-z0-9]{1,10}$/.test(cand)) {
      base = s.slice(0, dot);
      ext = cand;
    }
  }

  // 8. Windows reserved device names — case-insensitive, with or without an
  //    extension. Windows 11 relaxed this for names with extensions except NUL,
  //    but older Windows and many tools still choke, so prefix all of them.
  if (/^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i.test(base)) base = '_' + base;

  // 9. Trailing dots and spaces — Windows silently strips them, which makes two
  //    different names collide on disk.
  base = base.replace(/[. ]+$/, '');

  // 10. Truncate by CODE POINTS, never by UTF-16 units (a split surrogate pair
  //     yields an invalid name), 80 code points max.
  base = [...base].slice(0, 80).join('');

  // 11. Empty after all that
  if (!base) base = 'attachment';

  // 12. seq prefix makes per-message collisions structurally impossible
  return `${String(seq).padStart(3, '0')}-${base}${ext ? '.' + ext : ''}`;
}
```

Note: `getFileHandle()` rejects names containing `/` on its own, and the File
System Access API takes one path segment per call, which incidentally blocks
some traversal vectors. That is **not** relied upon — C1 found no authoritative
statement that this behaviour is specified as traversal-safe, and the same string
is also used as the suggested name in "Save a copy…", which does reach a real
filesystem path.

#### Pass 2 — `toDisplayName(rawName)` → what the user sees

Applied at every render, independently of pass 1, because the display hazard is
different from the path hazard.

```js
const HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD]/;

function toDisplayName(rawName) {
  let s = (rawName ?? '').normalize('NFC');
  // 1. REMOVE bidi/invisible characters, do not merely wrap them. A wrapped
  //    name still contains U+202E, and it travels on copy-paste into terminals,
  //    tickets and chat windows.
  const hadHidden = HIDDEN.test(s);
  s = s.replace(new RegExp(HIDDEN.source, 'g'), '');
  // 2. Remaining control characters become U+FFFD so the name reads as damaged
  //    rather than silently shortened.
  s = s.replace(/[\u0000-\u001F\u007F]/g, '\uFFFD');
  if (!s.trim()) s = '(unnamed attachment)';
  return { text: s, hadHidden };
}
```

Rendering rules that make the sanitized string actually protective:

1. **`textContent` only. Never `innerHTML`.** Non-negotiable.
2. **The extension is rendered as its own element**, derived from the
   _sanitized_ name, and it is never truncated by ellipsis:
   `[ invoice-march ] [ .exe ] [ 2.1 MB ]`. The U+202E attack works because the
   eye reads the tail of a single string; splitting the tail out and computing it
   after sanitization defeats it even if a hidden character survives.
3. **`hadHidden === true` shows a warning affordance** — "This filename contains
   hidden characters. Shown: `invoice-fdp.exe`." This is the only reliable signal
   for the RTL-override case (MITRE T1036.002) and it costs one boolean.
4. **Double-extension heuristic:** a name matching
   `/\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|txt|csv)\.[a-z0-9]{1,5}$/i` is
   flagged — the second extension is the real one, and this is the classic
   disguise.
5. **Executable-extension warning**, on a static list of dangerous extensions
   (`exe com scr bat cmd ps1 msi vbs js jse wsf hta jar lnk reg dll sh app pkg
dmg`, plus macro-enabled Office `docm xlsm pptm`, plus `iso img vhd` which
   mount and bypass mark-of-the-web). The wording is factual: "This file type can
   run code on your computer." Never "unsafe", never a verdict.

### 6.2 What must never be executed or auto-opened

- **The app never invokes the OS.** A web page cannot, and the app must not
  acquire the ability by growing a native shell. There is no "Open" button. Only
  "Save a copy…".
- **No attachment is ever rendered in the app's own origin.** No `<embed>`, no
  `<object>`, no `<iframe src="blob:…">`, no PDF viewer, no HTML-attachment
  preview. An HTML attachment in particular is a full XSS payload one careless
  `srcdoc` away.
- **The email-body iframe keeps `sandbox="allow-same-origin"` with no
  `allow-scripts`.** Nothing here changes it. The `cid:` rewrite produces a
  string written into that same no-script frame — it adds no sink.
- **Inline rendering is allowlisted by type**, not by the provider's
  `contentType` string (§6.3).

### 6.3 Inline image MIME allowlist

Only `image/png`, `image/jpeg`, `image/gif`, `image/webp` and `image/bmp` render
inline. The `data:` URI's media type comes from the **allowlist entry**, never
from the provider string — so a `contentType` of
`image/png;charset=utf-8,<script>` or any other injection into the URI is
structurally impossible.

`image/svg+xml` is **excluded**. An SVG loaded through `<img>` cannot execute
script in any current browser, so this is defence in depth rather than a known
hole — but SVG has a long history of type-confusion and sniffing bugs, inline SVG
in email is rare, and the cost of excluding it is a placeholder in a rare case.
Anything not on the list becomes a placeholder with a "Save a copy…" action.

### 6.4 A UI that does not imply safety it cannot deliver

The app has no scanner and never will. Therefore:

- No green checks, no "Safe", no "Verified", no "Scanned", no shield icons.
- Type icons are **neutral glyphs by category**, never reassurance.
- The only per-file assertions the UI makes are ones it can actually back: the
  size on disk, the sanitized name, the state, and the type-based warning above.
- The proxy route never echoes the provider's MIME type into `Content-Type`. It
  is always `application/octet-stream` with `nosniff` and
  `Content-Disposition: attachment`, so that even a stray navigation to the route
  cannot get the browser to render attacker content inside the app's origin.

### 6.5 Should attachment bytes pass through the server?

**They must, and the project should say so plainly rather than let the phrasing
imply otherwise.**

The technical reason is not a choice: the provider APIs require the OAuth access
token, which lives in the server session and deliberately never reaches
JavaScript. Sending it to the browser so the page could fetch Gmail directly
would be a strict security regression — a token in JS is a token an XSS can take
— and Gmail's endpoint is not usable from a browser carrying the app's session
anyway. There is no browser-direct path that is not worse.

**Architecturally this changes nothing.** Every email body already flows through
this exact process today. Attachments are more bytes through a pipe that has
carried the mail's contents since the first commit.

**The positioning question is real, and it is Enzo's to answer.** The project's
promise should be stated as:

> Your mail is **never stored** on the server. It passes through it — the server
> is an OAuth proxy holding your tokens — and is written only to the local folder
> you chose.

That is what the code does today and what it would do with attachments. The
weaker phrasing "your mail never touches our server" would be false, and a
privacy-first project that overstates its guarantee has a worse problem than one
that states a modest guarantee precisely. The README and
`docs/PROJECT_OVERVIEW.md` should show the proxy hop explicitly in the
architecture diagram.

Rules that keep the transit claim true:

- Bytes are **streamed** (Outlook) or held for a single decode (Gmail), never
  written to server disk, never cached, never placed in the session.
- **Nothing about an attachment is logged** — not the filename, not the size,
  not the MIME type. Filenames are sender-controlled content; a log line with a
  filename is mail content in a log file. The existing services log message ids
  liberally; the attachment route logs a counter and an error class, nothing
  more.
- `Cache-Control: no-store`, so no intermediary retains a copy.

---

## 7. UI

All existing element ids are preserved; everything below is additive (project
rule 1). All colours come from CSS variables (project rule 3) — the detail modal
is built with inline `style` attributes using `var(--token)`, and new markup
follows that same convention rather than introducing literal colours.

### 7.1 The tree badge

The paperclip already exists: `buildBadge('attachment', badgeX, metaY)` in
`treeRenderer.js` (~line 628), styled by `.node-badge-attachment` /
`.badge-icon`, and `hasAttachments` has been propagated through
`emailAnalyzer_browser.js` into the node objects since commit **f376a76** —
before that the badge never rendered, because the field never reached the node.

Two changes:

**(a) Accuracy — a behaviour change that must be announced.**
`checkForAttachments()` returns `true` for _any_ MIME part with a non-empty
`filename`. Gmail gives inline signature logos a filename (`image001.png`), so —
inferred from the code, not yet measured — every reply in a thread whose
participants have an image in their signature currently shows a paperclip. With
the index, `hasAttachments` becomes
`items.some(i => !i.inline && i.kind === 'file')` and those disappear.

The two providers may also **disagree today**: Graph's `hasAttachments` is
believed to exclude inline attachments, which would make it under-report exactly
where Gmail over-reports. C1 did not verify this; see §11 **E4**. Either way the
index makes both providers mean the same thing, which is worth the change on its
own.

**(b) Optional count.** A count would go inside the existing badge row as text
after the icon, or as a `data-count` attribute rendered by CSS. **It must not add
height.** Tree invariant 1 forbids per-node vertical variance —
`nodeHeightFor()` returns one constant and arrow anchors are `cy = node.y + h/2`.
Width, border, glow and type are the permitted axes. The badge row already
reserves 18 px of horizontal advance per badge; a count uses width only.

### 7.2 Email detail view

A new block in the modal, **after `#emailBody` and before `#replyActionsBar`**:

```html
<div
  id="emailAttachmentsSection"
  style="display:none; margin-top:20px; padding-top:16px;
     border-top:1px solid var(--border-light);"
>
  <div
    style="font-weight:600; color:var(--text-tertiary); margin-bottom:12px; font-size:12px;
              text-transform:uppercase; letter-spacing:0.5px;"
  >
    Attachments
  </div>
  <ul id="emailAttachmentsList" style="list-style:none; margin:0; padding:0;"></ul>
</div>
```

New ids only; nothing is removed or renamed. One row per item:

```
[icon]  invoice-march  .pdf   128 KB   • On disk        [ Save a copy… ]
[icon]  presentation   .pptx  24.1 MB  • Too large      [ Download anyway ]
[icon]  recording      .mp4   180 MB   • Not downloaded [ Download ]
[icon]  Contract       .docx  —        • Fetch failed   [ Retry ]
[icon]  Q3 meeting     —      —        • Embedded Outlook item — cannot be saved
```

- The name uses `toDisplayName()`; the extension is a separate, non-truncated
  element (§6.1 rule 2); the warning affordance appears when `hadHidden` or the
  executable / double-extension heuristics fire.
- State chips use `--text-tertiary` / `--border-light` / the warning token; no
  new colours.
- When the dataset predates the index entirely, the section shows "Attachments
  not indexed for this dataset" with an "Index this message" action (§8) — never
  "No attachments".

### 7.3 Saving a file locally

```js
const handle = await window.showSaveFilePicker({ suggestedName: displaySafeName });
const writable = await handle.createWritable();
await (await localFileHandle.getFile()).stream().pipeTo(writable);
```

`showSaveFilePicker` is available wherever `showDirectoryPicker` is, which the
app already requires (`app.js:41` gates on it). Fallback for the demo/Firefox
path: an `<a download>` on a blob URL — unaffected by `img-src`, since it is the
parent page and not an image load.

### 7.4 Bulk controls

In the folder drawer next to `#downloadEmailsBtn` / `#updateEmailsBtn`:

- the usage bar of §4.4;
- "Download attachments for this subject (12 files, 34 MB)" — bounded,
  comprehensible, and the size is known from the index before anything is
  fetched;
- the download-time toggle "Also fetch attachments", off by default, with the
  estimated volume shown once the index exists.

A global "download every attachment in the mailbox" button is deliberately **not**
the primary affordance. It exists inside "Manage attachment storage" for the
archival user, behind a confirmation showing the total.

---

## 8. Migration

### 8.1 Can an existing dataset be backfilled without re-downloading everything?

**Yes — and this is the most consequential finding of this section.**

### 8.2 What the existing JSONL retains, and what it does not

`formatGmailEmail()` and `formatOutlookEmail()` both keep exactly one
attachment-related field: the `hasAttachments` boolean. The Gmail parts array —
carrying `filename`, `mimeType`, `body.size` and `body.attachmentId`, i.e. every
field the index needs — is walked by `checkForAttachments()` for a truthiness
test and then discarded before the JSONL line is written. The HTML companion
holds only `{ id, bodyHtml }`.

**Missing from disk, for every existing user:** `remoteId` (Gmail `attachmentId`
/ Graph attachment `id`), `name`, `mime`, `size`, `inline`, `cid`, `kind`. That
is all of it. There is nothing to reconstruct from.

### 8.3 What backfill costs, and why it is acceptable

Backfill re-fetches the message _envelope_ — not the bytes — for the messages
that need it, and `hasAttachments` on disk makes the targeting exact:

| Step   | Gmail                                                     | Outlook                                             |
| ------ | --------------------------------------------------------- | --------------------------------------------------- |
| Select | scan `gmail_emails.jsonl`, keep `hasAttachments === true` | same on `outlook_emails.jsonl`                      |
| Fetch  | `messages.get(id, format:'full')` — 20 units each         | `/messages/{id}/attachments?$select=…` or `$expand` |
| Write  | append a line to `gmail_attachments.jsonl`                | same                                                |

Worked example: a 20 000-message mailbox with a 15% attachment rate is 3 000
Gmail calls = 60 000 quota units. Against the 6 000 units/minute per-user ceiling
and paced at 50% headroom, that is roughly **ten minutes in the background**,
resumable, and it fetches **zero attachment bytes**. This is not "re-download
everything" — it is 15% of the envelopes and none of the payloads.

Backfill is resumable by construction: the index is JSONL, appended per message,
so an interrupted run restarts from the ids not yet present. It runs at low
priority behind an explicit "Index attachments for existing emails (about N
messages, ~M minutes)" action. It is never automatic — it spends the user's API
quota.

Caveat carried forward: today's `hasAttachments` over-reports for Gmail (§7.1),
so the backfill set is slightly larger than necessary. Harmless — the extra
messages simply index to zero non-inline items, which corrects the boolean as a
side effect.

### 8.4 Two things the user must be told

1. **Attachments are only retrievable while the message still exists upstream.**
   A message deleted from the mailbox since download returns 404 on backfill; the
   item is marked `state:"unavailable"` and the run continues. Those bytes are
   gone and the app never had them. This is the honest cost of the on-demand
   default, and it is precisely why the opt-in bulk mode exists (§3.3).
2. **Provider ids may not be eternal.** Gmail's `attachmentId` is widely reported
   to be stable per message but is **not documented as stable**, and the same
   holds for Graph attachment ids. The design therefore never treats `remoteId`
   as the only path to the bytes: each item also carries `id` (the message),
   `seq` and `name`, which are enough to re-derive the id with one
   `messages.get`. A 404 on fetch triggers exactly that re-derivation and updates
   the index. The index is self-healing, and the stability question is removed
   from the critical path — but it still deserves the experiment in §11 **E3**,
   because a _systematically_ expiring id would double the cost of every
   deferred fetch.

---

## 9. Testing

`npm test` runs Jest under `--experimental-vm-modules`, with backend tests in
CommonJS and front-end ES modules loaded through dynamic `import()` or the
`vm`-based loader proven in `tests/frontend/demoMode.test.js`.

### 9.1 Testable without a browser — and these are the ones that matter

| Target                                               | Where                                                                                                  | Why it is worth the test                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `toDiskName` / `toDisplayName`                       | `tests/backend/attachmentNames.test.js` (pure shared module, like `quoteStripper.js`)                  | Pure functions guarding a security property. Table-driven, cheap, exhaustive.                               |
| `extractAttachmentIndex(payload)` (Gmail)            | extends `tests/backend/gmailService.test.js` — the module already exports `formatGmailEmail` for tests | Fixture payloads are the only way to pin down the inline/attachment split                                   |
| Outlook attachment mapping                           | extends `tests/backend/outlookService.test.js`                                                         | `itemAttachment` / `referenceAttachment` must index, not crash                                              |
| `inlineCidImages(html, map)`                         | `tests/frontend/inlineCid.test.js`                                                                     | Pure string function; the whole §5 mechanism minus the browser                                              |
| Index read / append / filter-by-id / byte accounting | `tests/frontend/attachmentIndex.test.js`, against an in-memory handle fake                             | **The single highest-value suite.** The deletion path is where this design could silently destroy user data |
| Budget arithmetic                                    | same suite                                                                                             | Ceiling hit mid-run, declared-vs-actual size mismatch, decrement on delete                                  |
| Proxy routes                                         | `tests/backend/attachmentRoutes.test.js`                                                               | `requireAuth`, `application/octet-stream`, `nosniff`, clean 404, **and that no filename is logged**         |
| `folderResolver` non-regression                      | extends `tests/frontend/folderResolver.test.js`                                                        | Assert `gmail_attachments.jsonl` does **not** satisfy `/_emails\.jsonl$/i`                                  |

Sanitizer cases that must be in the table, not sampled: `..`,
`../../etc/passwd`, `a/b`, `C:\Windows\x`, `NUL`, `nul.txt`, `CON`, `com9.pdf`,
`report.pdf.`, `report.pdf   `, `invoice\u202Efdp.exe`, `\u202Ainvoice`, a
300-character name, a name that is only dots, the empty string, an
emoji/astral-plane name (truncation must not split a surrogate pair), two
identical names in one message, `archive.tar.gz`, and a name whose extension is
20 characters long.

The handle fake already exists in embryo: `makeDir()` in
`folderResolver.test.js`. It needs `createWritable()`, `removeEntry()` and
`entries()`, and should move to a shared `tests/helpers/fakeFs.js` rather than
being copied — copying test infrastructure is how
`tests/frontend/progressiveLoading.test.js` ended up duplicating the code it
claims to test (`docs/specs/2026-08-25-oss-repo-design.md` §6.2). **Do not extend
that pattern.** New front-end logic must be importable and tested against the
real module.

### 9.2 Not testable without a real browser — say so, do not fake it

jsdom enforces no CSP, implements no File System Access API, and its `Blob` does
not implement `.stream()` (a limitation `demoMode.test.js` already documents).
The following need a manual checklist, run in Chrome **and** Edge:

1. Whether a `data:` image actually renders inside the `document.write` iframe
   under the inherited CSP (§11 **E1**).
2. `showSaveFilePicker` and the real permission prompts.
3. Writing a 10 MB binary through `createWritable()` into a real folder, and what
   the OS does when the disk is genuinely full.
4. Real-Windows path length and reserved-name behaviour — the handle fake accepts
   anything, a real NTFS volume does not.
5. Rendering fidelity of inline images in real mail from real senders.

The deliverable is a short scripted checklist in `docs/`, run before each phase
ships. Adding Playwright for this alone is disproportionate to a project with no
browser-test infrastructure today; if Playwright arrives later for other reasons,
items 1, 2 and 5 are the first to migrate.

---

## 10. Phased plan

Each phase delivers something usable alone, and each is worth shipping even if
the next never lands.

### Phase 0 — Verification spike · **0.5–1 day**

Not a user-visible deliverable, but nothing below is safe without it. Run
experiments **E1–E5** (§11) against real mail in Chrome and Edge, and write the
results back into this document.

**Risk that could sink it:** E1 fails and `data:` does not render as expected,
forcing the `blob:` path — a security-reviewed CSP change plus the `[U#9]`
uncertainty (+1 day, and a review). Or E3 shows Gmail `attachmentId` values
expire systematically, which makes every deferred fetch cost an extra
`messages.get` and materially changes §3's economics.

### Phase 1 — Index only, no bytes · **3–4 days**

Gmail and Outlook attachment indexing, `<provider>_attachments.jsonl`, the
corrected `hasAttachments`, the attachment list in the detail modal showing
name/type/size with "not downloaded", and deletion-path consistency.

**Usable alone:** the user finally sees _what_ is attached to every message
without downloading a byte, and the tree badge stops lying. Best value per day in
the whole plan.

**Risk:** the Outlook index is not free. If `$expand` (§3.2 strategy A) does not
behave, every Outlook download grows by one request per attachment-bearing
message, which is a visible slowdown on a pipeline that is already serial.
Mitigation: gate the Outlook index behind the same opt-in as bytes if the
measurement is bad.

### Phase 2 — On-demand bytes + disk budget · **4–6 days**

Proxy routes with their own rate limiter, streaming write to disk, both
sanitization passes, budget accounting and the usage UI, "Save a copy…", and
`gcOrphanAttachments`.

**Usable alone:** the feature people actually asked for.

**Risk:** this is where user data gets corrupted. The temp-swap deletion path is
already fragile (§2.6) and now has a second store to keep consistent. The
mitigation is the index-first ordering plus the test suite of §9.1 — and neither
is optional.

### Phase 3 — Inline images · **2–3 days**

`cid` map in the index, `inlineCidImages()` before `document.write`,
placeholders, MIME allowlist, per-image and per-message caps, the "load inline
images automatically" setting.

**Usable alone:** HTML mail stops showing broken-image icons where the sender put
a logo or a screenshot.

**Risk:** it touches the security-critical rendering path, so it needs its own
review even though it adds no new sink. Add **+1 day and a CSP review** if Phase
0 forced the `blob:` route.

### Phase 4 — Bulk and backfill · **3–4 days**

Opt-in "fetch attachments during download", "download attachments for this
subject", backfill of pre-existing datasets gated on `hasAttachments`,
concurrency and pacing, resumability.

**Usable alone:** archival use, and it is the phase that makes the feature
retroactive for existing users.

**Risk:** quota. A user with a large attachment-heavy mailbox can exhaust the
Gmail per-user limit and find the _whole app_ rate-limited, not just this
feature. Pacing must be conservative and visible, and the run must be pausable.

### Total

**13–19 working days** of implementation, i.e. **3–4 calendar weeks** with review
and the inevitable Windows filename surprises. Phase 0's fallout is excluded
because it is not yet knowable.

---

## 11. Open questions

Nothing here is papered over. Items marked **→ Enzo** are product or positioning
decisions that no amount of further research resolves.

### Experiments to run before writing code (Phase 0)

**E1 — Does a `data:` image render inside the body iframe?**
Build a page reproducing `loadRichBody` exactly (`sandbox="allow-same-origin"`,
no `src`, `document.write`) under the real helmet CSP, write an
`<img src="data:image/png;base64,…">` into it, and confirm it paints in Chrome
and Edge with no CSP violation in the console. Also test the `blob:` variant, so
the fallback's viability is known rather than assumed. This settles `[U#8]` and
`[U#9]` for this codebase, which is the only place they matter. **Blocks §5.**

**E2 — When does Gmail populate `attachmentId` versus inlining `data`?**
`[U#1]` — the docs describe the mechanism but publish no byte threshold. Dump the
part tree of 20–30 real messages with attachments of varied sizes and find where
the switch happens. Determines whether the "small part with `data` and no
`attachmentId`" case is common enough to need its own write path.
**Blocks §3.2.**

**E3 — Are Gmail `attachmentId` values stable across sessions and over time?**
Record ids for 10 messages, re-fetch after 24 h, after 7 days, and after a token
refresh. The design is self-healing either way (§8.4) but the answer decides
whether deferred fetching costs one call or two. Same question for Graph
attachment ids. **Affects §3, §8.**

**E4 — What does each provider's `hasAttachments` actually count?**
Confirm the inferred Gmail over-reporting (inline signature logos carrying
filenames), and test whether Graph's `hasAttachments` excludes inline
attachments — which would make the two providers disagree in opposite
directions. **Blocks the §7.1 behaviour change** and determines what has to go in
the changelog.

**E5 — Does `$expand=attachments($select=…)` actually avoid the second Graph
call, and at what cost?** `[U#7]` — no documented limit was found. Measure
response size and latency on messages with 1, 5 and 20 attachments, and check
whether it counts differently against throttling. **Decides §3.2 A vs B.**

**E6 — Re-verify the Graph Outlook throttling row.** `[U#6]` — the
4-concurrent-per-mailbox figure comes from Microsoft Q&A, not the primary
throttling-limits table, which C1 could not load. Concurrency 2 is safe under any
plausible value, so this is a "before optimising" question, not a blocker.

**E7 — Does Graph's `fileAttachment.contentId` equal the MIME `Content-ID` used
in `cid:`?** `[U#4]` — the official description says only "the ID of the
attachment in the Exchange store". If it does not, Outlook inline images need a
different mapping (probably parsing `Content-ID` out of
`internetMessageHeaders`, which the app already requests). **Blocks §5 for
Outlook only** — Gmail can ship first.

### Decisions that need Enzo

**Q1 — Is on-demand the right default, or should attachments come down with the
mail? → Enzo.** On-demand protects quota and disk; download-time guarantees the
archive. This spec picks on-demand with an opt-in bulk mode, but a user who sees
Mail Workflow as an archival tool would reasonably want the opposite default.
**This is the single decision that most changes the feature.**

**Q2 — Is the "server transit" framing acceptable, and does the README change?
→ Enzo.** §6.5. Attachment bytes must pass through Express. The wording should
become "never _stored_ on the server". This is positioning as much as
engineering, and getting it wrong in either direction — overclaiming, or
frightening users about a hop that already exists for every email body — is
costly.

**Q3 — Are 10 MB per file and 2 GB total the right defaults? → Enzo.** §4.2
justifies them, but they are judgement calls about a user base that does not
exist yet.

**Q4 — Should the corrected `hasAttachments` (§7.1) be a fix or an option?
→ Enzo.** It changes what existing users see on trees they already know. This
spec treats it as a fix with a changelog entry. If E4 shows the current behaviour
produces paperclips on most nodes, the change will be very visible.

**Q5 — Should inline images be fetched automatically when a message is opened?**
This spec says yes (default on, revocable): they are part of reading the
message, they cost one small fetch, and unlike the remote images the app
_already_ loads they leak nothing (§5.7). But it does spend quota on what the
user experiences as a passive action.

**Q6 — What happens to attachments when the user changes their download
filters?** A filter change today triggers a full re-download in overwrite mode.
Should the existing `attachments/` tree be preserved (and reconciled against the
new index) or wiped? Preserving risks a large orphan set; wiping discards bytes
the user may have paid quota for. The GC pass makes preserving viable, but the
reconciliation has not been designed.

**Q7 — Content-hash deduplication.** Explicitly a non-goal (§1.2). Worth
revisiting only if real usage shows the same files stored many times, and it
would need reference counting to avoid one message's deletion breaking another's
attachment.

**Q8 — Should `itemAttachment` be expanded rather than merely flagged?** A Graph
`itemAttachment` can be another message, which this app could in principle render
as an email. Attractive, and entirely out of scope here.

**Q9 — What is the story for demo mode?** The fixture has two emails flagged
`hasAttachments` and no attachment data. Phase 1 makes that inconsistent — either
the fixture gains an index with `state:"skipped"` items, or demo mode shows "not
indexed". The second is less work and honest; the first demonstrates the feature
to a visitor who will never connect an account, which is the entire purpose of
demo mode.
