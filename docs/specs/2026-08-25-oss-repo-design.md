# Open-source release — design spec

**Date:** 2026-08-25
**Status:** approved, in execution
**Repository:** https://github.com/vincamor/mail-workflow

---

## 1. Goal

Turn Mail Workflow from a local project into a public repository that anyone can
clone, install and run — at a quality level comparable to the best-run projects
on GitHub.

Three independent workstreams were identified. They are tracked separately
because each has its own risk profile and its own definition of done:

| ID | Workstream | Status |
|----|-----------|--------|
| **A** | Repository foundation — structure, governance, docs, tooling, CI, demo mode | In execution |
| **B** | Full migration to English — UI, comments, logs, AI prompts | Not started |
| **C** | Attachment support — design only, not implemented | Research in progress |

---

## 2. Decisions taken

| Question | Decision | Rationale |
|----------|----------|-----------|
| Repository name | `mail-workflow` | Matches README and CLAUDE.md. Also fixes `package.json` still being named `mailprojetjul` |
| Visibility | **Private** until v1.0.0 | An English README over a French UI destroys the credibility the release is meant to build |
| Documentation language | English only | Maximum reach |
| UI language | English — **direct replacement, no i18n layer** | Simplest to maintain. Accepted cost: the French UI is retired, and reintroducing it later means paying for string extraction again |
| Attachments | Full design spec, **not implemented** | The decision to build it comes after the spec, not before |
| Install experience | Step-by-step OAuth guides + one-command bootstrap | The two real friction points |
| Docker | **Explicit non-goal** | The app requires Chrome/Edge client-side and a writable local folder either way; containerising the Express server removes neither friction |

---

## 3. Sequencing

Three ordering constraints are non-negotiable:

1. **`git init` and the baseline commit come first.** Without a baseline, no
   parallel work is diffable or revertible.
2. **Formatting (Prettier) lands before the English migration.** Otherwise a
   30-file translation and a reformat land in the same diff and nobody can
   review it.
3. **The terminology glossary is written before the translation fan-out.**
   Without it, ten agents render "sujet" as *subject*, *topic* and *thread* in
   ten different files.

And one dependency that is easy to miss: **README screenshots depend on
workstream B.** Illustrating an English README with a French UI defeats the
purpose. The README is therefore *structured* in wave 1 and *illustrated* in
wave 4.

### Wave 0 — sequential (done)

`git init`, secret audit, baseline commit `48bba75`, remote configured.
Baseline test suite verified green: **10 suites, 146 tests**.

Two things fixed before the first commit:
- Added `.gitattributes` — without it a Windows-authored repository ships CRLF
  and every Linux/macOS contributor sees whole files as modified.
- Identified `src/public/js/package.json` (`{"type":"module"}`) as load-bearing:
  it marks the front-end `.js` files as ES modules for Node and Jest resolution.
  It looks like junk and must be documented so nobody deletes it.

### Wave 1 — 7 parallel lanes, partitioned by exclusive file ownership

| Lane | Deliverable | Model |
|------|-------------|-------|
| A1 | `package.json` fixes, `.editorconfig`, `.nvmrc`, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CHANGELOG, issue/PR templates | Sonnet 5 |
| A2 | `docs/setup/google-cloud.md`, `docs/setup/azure-ad.md` | Sonnet 5 + live docs |
| A3 | `scripts/setup.js`, `scripts/doctor.js` | Opus 5 |
| A4 | `eslint.config.js`, `.prettierrc`, `.prettierignore` | Sonnet 5 |
| A5 | CI hardening, CodeQL, Dependabot | Opus 5 |
| A8 | Demo mode (see section 5) | Opus 5 |
| C1 | `docs/design/attachments-research.md` | Sonnet 5 + Context7 |

**Ownership rule:** each lane owns its files exclusively. The single contended
file, `package.json`, belongs to A1 alone; A3, A4 and A8 declare what they need
and A1 writes it. Without this rule, seven parallel agents produce seven
conflicts.

### Wave 2 — depends on wave 1

- **A6** — restructure `docs/`: separate user guides from internal notes, add
  `DATA_FORMAT.md` and `ROADMAP.md`
- **A7** — README v2 (structure only, no images yet)
- **C2** — `docs/design/attachments.md`, the full design built on C1's research

### Wave 3 — the English migration

- **B0** — glossary (`docs/internal/glossary.md`), sequential, blocking
- **B1…B12** — fan-out by file, partitioned by owner, on separate git worktrees:
  - mechanical comment/log files → Haiku 4.5
  - user-visible string files → Sonnet 5
  - risk zones (AI prompts, `treeRenderer.js`, legal pages) → Opus 5
- **B-final** — coherence sweep, `npm test`, `npm run lint`

Measured scope: ~250–400 user-visible strings, ~600 French comments and log
lines across 36 files.

**The AI prompts are the risk zone.** Translating a prompt changes model
behaviour, and `tests/backend/aiFilterPrompts.test.js` asserts against their
content. They are handled last, by the strongest model, with the test updated
deliberately rather than mechanically.

