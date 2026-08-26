# The on-disk data format

**Who this is for:** anyone who wants to know exactly what Mail Workflow writes
to their disk before pointing it at their mailbox — and anyone writing code that
reads or produces those files.

Mail Workflow has no database and no server-side storage. Everything it keeps
lives in a folder **you** pick with the browser's directory picker, in plain
text you can read, grep and back up without the app.

---

## 1. Folder layout

```
<the folder you picked>/
  EmailWorkflow/
    <userId>/                          userId = your email address
      gmail_emails.jsonl               one JSON object per line — the main store
      gmail_emails_html.jsonl          HTML bodies, keyed by email id
      gmail_sync_metadata.json         last sync date, filters used, total count
      gmail_groups.json                subject groups and favourites
      outlook_emails.jsonl             same four files per provider
      outlook_emails_html.jsonl
      outlook_sync_metadata.json
      outlook_groups.json
```

`<userId>` is literally your email address (`alice@example.com`), used as the
directory name. The same address is the IndexedDB key for the folder handle and
the `?email=` URL parameter — there is no numeric user id anywhere in the app.

Connecting two accounts creates two sibling directories under `EmailWorkflow/`.
Connecting Gmail and Outlook on the same address puts both providers' files side
by side in one directory; they never share a file.

### Tolerant folder resolution

Historically the picker required the *exact* root, and picking one level too
deep silently produced an empty app. `src/public/js/folderResolver.js` now
accepts any of the three plausible levels and always returns the **same** data
directory, so reads, downloads, syncs and cleanups agree:

| You pick | Resolved data folder |
|---|---|
| the root that contains `EmailWorkflow/` | `<root>/EmailWorkflow/<userId>` |
| the `EmailWorkflow/` folder itself | `<root>/<userId>` |
| the account folder directly | `<root>` itself — recognised when its name equals `<userId>`, **or** when it directly contains any `*_emails.jsonl` |
| none of the above, first download | creates `<root>/EmailWorkflow/<userId>` |

The last row only happens with `{ create: true }`, which only the download path
passes. Readers use `{ create: false }` and fail loudly rather than silently
creating an empty tree in the wrong place.

`resolveUserFolderHandle(rootHandle, userId, opts)` is a pure function — the root
handle is a parameter, not module state — which is why it is unit-tested without
a DOM in `tests/frontend/folderResolver.test.js`.

---

## 2. The files, one by one

### `<provider>_emails.jsonl` — the main store

One JSON object per line, newline-terminated, UTF-8. This is the only file the
analysis reads. It is written **append-only** during an incremental sync and
rewritten in full on a first download or a filter change (see §5).

### `<provider>_emails_html.jsonl` — the HTML companion

One object per line, `{"id": "...", "bodyHtml": "..."}`. Only emails that
actually have an HTML body get a line here, so this file usually has fewer lines
than the main one, and the two are **not** positionally aligned — `id` is the
join key.

**Why the split.** The rendered HTML body is by far the largest field in a mail
record — frequently 10-50x the plain text. Every global pass (subject
extraction, deduplication, sync) reads the whole main file, and carrying HTML
through those passes was the direct cause of browser out-of-memory crashes on
mailboxes of a few thousand messages. Splitting it out means the main file stays
small enough to stream repeatedly, and the HTML is fetched lazily: opening one
email streams the companion file and stops at the first matching id
(`loadBodyHtmlForEmail` / `scanHtmlCompanionForEmail` in `emails.js`).

A JSONL written by an older version, with `bodyHtml` inline, is migrated
automatically on first use by `migrateJsonlIfNeeded()` — it detects the old shape
by parsing the first line, then rewrites the main file and extracts the HTML into
the companion.

### `<provider>_sync_metadata.json`

Pretty-printed JSON, rewritten on every download and sync.

```json
{
  "lastSyncDate": "2026-02-22T10:30:00.000Z",
  "lastInternalDate": "1740218400000",
  "totalEmails": 1843,
  "filtersUsed": {
    "excludeNotifications": true,
    "notificationKeywords": ["noreply", "no-reply"],
    "excludePromotional": true,
    "promotionalKeywords": ["newsletter", "promo"],
    "blacklistedSenders": [],
    "blacklistedKeywords": []
  },
  "provider": "gmail",
  "bootstrapped": true
}
```

| Field | Meaning |
|---|---|
| `lastSyncDate` | ISO 8601 timestamp of the last successful write. Informational |
| `lastInternalDate` | The highest `internalDate` seen, as a **string of milliseconds**. This is the incremental-sync watermark: the next sync asks the provider only for messages after it |
| `totalEmails` | Running count of lines in the main JSONL |
| `filtersUsed` | The exact filter set the file was downloaded with. If the current filters differ, the sync forces a full re-download rather than mixing two filter regimes in one file |
| `provider` | `"gmail"` or `"outlook"` |
| `bootstrapped` | Present and `true` only when the metadata was reconstructed from an existing JSONL by `bootstrapSyncMetadata()`, without re-downloading anything |

