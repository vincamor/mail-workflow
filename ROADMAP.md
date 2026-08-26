# Roadmap

What is actually planned, what is merely under consideration, and what is
known-broken. Nothing here is a promise of a date.

Everything on this page is derived from work already recorded in the repository:
the release design spec
([docs/specs/2026-08-25-oss-repo-design.md](docs/specs/2026-08-25-oss-repo-design.md)),
the attachment research
([docs/design/attachments-research.md](docs/design/attachments-research.md)),
and defects found while preparing the open-source release. Ideas nobody has
committed to are not listed.

Legend: **Decided** — agreed, sequenced, and being executed.
**Considered** — a real option with real analysis behind it, but no commitment.
**Known defect** — a bug that exists today and is not yet fixed.

---

## Decided

### English migration — the release blocker

The user interface, code comments, logs and AI prompts are still in French. The
documentation is already English. Shipping an English README over a French UI
would destroy the credibility the release is meant to build, so the repository
stays **private until this is done**.

The decision is a **direct replacement, with no i18n layer**. It is the simplest
thing to maintain, and the accepted cost is explicit: the French UI is retired,
and reintroducing it later means paying for string extraction again.

Measured scope: roughly 250–400 user-visible strings and about 600 French
comments and log lines across 36 files.

Sequencing that is not negotiable:

1. **Prettier runs once, as its own commit, first.** Mixing a reformat with a
   36-file translation produces an unreviewable diff.
2. **A terminology glossary (`docs/internal/glossary.md`) is written before the
   translation starts.** Without it, ten parallel contributors render *sujet* as
   *subject*, *topic* and *thread* in ten different files. The glossary does not
   exist yet, and it blocks everything after it.
3. **The AI prompts go last, and carefully.** Translating a prompt changes model
   behaviour, and `tests/backend/aiFilterPrompts.test.js` asserts on prompt
   content. The test gets updated deliberately, not mechanically.

### v1.0.0 and going public

After the migration: screenshots of the English UI, README illustration, a
`v1.0.0` tag, a GitHub Release, and switching the repository to public. The
flagship demo thread in `src/public/demo/` exists specifically to be the README
screenshot.

---

## Considered

### Attachment support

Currently the app records **whether** a message has attachments
(`hasAttachments` in the JSONL) and nothing more. No bytes are downloaded.

Research is complete —
[docs/design/attachments-research.md](docs/design/attachments-research.md) — and
it is deliberately research only: verified API facts, no design decisions. The
decision to build comes after a full design spec, not before. What the research
already establishes as constraints:

- **Listing attachments is free.** The Gmail fetch already uses `format: 'full'`,
  so filename, MIME type, size and `attachmentId` are present at no extra quota
  cost.
- **Downloading bytes is not free.** `messages.attachments.get` costs the same
  20 quota units as fetching an entire message, so a bulk download roughly
  doubles Gmail quota consumption. "Index what exists" and "fetch the bytes"
  have to be separable operations.
- **Outlook needs two code paths by size.** Small attachments can ride along as
  `contentBytes`; large ones must use the raw `/$value` endpoint, per
  Microsoft's own performance guidance.
- **There is no browser-level disk safety net.** Files written to a real
  user-picked folder are exempt from the storage-quota system, so
  `navigator.storage.estimate()` tells you nothing. Any overrun protection has
  to be built by hand.
- **Showing inline images may require a CSP change.** The current `img-src`
  allows `'self'`, `data:` and `https:` but not `blob:`. Any widening is a
  security-relevant change to the sandboxed email-body iframe and must be
  reviewed as one.

### Faster subject selection

Two long-standing gaps, both about the same thing — the app re-reads the whole
JSONL more often than it needs to:

- **Byte-offset indexing.** `getEmailsForSubjectOptimized` reads the entire file
  on every subject selection. An index of line offsets per subject would make it
  a seek.
- **A subject cache.** `autoAnalyzeConversations` re-reads the whole file on
  every call.

Both are real wins on large mailboxes and neither is scheduled. The constraint
to respect is that the current design deliberately uses **one stream at a time**;
an earlier multi-stream chunk-index attempt is exactly what caused the bug that
the single-read approach fixed.

### Two ignored parameters

`loadEmailsFromHandle(fileHandle, _chunkSize)` and
`createCompleteVisualization(tree, _options)` both have call sites passing real
values for parameters the function body never reads. Callers believe they are
configuring something that is ignored.

Left alone on purpose: honouring them would change runtime behaviour, so it
belongs in its own reviewed change rather than being folded into cleanup.

---

## Known defects

### A front-end test duplicates the code it claims to test

`tests/frontend/progressiveLoading.test.js` does not import
`src/services/emailAnalyzer_browser.js`. It **inlines a copy** of that module's
functions, with a comment claiming the ES module cannot be required directly in
Jest.

The consequence is worse than no test: it can stay green while the real analyser
is broken. Since `emailAnalyzer_browser.js` produces the `{nodes, links}` shape
the entire visualisation depends on, this is the least-covered critical path in
the project, despite appearances.

The premise is also now disproven. `tests/frontend/demoMode.test.js` loads the
**real** module and runs the demo fixture through it, under the project's
`--experimental-vm-modules` setup. The fix is therefore to rewrite
`progressiveLoading.test.js` against the real module the same way — not to add
another parallel copy.

---

## Explicit non-goals

These have been decided against, with reasons. Proposing them again needs a new
argument, not a repeat of the old one.

- **Docker.** The app requires Chrome/Edge on the client and a writable local
  folder either way. Containerising the Express server removes neither friction.
- **An interactive `postinstall`.** It breaks `npm ci`, CI and unattended
  installs. Instead, `npm start` detects a missing `.env` and points at
  `npm run setup`.
- **Publishing to npm (`npx mail-workflow`).** The project is meant to be cloned
  and modified — filters, themes, prompts. An npm package would imply a frozen
  tool that this is not.
- **An i18n layer.** See the English migration above: direct replacement,
  accepted cost.

---

## Recently done

For context on how the current state was reached, the release spec's section 7
records what shipped and when. Highlights of the work already landed: the
`npm run setup` and `npm run doctor` scripts, demo mode with a fabricated
dataset that runs on any browser, CI hardening with CodeQL and Dependabot, the
OAuth provider setup guides, an ESLint and Prettier baseline, all npm audit
advisories resolved, and four latent application bugs fixed — among them
`OUTLOOK_TENANT_ID`, which was documented but silently ignored, sending
single-tenant Entra users to the wrong authority.