### Wave 4 — release

Screenshots of the English UI, README illustration, `v1.0.0` tag, GitHub
Release, switch to Public.

---

## 4. Installation experience

The install splits into two halves of very different nature, and only one is
compressible:

- **Technical** — clone, install, run: reduced to two commands.
- **OAuth provider** — creating a Google Cloud project or an Azure AD app:
  ~15 minutes, and **no script can automate it**. Reading mail uses Google
  *restricted* scopes; nobody can create that project on the user's behalf, nor
  distribute their own client secret.

A weak repository hides that cost behind an optimistic `npm install` and lets
the user fail on `invalid_client`. This one states it, quantifies it, and makes
everything else flawless.

### Three entry levels

**Level 1 — Discovery, 30 seconds, no OAuth**

```bash
git clone https://github.com/vincamor/mail-workflow.git
cd mail-workflow && npm install && npm run demo
```

**Level 2 — Real use, ~20 minutes**

```bash
npm run setup     # interactive wizard
npm start         # http://localhost:3000
```

`npm run setup` displays the exact redirect URI to paste (the number-one cause
of OAuth failure), never overwrites an existing `.env` without a backup, and is
skippable for contributors who prefer copying `.env.example` by hand.

**Level 3 — Self-hosting** — Railway, unchanged.

### Safety net — `npm run doctor`

Non-interactive, side-effect free, designed to be pasted into a bug report. Its
highest-value check is consistency: does `GMAIL_REDIRECT_URI` actually match the
`PORT` and `APP_ORIGIN` the server will listen on. Every failure prints the
remedy, not just the symptom.

### Deliberate non-goals

- **No Docker** — see section 2.
- **No interactive `postinstall`** — it breaks `npm ci`, CI, and unattended
  installs. `npm start` detects a missing `.env` and points at `npm run setup`.
- **No global installer (`npx mail-workflow`)** — the project is meant to be
  cloned and modified (filters, themes, prompts). Publishing to npm would imply
  a frozen tool it is not.

---

## 5. Demo mode

### The insertion point is unique

Every data read goes through `fileHandle.getFile()` then `file.stream()`
(`emailAnalyzer_browser.js:62`, `folders.js:75`, `analysis.js:932`), and every
caller obtains that handle from one function: `getEmailFileHandle()`
(`folders.js:29`).

A `Blob` from `fetch()` exposes the same read interface as a `File` from the
File System Access API. Demo mode therefore duck-types a fake handle:

```js
async function fileHandleFromUrl(url, name) {
  const blob = await (await fetch(url)).blob();
  return { getFile: async () => new File([blob], name) };
}
```

The graft is **two early returns** — `folders.js:29` and `emails.js:1192`. Zero
changes in `emailAnalyzer_browser.js`, `analysis.js`, `treeRenderer.js` or
`email-detail.js`. The tree-rendering invariants are never approached.

### Unplanned benefit: the demo runs on Firefox and Safari

`app.js:41` blocks any browser lacking `showDirectoryPicker` — Firefox, Safari
and all mobile. Demo mode does not need that API, so moving the check behind the
demo test makes the demonstration link shareable on any browser. For a repository
whose README says "Chrome/Edge only", this is what stops a visitor on a Mac from
leaving without seeing anything.

### Scope

| Feature | In demo |
|---------|---------|
| Conversation tree, zoom, pan, timelines | Yes |
| Subject list, filters, search, groups | Yes |
| Email detail, rich HTML, quote toggle | Yes |
| Themes | Yes |
| Download, sync, delete, reply | **Hidden** — a dead button is worse than an absent one |
| AI assistant | **Disabled** — `/api/ai/*` requires an authenticated session, so it would 401 |
| IndexedDB, folder handles | **Never written** |

### The dataset is fabricated, not anonymised

Anonymising real mail is a trap: leaks hide in nested quotes, signatures,
`References` headers and tracking URLs. Such an incident on a project that sells
itself as privacy-first would be fatal to its credibility. The fixture is
generated from scratch: ~60 emails, 8 subjects, ~250 KB, including one flagship
5-participant thread with diverging branches (this becomes the README
screenshot), two emails flagged `hasAttachments`, a newsletter, and one rich-HTML
email with a quoted reply.

### Zero configuration

`npm run demo` runs `scripts/demo.js`, which forces `NODE_ENV=development` before
loading `src/app.js`. This matters because `app.js:5` exits unless
`SESSION_SECRET` is set or the environment is development — so **the demo runs
with no `.env` at all**. The detour through a Node launcher rather than an inline
`NODE_ENV=x node ...` is deliberate: the inline form fails on PowerShell and
`cmd`, and the usual remedy, `cross-env`, has no place in a project that claims
no build step.

### The real risk is drift, not complexity

A demo mode silently desynchronises from the product; a feature added six months
later breaks it and nobody notices until a visitor reports it. The countermeasure
is a CI test that loads the fixture through the **real** analysis path and fails
if the graph no longer builds. Without that test the demo is a liability, and it
would not be worth adding.