Deleting this file is safe: the next sync rebuilds it from the JSONL.

### `<provider>_groups.json`

Your organisation of the subject list. No mail content, only keys.

```json
{
  "version": 1,
  "groups": [
    { "id": "grp_1740218400000", "name": "Migration", "parentId": null, "order": 0, "color": "#ef4444" }
  ],
  "subjectMemberships": [
    { "subjectKey": "q3 platform migration", "groupIds": ["grp_1740218400000"] }
  ],
  "favoriteSubjects": ["q3 platform migration"],
  "favoriteGroups": ["grp_1740218400000"]
}
```

- `parentId: null` is a root group; a non-null `parentId` is a sub-group. The
  hierarchy is capped at two levels — `createGroup()` throws beyond that.
- One subject can belong to several groups: `subjectMemberships` holds **one
  entry per subject** with a `groupIds` array.
- `color` is `null` by default; when set, it tints the group's inline SVG folder
  icon via `currentColor`.
- `subjectKey` is the normalised subject (leading `Re:` / `Fwd:` stripped,
  trimmed), matching what `emailAnalyzer_browser.js` produces.

### Temporary files

Rewrites go through a sibling temp file and never edit in place. If you find one
of these left behind, a write was interrupted and it is safe to delete:

`<file>.temp` (download, overwrite mode) · `<file>.cleanup.temp` (subject
deletion) · `<file>.migrate.temp` (old-format migration).

---

## 3. The JSONL record, field by field

Every line is produced by `formatGmailEmail()` (`src/services/gmailService.js`)
or `formatOutlookEmail()` (`src/services/outlookService.js`) — deliberately the
**same shape** for both providers, so the entire client pipeline is
provider-agnostic — and then written by `downloadEmails()`
(`src/public/js/emails.js`) with `bodyHtml` removed.

| Field | Type | Description |
|---|---|---|
| `id` | string | The provider's internal message id. Gmail: `17abc…`. Outlook: `AAMkADAwATM0…`. This is the id used for every API call back to the provider, and the join key for the HTML companion file |
| `threadId` | string | Provider-side conversation id. Gmail `threadId`; Outlook `conversationId` |
| `snippet` | string | Short preview supplied by the provider (Gmail `snippet`, Outlook `bodyPreview`) |
| `subject` | string | Raw subject line, `Re:`/`Fwd:` prefixes **not** stripped |
| `from` | string | `"Display Name <address@example.com>"` |
| `to` | string | Recipients joined with `", "` — a single string, not an array |
| `cc` | string | Same encoding as `to`; empty string when there are none |
| `date` | string | The header date as the provider gives it. Gmail: RFC 2822 (`Mon, 3 Mar 2025 08:00:00 +0000`). Outlook: ISO 8601 (`sentDateTime`, falling back to `receivedDateTime`). Human-facing only — sorting uses `internalDate` |
| `messageId` | string | The RFC 5322 `Message-ID`, angle brackets included: `<abc@mail.example.com>`. **Not** the same thing as `id` |
| `inReplyTo` | string | The RFC `In-Reply-To` header — the `messageId` of the parent message. Empty string when absent |
| `references` | string | The RFC `References` header: the ancestor `messageId`s, space-separated, oldest first |
| `internalDate` | string | Milliseconds since the Unix epoch, **as a string**. Gmail supplies it directly; Outlook derives it from `sentDateTime`. Always `parseInt()` before comparing, and never mistake it for seconds |
| `hasAttachments` | boolean | True when the message carries at least one attachment. Attachments themselves are **not** downloaded — only this flag. See [ROADMAP.md](../../ROADMAP.md) |
| `bodyText` | string | Plain-text body, **quote-stripped**: `stripQuotedText()` (`src/services/quoteStripper.js`) removes the quoted history before writing. For an HTML-only message the text is derived from the HTML |

**Not in this file:** `bodyHtml` (in the companion), and `labelIds`,
`sizeEstimate`, `historyId` — Gmail fields the app fetches but does not use, and
destructures away at write time.

### An example record

```json
{
  "id": "5561983caf66db1d",
  "threadId": "b72a1e83301c5f08",
  "snippet": "Thanks Maya. My three worries, in order: 1. The ingestion pipeline still writes…",
  "subject": "Re: Q3 platform migration - kickoff and open questions",
  "from": "Theo Reyes <theo.reyes@example.org>",
  "to": "Demo User <demo@example.com>, Maya Oberon <maya.oberon@example.com>",
  "cc": "",
  "date": "Mon, 3 Mar 2025 08:47:00 +0000",
  "messageId": "<5561983caf66db1d.01.b72a1e83301c5f08@mail.example.com>",
  "inReplyTo": "<b72a1e83301c5f08.00.b72a1e83301c5f08@mail.example.com>",
  "references": "<b72a1e83301c5f08.00.b72a1e83301c5f08@mail.example.com>",
  "internalDate": "1740991620000",
  "hasAttachments": false,
  "bodyText": "Thanks Maya. My three worries, in order:\n\n1. The ingestion pipeline still writes directly to the legacy schema…"
}
```