**Non-risk:** `?demo=1` stays reachable on a deployed instance. That is intended
— the data is fictional and public, and it provides a live demo URL.

---

## 6. Bugs found during the release work

Preparing the repository surfaced real defects in the application. None are
fixed here — each needs its own change and its own review. They become GitHub
issues once the repository is pushed.

### 6.1 `OUTLOOK_TENANT_ID` has no effect

`.env.example` documents `OUTLOOK_TENANT_ID`, and `src/config/oauth.js:10` reads
it. It is used to build the MSAL authority at `outlookService.js:26`, but the
resulting `ConfidentialClientApplication` (`pca`, line 31) is **never used
again** — it is the only occurrence in the file. All three real OAuth calls
hard-code `/common/`:

- `outlookService.js:52` — token refresh
- `outlookService.js:560` — authorize redirect
- `outlookService.js:580` — token exchange

Consequence: a user with a single-tenant Entra registration who sets
`OUTLOOK_TENANT_ID` to their tenant GUID is still sent to `/common/`, and
sign-in fails with no indication why. The real gate is the "Supported account
types" setting in the app registration.

Two possible fixes: honour the variable in the three endpoints, or remove it
from `.env.example` and drop the unused `@azure/msal-node` dependency along with
it. The first is the better behaviour; the second is the smaller surface.

### 6.2 A front-end test duplicates the code it claims to test

`tests/frontend/progressiveLoading.test.js` does not import
`src/services/emailAnalyzer_browser.js`. It **inlines a copy of that module's
functions**, with a comment stating the ES module cannot be required directly in
Jest.

Consequence: this test can stay green while the real analyzer is broken. Since
`emailAnalyzer_browser.js` produces the `{nodes, links}` shape the whole
visualisation depends on, this is the least covered critical path in the
project, despite appearances.

The demo mode's regression test (wave 1, lane A8) loads the fixture through the
real module, which is the first genuine coverage of that path — and it will
prove whether the "cannot be required in Jest" premise still holds under the
project's `--experimental-vm-modules` setup.

---

## 7. Where the work stopped — 2026-08-25

**Wave 0 and wave 1 are complete.** 16 commits on `main`. Three indicators green
at once: 11 suites / 159 tests, `npm run lint` clean, `npm audit` at 0
vulnerabilities (down from 11, of which 7 high).

**Nothing has been pushed.** The remote `https://github.com/vincamor/mail-workflow.git`
is configured but still empty. The repository was created **private**, per the
approach-A decision to publish at v1.0.0. The first push is
`git push -u origin main` and needs an explicit go-ahead.

### Delivered in wave 1

| Commit | Lane |
|--------|------|
| `48bba75` | Initial import, `.gitattributes`, secret audit |
| `f02a221` | Governance files, package metadata fixed |
| `9609ef0` | ESLint flat config + Prettier |
| `7e367b4`, `b2c2b38` | This spec |
| `5150f49` | Google Cloud and Azure AD setup guides |
| `c5d7ac3` | CI hardening, CodeQL, Dependabot |
| `6412d8e` | Attachments API research |
| `b50bcfe` | `npm run setup` and `npm run doctor` |
| `accbce9` | Demo mode |
| `0f31c5b`, `f376a76`, `b9854cf` | Three application bug fixes |
| `2c5f84f`, `32e023e` | `@azure/msal-node` dropped, all advisories resolved |
| `b303fe5` | Clean lint baseline, dead code removed |

Four latent bugs were found and fixed along the way; they are described in
section 6, which also still lists the one **not** fixed (the front-end test that
duplicates the code it claims to test).

### Next session — in this order

1. **Decide on the first push.** Everything below assumes it has happened, since
   the bug reports in section 6 should become GitHub issues.
2. **Wave 2**, three parallel lanes: A6 restructure `docs/` (separate user guides
   from internal notes, add `DATA_FORMAT.md` and `ROADMAP.md`), A7 README v2
   without images, C2 the full attachments design built on `docs/design/attachments-research.md`.
3. **Run Prettier once, as its own commit.** This must land before wave 3.
   Mixing a reformat with a 36-file translation produces an unreviewable diff.
4. **Wave 3**, the English migration. B0 (the glossary) blocks the fan-out and
   is not written yet. Scope measured: ~250-400 user-visible strings, ~600 French
   comments and log lines across 36 files. The AI prompts are the risk zone —
   translating them changes model behaviour and
   `tests/backend/aiFilterPrompts.test.js` asserts on their content.
5. **Wave 4**, release: screenshots of the English UI, README illustration,
   `v1.0.0`, switch to public.

### Two latent issues noticed but deliberately left alone

`loadEmailsFromHandle(fileHandle, _chunkSize)` and
`createCompleteVisualization(tree, _options)` both have call sites passing real
values for parameters the body never reads. Callers believe they are configuring
something that is ignored. Not fixed: doing so would change runtime behaviour and
belongs in its own reviewed change.