Real records in this exact format ship with the repository, as the demo fixture:
`src/public/demo/gmail_emails.jsonl` and its companion
`src/public/demo/gmail_emails_html.jsonl`. The dataset is entirely fabricated —
no real mail was anonymised — and `npm run demo` runs the whole app against it.

---

## 4. Which fields build the conversation tree

The tree is the point of the app, so it is worth being precise about which
fields it actually depends on. `createTemporalGroupTree()` in
`src/services/emailAnalyzer_browser.js` builds the `{nodes, links}` graph like
this:

1. **`subject`** selects the thread. Messages are grouped by subject with
   `Re:`/`Fwd:` stripped, and a subject needs at least **3** messages to appear
   in the list at all.
2. **`internalDate`** orders them. It is parsed to a `Date` and the messages are
   sorted ascending; the earliest becomes the root, and a node's index is its
   position in that chronology. The horizontal axis of the tree *is* this
   ordering.
3. **`from` + `to` + `cc`** form each message's participant set. The parent of a
   message is, first choice, the most recent earlier message with an **identical**
   participant set. This is what makes a side-conversation between two people
   branch away from the main thread instead of hanging off it linearly.
4. **`inReplyTo` → `messageId`** is the fallback when no earlier message shares
   the participant set: the parent is looked up by `messageId` in an index of
   the thread. This is the classic RFC threading link.
5. Anything still unattached links to the root.

Two fields commonly assumed to drive the topology **do not**:

- **`references`** is stored, but the tree builder never reads it. It exists so
  that `reply.js` can send a correctly threaded reply (`References:` header).
- **`threadId`** is stored, but grouping is by normalised subject, not by
  provider thread id. `threadId` is passed back to Gmail when sending a reply so
  the provider files it in the right conversation.

The practical consequence: threading degrades gracefully. Outlook does not
always return `internetMessageHeaders`, so `inReplyTo` can be empty for
Exchange-native messages (Teams notifications, calendar invites) — the tree still
builds from subject, chronology and participants. See
[outlook-implementation.md](../internal/outlook-implementation.md).

---

## 5. How the files are written

**During a download, the main JSONL is append-only.** Emails arrive over SSE in
chunks of 500 and each one is serialised and written the moment it arrives; the
app never holds the whole mailbox in memory. Two modes:

- **Incremental sync (append).** The existing file is opened with
  `createWritable({ keepExistingData: true })` and the writer seeks to
  `file.size` before writing. New lines go on the end; nothing already on disk is
  touched. The HTML companion is opened in the same mode at the same time.
- **First download, or filters changed (overwrite).** Output goes to
  `<file>.temp`, and only once the stream completes is the temp copied over the
  real file and deleted. An interrupted download therefore leaves your previous
  JSONL intact.

A **filter change forces the overwrite path**. Mixing two filter regimes in one
file would make its contents unexplainable, so `syncEmails()` compares the
current filters against `filtersUsed` in the metadata and re-downloads in full
when they differ.

**Deletion rewrites the file through a temp file.** Excluding a subject
(`cleanupExcludedSubjectFromJSONL`, and its batch form
`cleanupExcludedSubjectsFromJSONL`) streams the JSONL line by line, writes the
lines it keeps into `<file>.cleanup.temp`, then removes the original, copies the
temp back under the real name and deletes the temp. The same pass is then run
over the HTML companion, dropping the ids that were removed. There is no rename
in the File System Access API, hence the copy. Malformed lines are always kept
rather than silently dropped.

**One writer at a time.** Two concurrent writable streams on the same file can
corrupt it. Every write path in the app opens exactly one.

---

## 6. Your data is yours

These are plain text files in a folder you chose. Nothing about them is specific
to this app:

- **Greppable.** `grep -c '' gmail_emails.jsonl` counts your messages;
  `grep '"hasAttachments":true' gmail_emails.jsonl` finds the ones carrying
  attachments.
- **Portable.** Copy the folder to another machine, point the app at it there,
  and it picks up where it left off — including the sync watermark. Or never
  open the app again and the files still make sense.
- **Scriptable.** Every line is one self-contained JSON object, so any JSONL
  tool works:

```bash
# Who wrote the most emails?
jq -r '.from' gmail_emails.jsonl | sort | uniq -c | sort -rn | head
```

- **Deletable.** Deleting the folder deletes everything the app ever kept about
  your mail. There is no server-side copy to also delete, no cache, and no
  account to close.

The only state living outside that folder is the browser's IndexedDB entry
(`EmailWorkflowDB` → `folderHandles`) holding the permission handle to the
folder itself, and your AI provider key in `localStorage` if you configured one.
Clearing the site's data removes both, and costs you nothing but re-picking the
folder.
